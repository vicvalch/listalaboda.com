import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { guestLinkExpiresAt } from "@/lib/guests/link";
import type { Json } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  sql,
  superuser,
} from "./support";

// LB-09: GuestInvitation → Guest → RSVP, exercised as real anon and
// authenticated users through the Data API. The superuser connection only
// arranges fixtures (e.g. an expired link) and reads ground truth.

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** A fresh link token and its stored form, as the server would make them. */
function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

type Party = { id: string; hash: string; guestIds: string[] };

/** Creates a party through the organizer RPC as `actor`; returns ids in party order. */
async function createParty(
  actor: TestUserKey,
  weddingId: string,
  label: string,
  names: string[],
): Promise<Party> {
  const { hash } = newToken();
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    guest_names: names,
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  const rows = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at, id",
    [data],
  );
  return { id: data, hash, guestIds: rows.map((r) => r.id) };
}

function getParty(actor: keyof typeof as, hash: string) {
  return as[actor].rpc("get_guest_invitation", { invitation_token_hash: hash });
}

/** Deliberately loose: several tests send malformed payloads on purpose. */
function submit(actor: keyof typeof as, hash: string, responses: Json) {
  return as[actor].rpc("submit_guest_rsvp", { invitation_token_hash: hash, responses });
}

async function rsvpRows(guestIds: string[]) {
  return sql<{ guest_id: string; wedding_id: string; attending: boolean; dietary_note: string | null }>(
    `select guest_id, wedding_id, attending, dietary_note from public.rsvps
     where guest_id = any($1::uuid[]) order by guest_id`,
    [guestIds],
  );
}

/**
 * Fixture: pretends the current link was issued `days` ago. The link guard
 * trigger pins token_issued_at (only a new token re-stamps it), so the
 * fixture skips triggers for this one statement.
 */
async function backdateLink(guestInvitationId: string, days: number) {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(
      "update public.guest_invitations set token_issued_at = now() - make_interval(days => $2) where id = $1",
      [guestInvitationId, days],
    );
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function setWeddingDate(weddingId: string, date: string | null) {
  await sql("update public.weddings set wedding_date = $2 where id = $1", [weddingId, date]);
}

// ---------------------------------------------------------------- schema

describe("guest list schema", () => {
  it("guests and RSVPs hold no account, contact or counter data (the party may hold one contact email)", async () => {
    const rows = await sql<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('guest_invitations', 'guests', 'rsvps')
       order by table_name, ordinal_position`,
    );
    const columns = (table: string) =>
      rows.filter((r) => r.table_name === table).map((r) => r.column_name);
    expect(columns("guest_invitations")).toEqual([
      "id",
      "wedding_id",
      "label",
      "token_hash",
      "token_issued_at",
      "revoked_at",
      "created_by",
      "created_at",
      "updated_at",
      // LB-11: the party's optional contact email and its latest send.
      "contact_email",
      "invitation_email_sent_at",
      "invitation_email_sent_to",
      "invitation_email_provider_id",
    ]);
    expect(columns("guests")).toEqual([
      "id",
      "wedding_id",
      "guest_invitation_id",
      "name",
      "created_at",
      "updated_at",
    ]);
    expect(columns("rsvps")).toEqual([
      "guest_id",
      "wedding_id",
      "attending",
      "dietary_note",
      "created_at",
      "updated_at",
    ]);
  });

  it("one RSVP per guest is the primary key", async () => {
    const rows = await sql<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.rsvps'::regclass and contype = 'p'`,
    );
    expect(rows).toEqual([{ def: "PRIMARY KEY (guest_id)" }]);
  });
});

// ------------------------------------------------- organizer access (RLS)

