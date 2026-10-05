import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  shapedEnvelope,
  sql,
  superuser,
  users,
} from "./support";

// LB-13 (ADR-006): the recoverable form of a guest link at the database
// layer — private storage, privileges, create/rotate atomicity and the
// member-only recovery read. Exercised as real anon/authenticated users
// through the Data API; the superuser connection only arranges fixtures
// (e.g. a pre-LB-13 hash-only party) and reads ground truth. Envelopes here
// are v1-SHAPED random bytes: the database can't (and doesn't) decrypt.

const CHECK_VIOLATION = "23514";
const SECRETS = "private.guest_invitation_capability_secrets";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

type Party = { id: string; token: string; hash: string; envelope: string };

async function createParty(actor: TestUserKey, weddingId: string, label: string): Promise<Party> {
  const { token, hash } = newToken();
  const envelope = shapedEnvelope();
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: envelope,
    guest_names: ["Invitada"],
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, token, hash, envelope };
}

function rotate(actor: keyof typeof as, weddingId: string, partyId: string, hash: string, envelope: string) {
  return as[actor].rpc("rotate_guest_invitation_link", {
    target_wedding_id: weddingId,
    target_invitation_id: partyId,
    invitation_token_hash: hash,
    invitation_token_ciphertext: envelope,
  });
}

function recover(actor: keyof typeof as, weddingId: string, partyId: string) {
  return as[actor].rpc("get_guest_invitation_recovery_envelope", {
    target_wedding_id: weddingId,
    target_invitation_id: partyId,
  });
}

type SecretRow = { guest_invitation_id: string; wedding_id: string; token_hash: string; token_ciphertext: string };

async function secretsOf(partyId: string): Promise<SecretRow[]> {
  return sql<SecretRow>(
    `select guest_invitation_id, wedding_id, token_hash, token_ciphertext from ${SECRETS}
     where guest_invitation_id = $1`,
    [partyId],
  );
}

async function linkOf(partyId: string) {
  const rows = await sql<{ token_hash: string; token_issued_at: Date; revoked_at: Date | null }>(
    "select token_hash, token_issued_at, revoked_at from public.guest_invitations where id = $1",
    [partyId],
  );
  return rows[0];
}

/** Fixture: the state of a party created before LB-13 (hash only, no envelope). */
async function makeLegacy(partyId: string) {
  await sql(`delete from ${SECRETS} where guest_invitation_id = $1`, [partyId]);
}

async function guestSees(hash: string): Promise<number> {
  const { data } = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: hash });
  return data?.length ?? 0;
}

/** Runs `statement` as a client role directly in Postgres (privilege checks only). */
async function asRole(role: "anon" | "authenticated", statement: string): Promise<unknown> {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    return await client.query(statement);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda enlace recuperable A");
  weddingB = await fixtureWedding("ownerB", "Boda enlace recuperable B");
  await addMember(weddingA, "collabA", "collaborator");
});

// ---------------------------------------------------------------- storage