describe("organizer access", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda invitados A");
    weddingB = await fixtureWedding("ownerB", "Boda invitados B");
    await addMember(weddingA, "collabA", "collaborator");
  });

  it("owners and collaborators create parties with their first guests", async () => {
    const byOwner = await createParty("ownerA", weddingA, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
    const byCollab = await createParty("collabA", weddingA, "María", ["María"]);
    expect(byOwner.guestIds).toHaveLength(2);
    expect(byCollab.guestIds).toHaveLength(1);

    const names = await sql<{ name: string }>(
      "select name from public.guests where guest_invitation_id = $1 order by created_at, id",
      [byOwner.id],
    );
    // Party order is the order typed.
    expect(names.map((n) => n.name)).toEqual(["Ana Pérez", "Carlos Pérez"]);
    const stored = await sql<{ token_hash: string; created_by: string | null }>(
      "select token_hash, created_by from public.guest_invitations where id = $1",
      [byOwner.id],
    );
    expect(stored[0]?.token_hash).toBe(byOwner.hash);
  });

  it("an outsider, another wedding's owner and anon cannot create parties", async () => {
    for (const actor of ["outsider", "ownerB"] as const) {
      const { error } = await as[actor].rpc("create_guest_invitation", {
        target_wedding_id: weddingA,
        party_label: "Intrusos",
        invitation_token_hash: newToken().hash,
        guest_names: ["Nadie"],
      });
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
    }
    const anon = await as.anon.rpc("create_guest_invitation", {
      target_wedding_id: weddingA,
      party_label: "Intrusos",
      invitation_token_hash: newToken().hash,
      guest_names: ["Nadie"],
    });
    expect(anon.error).not.toBeNull();
    const rows = await sql("select 1 from public.guest_invitations where label = 'Intrusos'");
    expect(rows).toEqual([]);
  });

  it("members read the guest list with responses; outsiders and anon see nothing", async () => {
    const party = await createParty("ownerA", weddingA, "Lectura", ["Lía"]);
    await submit("anon", party.hash, [{ guest_id: party.guestIds[0], attending: true }]);

    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await as[actor]
        .from("guest_invitations")
        .select("id, label, guests(id, name, rsvps(attending))")
        .eq("id", party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([
        { id: party.id, label: "Lectura", guests: [{ id: party.guestIds[0], name: "Lía", rsvps: [{ attending: true }] }] },
      ]);
    }
    for (const actor of ["outsider", "ownerB", "anon"] as const) {
      for (const table of ["guest_invitations", "guests", "rsvps"] as const) {
        const { data } = await as[actor].from(table).select("wedding_id").eq("wedding_id", weddingA);
        expect(data ?? [], `${actor} ${table}`).toEqual([]);
      }
    }
  });

  it("the token hash is never readable or filterable through the API", async () => {
    const party = await createParty("ownerA", weddingA, "Hash", ["Hugo"]);
    const read = await as.ownerA.from("guest_invitations").select("token_hash").eq("id", party.id);
    expect(read.error?.code).toBe(PERMISSION_DENIED);
    const filtered = await as.ownerA
      .from("guest_invitations")
      .select("id")
      .eq("token_hash", party.hash);
    expect(filtered.error?.code).toBe(PERMISSION_DENIED);
    const star = await as.ownerA.from("guest_invitations").select("*").eq("id", party.id);
    expect(star.error?.code).toBe(PERMISSION_DENIED);
  });

  it("collaborators manage parties and guests like owners", async () => {
    const party = await createParty("ownerA", weddingA, "Colabora", ["Uno", "Dos"]);

    const renamed = await as.collabA
      .from("guest_invitations")
      .update({ label: "Colabora (editado)" })
      .eq("id", party.id)
      .select("id");
    expect(renamed.data).toHaveLength(1);

    const added = await as.collabA
      .from("guests")
      .insert({ wedding_id: weddingA, guest_invitation_id: party.id, name: "Tres" });
    expect(added.error).toBeNull();

    const guestRenamed = await as.collabA
      .from("guests")
      .update({ name: "Uno bis" })
      .eq("id", party.guestIds[0])
      .select("id");
    expect(guestRenamed.data).toHaveLength(1);

    const removed = await as.collabA.from("guests").delete().eq("id", party.guestIds[1]).select("id");
    expect(removed.error).toBeNull();
    expect(removed.data).toHaveLength(1);

    const deleted = await as.collabA.from("guest_invitations").delete().eq("id", party.id).select("id");
    expect(deleted.data).toHaveLength(1);
  });

  it("outsiders and other weddings' owners can't change or delete a party", async () => {
    const party = await createParty("ownerA", weddingA, "Protegido", ["Paz"]);
    for (const actor of ["outsider", "ownerB"] as const) {
      const updated = await as[actor]
        .from("guest_invitations")
        .update({ label: "Hackeado" })
        .eq("id", party.id)
        .select("id");
      expect(updated.data ?? [], actor).toEqual([]);
      const rotated = await as[actor]
        .from("guest_invitations")
        .update({ token_hash: newToken().hash })
        .eq("id", party.id)
        .select("id");
      expect(rotated.data ?? [], actor).toEqual([]);
      const deleted = await as[actor].from("guest_invitations").delete().eq("id", party.id).select("id");
      expect(deleted.data ?? [], actor).toEqual([]);
      const guestDeleted = await as[actor].from("guests").delete().eq("id", party.guestIds[0]).select("id");
      expect(guestDeleted.data ?? [], actor).toEqual([]);
      const guestAdded = await as[actor]
        .from("guests")
        .insert({ wedding_id: weddingA, guest_invitation_id: party.id, name: "Colado" });
      expect(guestAdded.error?.code, actor).toBe(PERMISSION_DENIED);
    }
    const rows = await sql<{ label: string; token_hash: string }>(
      "select label, token_hash from public.guest_invitations where id = $1",
      [party.id],
    );
    expect(rows).toEqual([{ label: "Protegido", token_hash: party.hash }]);
  });

  it("organizers read RSVPs but cannot write them directly", async () => {
    const party = await createParty("ownerA", weddingA, "Sin escribir", ["Sol"]);
    const insert = await as.ownerA
      .from("rsvps")
      .insert({ guest_id: party.guestIds[0], wedding_id: weddingA, attending: true });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);

    await submit("anon", party.hash, [{ guest_id: party.guestIds[0], attending: false }]);
    const update = await as.ownerA
      .from("rsvps")
      .update({ attending: true })
      .eq("guest_id", party.guestIds[0])
      .select("guest_id");
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await as.ownerA.from("rsvps").delete().eq("guest_id", party.guestIds[0]).select("guest_id");
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    expect((await rsvpRows(party.guestIds))[0]?.attending).toBe(false);
  });

  it("rows never move: wedding, party and link timestamps are not client-writable", async () => {
    const party = await createParty("ownerA", weddingA, "Fijo", ["Fede"]);
    const moveParty = await as.ownerA
      .from("guest_invitations")
      .update({ wedding_id: weddingB })
      .eq("id", party.id);
    expect(moveParty.error?.code).toBe(PERMISSION_DENIED);
    const restamp = await as.ownerA
      .from("guest_invitations")
      .update({ token_issued_at: "2000-01-01T00:00:00Z" })
      .eq("id", party.id);
    expect(restamp.error?.code).toBe(PERMISSION_DENIED);
    const other = await createParty("ownerA", weddingA, "Otro", ["Otra"]);
    const moveGuest = await as.ownerA
      .from("guests")
      .update({ guest_invitation_id: other.id })
      .eq("id", party.guestIds[0]);
    expect(moveGuest.error?.code).toBe(PERMISSION_DENIED);
  });
});

// ----------------------------------------------- same-wedding invariants

describe("same-wedding invariants", () => {
  let weddingA: string;
  let weddingB: string;
  let partyA: Party;
  let partyB: Party;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda FK A");
    weddingB = await fixtureWedding("ownerB", "Boda FK B");
    // ownerA belongs to both weddings, so RLS alone would allow both sides.
    await addMember(weddingB, "ownerA", "collaborator");
    partyA = await createParty("ownerA", weddingA, "Grupo A", ["Ana A"]);
    partyB = await createParty("ownerB", weddingB, "Grupo B", ["Beto B"]);
  });

  it("a guest can't join another wedding's party, even for a member of both", async () => {
    const { error } = await as.ownerA
      .from("guests")
      .insert({ wedding_id: weddingA, guest_invitation_id: partyB.id, name: "Cruzado" });
    expect(error?.code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("privileged writes can't cross weddings either", async () => {
    await expect(
      sql("insert into public.guests (wedding_id, guest_invitation_id, name) values ($1, $2, 'X')", [
        weddingA,
        partyB.id,
      ]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      sql("insert into public.rsvps (guest_id, wedding_id, attending) values ($1, $2, true)", [
        partyB.guestIds[0],
        weddingA,
      ]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      sql("update public.guests set wedding_id = $2 where id = $1", [partyA.guestIds[0], weddingB]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });
});

// ------------------------------------------------------ party invariants

describe("party invariants", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda grupos");
  });

  it("a party is never empty: creation needs a guest and the last guest stays", async () => {
    const empty = await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: wedding,
      party_label: "Vacío",
      invitation_token_hash: newToken().hash,
      guest_names: [],
    });
    expect(empty.error?.code).toBe(CHECK_VIOLATION);
    expect(empty.error?.message).toBe("guest_invitation_needs_guest");
    // A direct insert without guests fails at commit too.
    const direct = await as.ownerA
      .from("guest_invitations")
      .insert({ wedding_id: wedding, label: "Vacío directo", token_hash: newToken().hash });
    expect(direct.error?.message).toBe("guest_invitation_needs_guest");
    expect(await sql("select 1 from public.guest_invitations where label like 'Vacío%'")).toEqual([]);

    const party = await createParty("ownerA", wedding, "Solo", ["Única"]);
    const last = await as.ownerA.from("guests").delete().eq("id", party.guestIds[0]).select("id");
    expect(last.error?.message).toBe("guest_invitation_needs_guest");
    expect(await sql("select 1 from public.guests where id = $1", [party.guestIds[0]])).toHaveLength(1);
  });

  it("there is no fixed maximum party size", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `Invitado ${i + 1}`);
    const party = await createParty("ownerA", wedding, "Grande", names);
    expect(party.guestIds).toHaveLength(25);
    const extra = await as.ownerA
      .from("guests")
      .insert({ wedding_id: wedding, guest_invitation_id: party.id, name: "Invitado 26" });
    expect(extra.error).toBeNull();

    // The whole party answers at once, all 26.
    const { data, error } = await submit(
      "anon",
      party.hash,
      (await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [party.id])).map(
        (g) => ({ guest_id: g.id, attending: true }),
      ),
    );
    expect(error).toBeNull();
    expect(data).toHaveLength(26);
    // And no capacity trigger exists any more.
    expect(
      await sql("select 1 from pg_proc where proname = 'enforce_guest_invitation_capacity'"),
    ).toEqual([]);
  });

  it("labels and names are trimmed, nonblank, ≤ 120 chars, plain text; Unicode is fine", async () => {
    const ok = await createParty("ownerA", wedding, "Familia Núñez 💍", ["José Ñandú"]);
    expect(ok.guestIds).toHaveLength(1);
    for (const label of ["", "   ", " Espacio", "a".repeat(121), "Con\nsalto"]) {
      const { error } = await as.ownerA.rpc("create_guest_invitation", {
        target_wedding_id: wedding,
        party_label: label,
        invitation_token_hash: newToken().hash,
        guest_names: ["Alguien"],
      });
      expect(error?.code, JSON.stringify(label)).toBe(CHECK_VIOLATION);
    }
    for (const name of ["", " Ana", "a".repeat(121), "Tab\tname"]) {
      const { error } = await as.ownerA
        .from("guests")
        .insert({ wedding_id: wedding, guest_invitation_id: ok.id, name });
      expect(error?.code, JSON.stringify(name)).toBe(CHECK_VIOLATION);
    }
  });

  it("token hashes are lowercase SHA-256 hex and unique", async () => {
    const party = await createParty("ownerA", wedding, "Único", ["U"]);
    for (const hash of ["not-a-hash", party.hash.toUpperCase()]) {
      const { error } = await as.ownerA.rpc("create_guest_invitation", {
        target_wedding_id: wedding,
        party_label: "Hash malo",
        invitation_token_hash: hash,
        guest_names: ["H"],
      });
      expect(error?.code).toBe(CHECK_VIOLATION);
    }
    const dup = await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: wedding,
      party_label: "Duplicado",
      invitation_token_hash: party.hash,
      guest_names: ["D"],
    });
    expect(dup.error?.code).toBe("23505");
  });
});