describe("capability secret storage", () => {
  it("lives in `private`, with RLS on and no client privileges at all", async () => {
    const tables = await sql<{ schema: string; rls: boolean }>(
      `select n.nspname as schema, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relname = 'guest_invitation_capability_secrets'`,
    );
    expect(tables).toEqual([{ schema: "private", rls: true }]);
    const grants = await sql(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'private' and table_name = 'guest_invitation_capability_secrets'
         and grantee in ('PUBLIC', 'anon', 'authenticated')
       union all
       select grantee, privilege_type from information_schema.column_privileges
       where table_schema = 'private' and table_name = 'guest_invitation_capability_secrets'
         and grantee in ('PUBLIC', 'anon', 'authenticated')`,
    );
    expect(grants).toEqual([]);
    const columns = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'private' and table_name = 'guest_invitation_capability_secrets'
       order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "guest_invitation_id",
      "wedding_id",
      "token_hash",
      "token_ciphertext",
      "created_at",
      "updated_at",
    ]);
  });

  it("a new party stores exactly one envelope, bound to its hash; never the plaintext", async () => {
    const party = await createParty("collabA", weddingA, "Nueva");
    const rows = await secretsOf(party.id);
    expect(rows).toEqual([
      { guest_invitation_id: party.id, wedding_id: weddingA, token_hash: party.hash, token_ciphertext: party.envelope },
    ]);
    const dump = JSON.stringify(
      await sql(`select * from ${SECRETS} s join public.guest_invitations i on i.id = s.guest_invitation_id
                 where s.guest_invitation_id = $1`, [party.id]),
    );
    expect(dump).not.toContain(party.token);
  });

  it("one envelope per party (primary key)", async () => {
    const party = await createParty("ownerA", weddingA, "Una sola");
    await expect(
      sql(
        `insert into ${SECRETS} (guest_invitation_id, wedding_id, token_hash, token_ciphertext)
         values ($1, $2, $3, $4)`,
        [party.id, weddingA, party.hash, shapedEnvelope()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the envelope must be the bounded v1 shape: plaintext, other versions and junk are refused", async () => {
    const party = await createParty("ownerA", weddingA, "Forma");
    const [, iv, ct, tag] = party.envelope.split(".") as [string, string, string, string];
    for (const bad of [
      party.token, // the plaintext token itself
      `v2.${iv}.${ct}.${tag}`,
      `v1.${iv}.${ct}`,
      `v1.${iv}.${ct}.${tag}.x`,
      `v1.${iv}.${ct}x.${tag}`,
      `v1.${iv}.${ct.slice(1)}+.${tag}`,
      `v1.${iv}.${"A".repeat(500)}.${tag}`,
      "",
    ]) {
      await expect(
        sql(`update ${SECRETS} set token_ciphertext = $2 where guest_invitation_id = $1`, [party.id, bad]),
        JSON.stringify(bad.slice(0, 20)),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it("deleting the party (or its wedding) deletes its envelope", async () => {
    const party = await createParty("ownerA", weddingA, "Borrable");
    const deleted = await as.ownerA.from("guest_invitations").delete().eq("id", party.id).select("id");
    expect(deleted.data).toHaveLength(1);
    expect(await secretsOf(party.id)).toEqual([]);

    const wedding = await fixtureWedding("ownerA", "Boda borrable");
    const other = await createParty("ownerA", wedding, "Con boda");
    await sql("delete from public.weddings where id = $1", [wedding]);
    expect(await secretsOf(other.id)).toEqual([]);
  });

  it("a hash-only (pre-LB-13) party stays valid for guests", async () => {
    const party = await createParty("ownerA", weddingA, "Antigua");
    await makeLegacy(party.id);
    expect(await secretsOf(party.id)).toEqual([]);
    expect(await guestSees(party.hash)).toBe(1);
    const guestId = (await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [party.id]))[0]!.id;
    const answer = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: party.hash,
      responses: [{ guest_id: guestId, attending: true }],
    });
    expect(answer.error).toBeNull();
  });
});

// ---------------------------------------------------------------- privacy

describe("capability secret privacy", () => {
  it("anon and authenticated can't read or write the table, even in SQL", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const statement of [
        `select * from ${SECRETS}`,
        `select token_ciphertext from ${SECRETS}`,
        `delete from ${SECRETS}`,
        `update ${SECRETS} set token_ciphertext = token_ciphertext`,
      ]) {
        await expect(asRole(role, statement), `${role}: ${statement}`).rejects.toMatchObject({
          code: PERMISSION_DENIED,
        });
      }
    }
  });

  it("isn't reachable through the Data API", async () => {
    await createParty("ownerA", weddingA, "Sin API");
    for (const actor of ["anon", "ownerA", "collabA"] as const) {
      const { data, error } = await as[actor].schema("private" as "public").from("guest_invitation_capability_secrets" as "guests").select("*");
      expect(error, actor).not.toBeNull();
      expect(data, actor).toBeNull();
    }
  });

  it("there is no standalone writer: only the create and rotate RPCs touch envelopes", async () => {
    // Every function whose body mentions the table, and who may execute it.
    const writers = await sql<{ name: string; definer: boolean; anon: boolean; authenticated: boolean }>(
      `select n.nspname || '.' || p.proname as name, p.prosecdef as definer,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosrc ilike '%guest_invitation_capability_secrets%'
       order by 1`,
    );
    expect(writers).toEqual([
      // Trigger-only (no client may call it); it reads, never writes.
      { name: "private.enforce_guest_invitation_capability_secret", definer: true, anon: false, authenticated: false },
      { name: "public.create_guest_invitation", definer: true, anon: false, authenticated: true },
      { name: "public.get_guest_invitation_recovery_envelope", definer: true, anon: false, authenticated: true },
      { name: "public.rotate_guest_invitation_link", definer: true, anon: false, authenticated: true },
    ]);
    expect(await sql("select 1 from pg_proc where proname = 'store_guest_invitation_capability_secret'")).toEqual([]);
    // In `private`, clients can execute only the two RLS helpers.
    const privateCallable = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p
       where p.pronamespace = 'private'::regnamespace
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))
       order by 1`,
    );
    expect(privateCallable.map((r) => r.name)).toEqual(["has_wedding_role", "is_wedding_member"]);
  });

  it("creating (and so writing an envelope) is members-only, scoped to the target wedding", async () => {
    for (const actor of ["outsider", "ownerB", "anon"] as const) {
      const { hash } = newToken();
      const { error } = await as[actor].rpc("create_guest_invitation", {
        target_wedding_id: weddingA,
        party_label: "Intrusa",
        invitation_token_hash: hash,
        invitation_token_ciphertext: shapedEnvelope(),
        guest_names: ["Nadie"],
      });
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
      expect(await sql("select 1 from public.guest_invitations where token_hash = $1", [hash]), actor).toEqual([]);
      expect(await sql(`select 1 from ${SECRETS} where token_hash = $1`, [hash]), actor).toEqual([]);
    }
    // Members create in their wedding, recorded as themselves; the envelope
    // lands in that same wedding.
    const party = await createParty("collabA", weddingA, "Colaboradora");
    const rows = await sql<{ created_by: string; wedding_id: string }>(
      "select created_by, wedding_id from public.guest_invitations where id = $1",
      [party.id],
    );
    expect(rows).toEqual([{ created_by: users.collabA.id, wedding_id: weddingA }]);
    expect((await secretsOf(party.id))[0]?.wedding_id).toBe(weddingA);
  });

  it("an existing party's envelope can't be replaced except by an owner's rotation", async () => {
    const party = await createParty("ownerA", weddingA, "Intocable");
    // Reusing its hash to "create" again fails (unique hash); nothing moves.
    const dup = await as.collabA.rpc("create_guest_invitation", {
      target_wedding_id: weddingA,
      party_label: "Copia",
      invitation_token_hash: party.hash,
      invitation_token_ciphertext: shapedEnvelope(),
      guest_names: ["Copia"],
    });
    expect(dup.error?.code).toBe("23505");
    // A collaborator's rotation is refused; another wedding's owner gets false.
    expect((await rotate("collabA", weddingA, party.id, newToken().hash, shapedEnvelope())).error?.message).toBe(
      "guest_link_owner_only",
    );
    expect((await rotate("ownerB", weddingB, party.id, newToken().hash, shapedEnvelope())).data).toBe(false);
    expect(await secretsOf(party.id)).toEqual([
      { guest_invitation_id: party.id, wedding_id: weddingA, token_hash: party.hash, token_ciphertext: party.envelope },
    ]);
  });

  it("no ordinary surface returns the envelope or the hash", async () => {
    const party = await createParty("ownerA", weddingA, "Discreta");
    // The guest list as members read it: every readable column (`*` is
    // refused outright, since token_hash has no column grant).
    const readable =
      "id, wedding_id, label, token_issued_at, revoked_at, created_by, created_at, updated_at, contact_email, invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id, rsvp_confirmation_email_sent_at, rsvp_confirmation_email_sent_to, rsvp_confirmation_email_provider_id";
    expect((await as.ownerA.from("guest_invitations").select("*").eq("id", party.id)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    const list = await as.ownerA.from("guest_invitations").select(readable).eq("id", party.id);
    expect(list.error).toBeNull();
    expect(list.data).toHaveLength(1);
    const nested = await as.collabA
      .from("guest_invitations")
      .select(`${readable}, guests(*, rsvps(*))`)
      .eq("wedding_id", weddingA);
    expect(nested.error).toBeNull();
    // Guest functions.
    const guest = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    const slug = await as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: party.hash });
    // The public site function (nothing published here: no row, still no leak).
    const site = await as.anon.rpc("get_published_wedding_site", { site_slug: "no-existe-recuperable" });
    for (const [name, result] of Object.entries({ list, nested, guest, slug, site })) {
      const text = JSON.stringify(result.data ?? null);
      expect(text, name).not.toContain(party.envelope);
      expect(text, name).not.toContain(party.hash);
      expect(text, name).not.toContain(party.token);
      expect(text, name).not.toContain("token_ciphertext");
    }
  });
});