// ----------------------------------------------- revocation and rotation

describe("link revocation and rotation", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda enlaces");
    await addMember(wedding, "collabA", "collaborator");
  });

  it("only owners replace or revoke a link; a collaborator's direct requests are refused", async () => {
    // A collaborator creates a party: its initial link works.
    const party = await createParty("collabA", wedding, "De colaboración", ["Clara"]);
    expect((await getParty("anon", party.hash)).data).toHaveLength(1);

    const rotate = await as.collabA
      .from("guest_invitations")
      .update({ token_hash: newToken().hash })
      .eq("id", party.id)
      .select("id");
    expect(rotate.error?.code).toBe(PERMISSION_DENIED);
    expect(rotate.error?.message).toBe("guest_link_owner_only");
    const revoke = await as.collabA
      .from("guest_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", party.id)
      .select("id");
    expect(revoke.error?.code).toBe(PERMISSION_DENIED);
    expect(revoke.error?.message).toBe("guest_link_owner_only");
    // Sneaking the hash in next to an allowed label change doesn't work either.
    const mixed = await as.collabA
      .from("guest_invitations")
      .update({ label: "Renombrado", token_hash: newToken().hash })
      .eq("id", party.id);
    expect(mixed.error?.message).toBe("guest_link_owner_only");

    const stored = await sql<{ label: string; token_hash: string; revoked_at: Date | null }>(
      "select label, token_hash, revoked_at from public.guest_invitations where id = $1",
      [party.id],
    );
    expect(stored).toEqual([{ label: "De colaboración", token_hash: party.hash, revoked_at: null }]);
    expect((await getParty("anon", party.hash)).data).toHaveLength(1);

    // Collaborators still edit the content.
    const renamed = await as.collabA
      .from("guest_invitations")
      .update({ label: "Renombrado" })
      .eq("id", party.id)
      .select("id");
    expect(renamed.error).toBeNull();
    expect(renamed.data).toHaveLength(1);

    // The owner can do both.
    const next = newToken();
    const ownerRotate = await as.ownerA
      .from("guest_invitations")
      .update({ token_hash: next.hash })
      .eq("id", party.id)
      .select("id");
    expect(ownerRotate.data).toHaveLength(1);
    const ownerRevoke = await as.ownerA
      .from("guest_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", party.id)
      .select("id");
    expect(ownerRevoke.data).toHaveLength(1);
    expect((await getParty("anon", next.hash)).data).toEqual([]);
  });

  it("revoking stamps the database clock and kills the link; data stays", async () => {
    const party = await createParty("ownerA", wedding, "Revocado", ["Rita"]);
    await submit("anon", party.hash, [{ guest_id: party.guestIds[0], attending: true }]);

    const { data } = await as.ownerA
      .from("guest_invitations")
      .update({ revoked_at: "2000-01-01T00:00:00Z" })
      .eq("id", party.id)
      .select("revoked_at");
    const revokedAt = new Date(data?.[0]?.revoked_at ?? 0).getTime();
    expect(Math.abs(revokedAt - Date.now())).toBeLessThan(60_000);

    expect((await getParty("anon", party.hash)).data).toEqual([]);
    const write = await submit("anon", party.hash, [{ guest_id: party.guestIds[0], attending: false }]);
    expect(write.error?.message).toBe("guest_invitation_unavailable");

    expect(await sql("select 1 from public.guests where id = $1", [party.guestIds[0]])).toHaveLength(1);
    expect((await rsvpRows(party.guestIds))[0]?.attending).toBe(true);
  });

  it("the issue time can't be moved without a new token, even by a privileged write", async () => {
    const party = await createParty("ownerA", wedding, "Fecha fija", ["Fermín"]);
    const before = await sql<{ token_issued_at: Date }>(
      "select token_issued_at from public.guest_invitations where id = $1",
      [party.id],
    );
    await sql(
      "update public.guest_invitations set token_issued_at = now() + interval '5 years' where id = $1",
      [party.id],
    );
    const after = await sql<{ token_issued_at: Date }>(
      "select token_issued_at from public.guest_invitations where id = $1",
      [party.id],
    );
    expect(after[0]?.token_issued_at.getTime()).toBe(before[0]?.token_issued_at.getTime());
  });

  it("a revoked link can't be reopened, only replaced", async () => {
    const party = await createParty("ownerA", wedding, "Sin reabrir", ["Raúl"]);
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", party.id);
    const reopen = await as.ownerA
      .from("guest_invitations")
      .update({ revoked_at: null })
      .eq("id", party.id);
    expect(reopen.error?.message).toBe("guest_invitation_revoked");
    expect((await getParty("anon", party.hash)).data).toEqual([]);
  });

  it("rotation replaces the hash: old link dead, new link works, guests and RSVPs kept", async () => {
    const party = await createParty("ownerA", wedding, "Rotado", ["Rosa", "Rubén"]);
    await submit("anon", party.hash, [
      { guest_id: party.guestIds[0], attending: true },
      { guest_id: party.guestIds[1], attending: false },
    ]);
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", party.id);
    await backdateLink(party.id, 10);

    const next = newToken();
    const rotated = await as.ownerA
      .from("guest_invitations")
      .update({ token_hash: next.hash })
      .eq("id", party.id)
      .select("id, revoked_at, token_issued_at");
    expect(rotated.error).toBeNull();
    expect(rotated.data?.[0]?.id).toBe(party.id);
    expect(rotated.data?.[0]?.revoked_at).toBeNull();
    expect(Date.now() - new Date(rotated.data?.[0]?.token_issued_at ?? 0).getTime()).toBeLessThan(60_000);

    expect((await getParty("anon", party.hash)).data).toEqual([]);
    const fresh = await getParty("anon", next.hash);
    expect(fresh.data?.map((row) => [row.guest_name, row.attending])).toEqual([
      ["Rosa", true],
      ["Rubén", false],
    ]);
  });
});