// --------------------------------------------------------------- atomicity

describe("hash + envelope atomicity", () => {
  it("creation with a malformed envelope creates nothing at all", async () => {
    for (const envelope of ["no-es-un-sobre", newToken().token, ""]) {
      const { hash } = newToken();
      const { error } = await as.ownerA.rpc("create_guest_invitation", {
        target_wedding_id: weddingA,
        party_label: "Atómica",
        invitation_token_hash: hash,
        invitation_token_ciphertext: envelope,
        guest_names: ["Nadie"],
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
      expect(await sql("select 1 from public.guest_invitations where token_hash = $1", [hash])).toEqual([]);
      expect(await sql(`select 1 from ${SECRETS} where token_hash = $1`, [hash])).toEqual([]);
    }
    expect(await sql("select 1 from public.guests g join public.guest_invitations i on i.id = g.guest_invitation_id where i.label = 'Atómica'")).toEqual([]);
  });

  it("a failed rotation (bad envelope) leaves the old link, its metadata and its envelope current", async () => {
    const party = await createParty("ownerA", weddingA, "Rotación fallida");
    const before = await linkOf(party.id);
    const next = newToken();
    const result = await rotate("ownerA", weddingA, party.id, next.hash, "v1.roto");
    expect(result.error?.code).toBe(CHECK_VIOLATION);

    expect(await linkOf(party.id)).toEqual(before);
    expect((await secretsOf(party.id))[0]).toMatchObject({ token_hash: party.hash, token_ciphertext: party.envelope });
    expect(await guestSees(party.hash)).toBe(1);
    expect(await guestSees(next.hash)).toBe(0);
  });

  it("a successful rotation replaces hash and envelope together", async () => {
    const party = await createParty("ownerA", weddingA, "Rotación");
    const next = newToken();
    const envelope = shapedEnvelope();
    const result = await rotate("ownerA", weddingA, party.id, next.hash, envelope);
    expect(result).toMatchObject({ error: null, data: true });
    expect((await linkOf(party.id))?.token_hash).toBe(next.hash);
    expect(await secretsOf(party.id)).toEqual([
      { guest_invitation_id: party.id, wedding_id: weddingA, token_hash: next.hash, token_ciphertext: envelope },
    ]);
    expect(await guestSees(party.hash)).toBe(0);
    expect(await guestSees(next.hash)).toBe(1);
  });

  it("no role can make a hash current without its envelope: a hash-only rotation never commits", async () => {
    const party = await createParty("ownerA", weddingA, "Solo hash");
    const before = await linkOf(party.id);
    // Clients: the plain UPDATE door is closed.
    const direct = await as.ownerA
      .from("guest_invitations")
      .update({ token_hash: newToken().hash })
      .eq("id", party.id)
      .select("id");
    expect(direct.error?.code).toBe(PERMISSION_DENIED);
    // Even a privileged write is refused at commit (deferred constraint trigger).
    await expect(
      sql("update public.guest_invitations set token_hash = $2 where id = $1", [party.id, newToken().hash]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: "guest_invitation_capability_secret_required" });
    // ...including a legacy party's (it becomes recoverable only through a real rotation).
    const legacy = await createParty("ownerA", weddingA, "Solo hash antigua");
    await makeLegacy(legacy.id);
    await expect(
      sql("update public.guest_invitations set token_hash = $2 where id = $1", [legacy.id, newToken().hash]),
    ).rejects.toMatchObject({ message: "guest_invitation_capability_secret_required" });
    // An envelope bound to another hash doesn't count either.
    const client = await superuser.connect();
    try {
      await client.query("begin");
      const other = newToken();
      await client.query("update public.guest_invitations set token_hash = $2 where id = $1", [party.id, other.hash]);
      await client.query(`update ${SECRETS} set token_hash = $2 where guest_invitation_id = $1`, [party.id, newToken().hash]);
      await expect(client.query("commit")).rejects.toMatchObject({
        message: "guest_invitation_capability_secret_required",
      });
    } finally {
      client.release();
    }
    expect(await linkOf(party.id)).toEqual(before);
    expect((await secretsOf(party.id))[0]?.token_hash).toBe(party.hash);
  });

  it("rotation stays owner-only; outsiders and other weddings change nothing", async () => {
    const party = await createParty("collabA", weddingA, "Dueños");
    const collab = await rotate("collabA", weddingA, party.id, newToken().hash, shapedEnvelope());
    expect(collab.error?.message).toBe("guest_link_owner_only");
    for (const actor of ["outsider", "ownerB"] as const) {
      const result = await rotate(actor, weddingA, party.id, newToken().hash, shapedEnvelope());
      expect(result.data ?? false, actor).toBe(false);
    }
    // A party of wedding A named under wedding B (its owner): nothing.
    expect((await rotate("ownerB", weddingB, party.id, newToken().hash, shapedEnvelope())).data).toBe(false);
    const anon = await rotate("anon", weddingA, party.id, newToken().hash, shapedEnvelope());
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
    expect((await linkOf(party.id))?.token_hash).toBe(party.hash);
    expect((await secretsOf(party.id))[0]?.token_ciphertext).toBe(party.envelope);
  });

  it("rotation reopens a revoked party with a NEW recoverable link", async () => {
    const party = await createParty("ownerA", weddingA, "Revocada y renovada");
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", party.id);
    // Revoking keeps the envelope (recovery refuses it anyway).
    expect((await secretsOf(party.id))[0]?.token_ciphertext).toBe(party.envelope);
    const next = newToken();
    const envelope = shapedEnvelope();
    expect((await rotate("ownerA", weddingA, party.id, next.hash, envelope)).data).toBe(true);
    expect((await linkOf(party.id))?.revoked_at).toBeNull();
    const { data } = await recover("ownerA", weddingA, party.id);
    expect(data).toEqual([{ link_state: "recoverable", token_hash: next.hash, token_ciphertext: envelope }]);
  });
});

// ---------------------------------------------------------- recovery read

describe("get_guest_invitation_recovery_envelope", () => {
  it("owners and collaborators get exactly the state, hash and envelope — nothing else", async () => {
    const party = await createParty("ownerA", weddingA, "Recuperable");
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await recover(actor, weddingA, party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([
        { link_state: "recoverable", token_hash: party.hash, token_ciphertext: party.envelope },
      ]);
      expect(Object.keys(data?.[0] ?? {}).sort()).toEqual(["link_state", "token_ciphertext", "token_hash"]);
    }
  });

  it("outsiders, other weddings and unknown parties get no row; anon can't call it", async () => {
    const party = await createParty("ownerA", weddingA, "Ajena");
    expect((await recover("outsider", weddingA, party.id)).data).toEqual([]);
    expect((await recover("ownerB", weddingA, party.id)).data).toEqual([]);
    expect((await recover("ownerB", weddingB, party.id)).data).toEqual([]);
    expect((await recover("ownerA", weddingB, party.id)).data).toEqual([]);
    expect((await recover("ownerA", weddingA, "00000000-0000-4000-8000-000000000000")).data).toEqual([]);
    expect((await recover("anon", weddingA, party.id)).error?.code).toBe(PERMISSION_DENIED);
  });

  it("a revoked link is `unavailable`, with no hash or envelope", async () => {
    const party = await createParty("ownerA", weddingA, "Revocada");
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", party.id);
    expect((await recover("collabA", weddingA, party.id)).data).toEqual([
      { link_state: "unavailable", token_hash: null, token_ciphertext: null },
    ]);
  });

  it("an expired link is `unavailable`, with no hash or envelope", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda pasada recuperable");
    const party = await createParty("ownerA", wedding, "Vencida");
    await sql("update public.weddings set wedding_date = '2000-01-01' where id = $1", [wedding]);
    expect((await recover("ownerA", wedding, party.id)).data).toEqual([
      { link_state: "unavailable", token_hash: null, token_ciphertext: null },
    ]);
    // Moving the wedding brings it back (expiry is derived, never stored).
    await sql("update public.weddings set wedding_date = '2090-01-01' where id = $1", [wedding]);
    expect((await recover("ownerA", wedding, party.id)).data?.[0]?.link_state).toBe("recoverable");
  });

  it("a hash-only (pre-LB-13) link is `legacy`, and its hash is NOT returned", async () => {
    const party = await createParty("ownerA", weddingA, "Legado");
    await makeLegacy(party.id);
    expect((await recover("ownerA", weddingA, party.id)).data).toEqual([
      { link_state: "legacy", token_hash: null, token_ciphertext: null },
    ]);
    // An owner's explicit rotation makes it recoverable; the old link dies.
    const next = newToken();
    const envelope = shapedEnvelope();
    expect((await rotate("ownerA", weddingA, party.id, next.hash, envelope)).data).toBe(true);
    expect((await recover("collabA", weddingA, party.id)).data).toEqual([
      { link_state: "recoverable", token_hash: next.hash, token_ciphertext: envelope },
    ]);
    expect(await guestSees(party.hash)).toBe(0);
  });

  it("after a rotation only the NEW envelope is returned", async () => {
    const party = await createParty("ownerA", weddingA, "Solo la nueva");
    const next = newToken();
    const envelope = shapedEnvelope();
    await rotate("ownerA", weddingA, party.id, next.hash, envelope);
    const { data } = await recover("ownerA", weddingA, party.id);
    expect(data).toEqual([{ link_state: "recoverable", token_hash: next.hash, token_ciphertext: envelope }]);
    expect(JSON.stringify(data)).not.toContain(party.envelope);
  });

  it("an envelope left bound to an older hash is never handed out", async () => {
    const party = await createParty("ownerA", weddingA, "Desfasada");
    // Simulate drift with a privileged fixture (no client path can do this).
    const client = await superuser.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(`update ${SECRETS} set token_hash = $2 where guest_invitation_id = $1`, [
        party.id,
        newToken().hash,
      ]);
      await client.query("commit");
    } finally {
      client.release();
    }
    expect((await recover("ownerA", weddingA, party.id)).data).toEqual([
      { link_state: "legacy", token_hash: null, token_ciphertext: null },
    ]);
  });
});