// --------------------------------------------------------- token reads

describe("guest token read (get_guest_invitation)", () => {
  let weddingA: string;
  let weddingB: string;
  let partyA: Party;
  let partyA2: Party;
  let partyB: Party;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda privada A");
    weddingB = await fixtureWedding("ownerB", "Boda privada B");
    partyA = await createParty("ownerA", weddingA, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
    partyA2 = await createParty("ownerA", weddingA, "Vecinos", ["Vera"]);
    partyB = await createParty("ownerB", weddingB, "Familia Gómez", ["Gina Gómez"]);
    await setWeddingDate(weddingA, "2090-06-01");
  });

  it("anon reads exactly its own party: label, guests, current responses", async () => {
    const { data, error } = await getParty("anon", partyA.hash);
    expect(error).toBeNull();
    expect(data).toEqual([
      { party_label: "Familia Pérez", guest_id: partyA.guestIds[0], guest_name: "Ana Pérez", attending: null, dietary_note: null },
      { party_label: "Familia Pérez", guest_id: partyA.guestIds[1], guest_name: "Carlos Pérez", attending: null, dietary_note: null },
    ]);
  });

  it("returns nothing about the wedding, its members, other parties or hashes", async () => {
    const { data } = await getParty("anon", partyA.hash);
    const text = JSON.stringify(data);
    for (const secret of [
      weddingA,
      weddingB,
      "Boda privada A",
      partyA.id,
      partyA.hash,
      partyA2.id,
      "Vecinos",
      "Vera",
      partyB.id,
      "Gómez",
      "owner-a@",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const keys = new Set((data ?? []).flatMap((row) => Object.keys(row)));
    expect([...keys].sort()).toEqual(["attending", "dietary_note", "guest_id", "guest_name", "party_label"]);
  });

  it("unknown hashes, malformed input and signed-in strangers get nothing", async () => {
    expect((await getParty("anon", newToken().hash)).data).toEqual([]);
    expect((await getParty("anon", "")).data).toEqual([]);
    expect((await getParty("anon", "' or 1=1 --")).data).toEqual([]);
    // A session adds nothing: only the token matters.
    expect((await getParty("ownerA", newToken().hash)).data).toEqual([]);
    expect((await getParty("outsider", partyA.hash)).data).toHaveLength(2);
  });

  it("expiry follows the CURRENT wedding date (30 days after) and the database clock", async () => {
    await setWeddingDate(weddingA, "2020-01-01");
    expect((await getParty("anon", partyA.hash)).data).toEqual([]);
    const write = await submit("anon", partyA.hash, partyA.guestIds.map((id) => ({ guest_id: id, attending: true })));
    expect(write.error?.message).toBe("guest_invitation_unavailable");

    // Moving the wedding later brings the same link back.
    await setWeddingDate(weddingA, "2090-06-01");
    expect((await getParty("anon", partyA.hash)).data).toHaveLength(2);
  });

  it("without a wedding date, a link lasts 365 days from issue", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda sin fecha");
    const party = await createParty("ownerA", wedding, "Sin fecha", ["Sara"]);
    await backdateLink(party.id, 364);
    expect((await getParty("anon", party.hash)).data).toHaveLength(1);
    await backdateLink(party.id, 366);
    expect((await getParty("anon", party.hash)).data).toEqual([]);
  });

  it("the database expiry matches the app's guestLinkExpiresAt", async () => {
    const cases: [string, string | null][] = [
      ["2026-10-02T12:34:56.000Z", "2027-08-14"],
      ["2026-10-02T12:34:56.000Z", "2028-02-29"],
      ["2026-10-02T12:34:56.000Z", null],
    ];
    for (const [issuedAt, weddingDate] of cases) {
      const rows = await sql<{ expires_at: Date }>(
        "select private.guest_invitation_expires_at($1::timestamptz, $2::date) as expires_at",
        [issuedAt, weddingDate],
      );
      expect(rows[0]?.expires_at.toISOString()).toBe(guestLinkExpiresAt(issuedAt, weddingDate).toISOString());
    }
  });

  it("a deleted party's link is unavailable", async () => {
    const party = await createParty("ownerA", weddingA, "Borrado", ["Bea"]);
    await as.ownerA.from("guest_invitations").delete().eq("id", party.id);
    expect((await getParty("anon", party.hash)).data).toEqual([]);
  });
});

// -------------------------------------------------------- token writes

describe("guest RSVP submission (submit_guest_rsvp)", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda respuestas A");
    weddingB = await fixtureWedding("ownerB", "Boda respuestas B");
  });

  it("a mixed party answer saves one row per guest, in the party's wedding", async () => {
    const party = await createParty("ownerA", weddingA, "Mixto", ["Ana", "Carlos", "Gabriel"]);
    const { data, error } = await submit("anon", party.hash, [
      { guest_id: party.guestIds[0], attending: true, dietary_note: "  vegetariana  " },
      { guest_id: party.guestIds[1], attending: false },
      { guest_id: party.guestIds[2], attending: true, dietary_note: "   " },
    ]);
    expect(error).toBeNull();
    expect(data?.map((row) => [row.guest_name, row.attending, row.dietary_note])).toEqual([
      ["Ana", true, "vegetariana"],
      ["Carlos", false, null],
      ["Gabriel", true, null],
    ]);
    const rows = await rsvpRows(party.guestIds);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.wedding_id))).toEqual(new Set([weddingA]));
  });

  it("resubmitting updates the same rows; repeats never duplicate", async () => {
    const party = await createParty("ownerA", weddingA, "Repetido", ["Ana", "Carlos"]);
    const first = [
      { guest_id: party.guestIds[0], attending: true },
      { guest_id: party.guestIds[1], attending: false },
    ];
    await submit("anon", party.hash, first);
    await submit("anon", party.hash, first);
    // Rapid double submit: concurrent calls serialize on the party row.
    const results = await Promise.all([submit("anon", party.hash, first), submit("anon", party.hash, first)]);
    for (const result of results) expect(result.error).toBeNull();
    expect(await rsvpRows(party.guestIds)).toHaveLength(2);

    const created = await sql<{ created_at: Date }>(
      "select created_at from public.rsvps where guest_id = $1",
      [party.guestIds[1]],
    );
    await submit("anon", party.hash, [
      { guest_id: party.guestIds[0], attending: true },
      { guest_id: party.guestIds[1], attending: true },
    ]);
    const after = await sql<{ attending: boolean; created_at: Date; updated_at: Date }>(
      "select attending, created_at, updated_at from public.rsvps where guest_id = $1",
      [party.guestIds[1]],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.attending).toBe(true);
    // Same row, updated in place.
    expect(after[0]?.created_at.getTime()).toBe(created[0]?.created_at.getTime());
    expect(await rsvpRows(party.guestIds)).toHaveLength(2);
  });

  it("a forged guest from another party or wedding fails the WHOLE submission", async () => {
    const party = await createParty("ownerA", weddingA, "Atómico", ["Ana", "Carlos"]);
    const sibling = await createParty("ownerA", weddingA, "Vecino", ["Víctor"]);
    const foreign = await createParty("ownerB", weddingB, "Ajeno", ["Ajeno"]);
    await submit("anon", party.hash, [
      { guest_id: party.guestIds[0], attending: true },
      { guest_id: party.guestIds[1], attending: true },
    ]);

    for (const forged of [sibling.guestIds[0], foreign.guestIds[0], randomUUID()]) {
      const { error } = await submit("anon", party.hash, [
        { guest_id: party.guestIds[0], attending: false },
        { guest_id: forged, attending: false },
      ]);
      expect(error?.message, forged).toBe("guest_rsvp_mismatch");
    }
    // Nothing changed: not the party's own guest, not the forged one.
    expect((await rsvpRows(party.guestIds)).map((r) => r.attending)).toEqual([true, true]);
    expect(await rsvpRows([sibling.guestIds[0], foreign.guestIds[0]])).toEqual([]);
  });

  it("every current guest must be answered exactly once", async () => {
    const party = await createParty("ownerA", weddingA, "Completo", ["Ana", "Carlos"]);
    const a = party.guestIds[0];
    for (const responses of [
      [{ guest_id: a, attending: true }],
      [
        { guest_id: a, attending: true },
        { guest_id: a, attending: false },
      ],
      [
        { guest_id: a, attending: true },
        { guest_id: party.guestIds[1], attending: true },
        { guest_id: a, attending: true },
      ],
    ]) {
      const { error } = await submit("anon", party.hash, responses);
      expect(error?.message).toBe("guest_rsvp_mismatch");
    }
    expect(await rsvpRows(party.guestIds)).toEqual([]);
  });

  it("malformed answers are rejected and nothing is saved", async () => {
    const party = await createParty("ownerA", weddingA, "Malformado", ["Ana"]);
    const id = party.guestIds[0];
    for (const responses of [
      null,
      {},
      [],
      [{ guest_id: id }],
      [{ guest_id: id, attending: "true" }],
      [{ guest_id: id, attending: null }],
      [{ guest_id: "not-a-uuid", attending: true }],
      [{ guest_id: id, attending: true, dietary_note: 42 }],
      ["texto"],
    ]) {
      const { error } = await submit("anon", party.hash, responses);
      expect(error?.message, JSON.stringify(responses)).toBe("guest_rsvp_invalid");
    }
    const longNote = await submit("anon", party.hash, [
      { guest_id: id, attending: true, dietary_note: "a".repeat(501) },
    ]);
    expect(longNote.error?.code).toBe(CHECK_VIOLATION);
    const control = await submit("anon", party.hash, [
      { guest_id: id, attending: true, dietary_note: "uno\ndos" },
    ]);
    expect(control.error?.code).toBe(CHECK_VIOLATION);
    expect(await rsvpRows(party.guestIds)).toEqual([]);
  });

  it("unknown links can't write, whoever calls", async () => {
    const party = await createParty("ownerA", weddingA, "Desconocido", ["Ana"]);
    for (const actor of ["anon", "ownerA", "outsider"] as const) {
      const { error } = await submit(actor, newToken().hash, [{ guest_id: party.guestIds[0], attending: true }]);
      expect(error?.message, actor).toBe("guest_invitation_unavailable");
    }
    expect(await rsvpRows(party.guestIds)).toEqual([]);
  });
});

// ------------------------------------------------------------ cascades

describe("deletion cascades", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda borrados");
  });

  it("deleting a party removes its guests and RSVPs only", async () => {
    const doomed = await createParty("ownerA", wedding, "Se va", ["Uno", "Dos"]);
    const kept = await createParty("ownerA", wedding, "Se queda", ["Tres"]);
    await submit("anon", doomed.hash, doomed.guestIds.map((id) => ({ guest_id: id, attending: true })));
    await submit("anon", kept.hash, [{ guest_id: kept.guestIds[0], attending: false }]);

    const { error } = await as.ownerA.from("guest_invitations").delete().eq("id", doomed.id);
    expect(error).toBeNull();
    expect(await sql("select 1 from public.guests where id = any($1::uuid[])", [doomed.guestIds])).toEqual([]);
    expect(await rsvpRows(doomed.guestIds)).toEqual([]);
    expect(await rsvpRows(kept.guestIds)).toHaveLength(1);
  });

  it("removing a guest removes their RSVP; the party and siblings stay", async () => {
    const party = await createParty("ownerA", wedding, "Familia", ["Uno", "Dos"]);
    await submit("anon", party.hash, party.guestIds.map((id) => ({ guest_id: id, attending: true })));
    const { error } = await as.ownerA.from("guests").delete().eq("id", party.guestIds[0]);
    expect(error).toBeNull();
    expect(await rsvpRows([party.guestIds[0]])).toEqual([]);
    expect(await rsvpRows([party.guestIds[1]])).toHaveLength(1);
    expect((await getParty("anon", party.hash)).data?.map((r) => r.guest_name)).toEqual(["Dos"]);
  });

  it("deleting the wedding removes its whole guest list", async () => {
    const doomedWedding = await fixtureWedding("ownerA", "Boda que se borra");
    const party = await createParty("ownerA", doomedWedding, "Todo", ["Uno"]);
    await submit("anon", party.hash, [{ guest_id: party.guestIds[0], attending: true }]);
    const { error } = await as.ownerA.from("weddings").delete().eq("id", doomedWedding);
    expect(error).toBeNull();
    for (const table of ["guest_invitations", "guests", "rsvps"]) {
      expect(await sql(`select 1 from public.${table} where wedding_id = $1`, [doomedWedding]), table).toEqual([]);
    }
  });
});
