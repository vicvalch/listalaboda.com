import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  serviceRole,
  shapedEnvelope,
  sql,
  superuser,
  users,
} from "./support";

// LB-15 (ADR-008): the wedding activity history's database boundary,
// exercised as real anon, authenticated and service_role callers through the
// Data API. The superuser connection only arranges fixtures (including the
// temporary "forced failure" triggers that prove atomicity) and reads ground
// truth.

const APPEND_ONLY = "55000";
const CHECK_VIOLATION = "23514";
const TABLE = "public.wedding_activity";

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

type Party = { id: string; hash: string };

function createPartyCall(actor: TestUserKey, weddingId: string, label: string, hash: string, contactEmail?: string) {
  return as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: ["Invitada Uno", "Invitado Dos"],
    ...(contactEmail ? { party_contact_email: contactEmail } : {}),
  });
}

async function createParty(actor: TestUserKey, weddingId: string, label: string, contactEmail?: string): Promise<Party> {
  const { hash } = newToken();
  const { data, error } = await createPartyCall(actor, weddingId, label, hash, contactEmail);
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, hash };
}

function rotate(actor: TestUserKey, weddingId: string, partyId: string, hash: string) {
  return as[actor].rpc("rotate_guest_invitation_link", {
    target_wedding_id: weddingId,
    target_invitation_id: partyId,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
  });
}

function revoke(actor: TestUserKey, weddingId: string, partyId: string) {
  return as[actor].rpc("revoke_guest_invitation_link", {
    target_wedding_id: weddingId,
    target_invitation_id: partyId,
  });
}

async function guestIds(partyId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at, id",
    [partyId],
  );
  return rows.map((r) => r.id);
}

/**
 * Fixture: moves a link's issue time 400 days back (no wedding date → it
 * expired). The link guard refuses that for every role, so triggers are
 * bypassed for this one fixture statement.
 */
async function expireLink(partyId: string) {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("update public.guest_invitations set token_issued_at = now() - interval '400 days' where id = $1", [
      partyId,
    ]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

/** The guest's own RSVP, as anon through the capability. */
async function answer(party: Party, attending: boolean) {
  const ids = await guestIds(party.id);
  return as.anon.rpc("submit_guest_rsvp", {
    invitation_token_hash: party.hash,
    responses: ids.map((id) => ({ guest_id: id, attending, dietary_note: "nota privada" })),
  });
}

type ActivityRow = {
  id: string;
  wedding_id: string;
  event_type: string;
  guest_invitation_id: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  occurred_at: Date;
};

/** Ground truth: every activity row of a wedding, oldest first. */
async function activityOf(weddingId: string): Promise<ActivityRow[]> {
  return sql<ActivityRow>(
    `select id, wedding_id, event_type::text, guest_invitation_id, actor_kind::text, actor_user_id, occurred_at
     from ${TABLE} where wedding_id = $1 order by occurred_at, id`,
    [weddingId],
  );
}

/** [event, party, actor kind, actor user] for compact assertions. */
async function eventsOf(weddingId: string) {
  return (await activityOf(weddingId)).map((r) => [r.event_type, r.guest_invitation_id, r.actor_kind, r.actor_user_id]);
}

/**
 * Makes every activity insert for ONE wedding fail, for the duration of
 * `fn`, to prove the business write rolls back with it. Test tooling only:
 * the trigger is created and dropped by the superuser.
 */
async function withFailingActivity<T>(weddingId: string, fn: () => PromiseLike<T>): Promise<T> {
  const suffix = randomUUID().replace(/-/g, "");
  const fnName = `test_fail_activity_${suffix}`;
  await superuser.query(
    `create function public.${fnName}() returns trigger language plpgsql as $$
     begin
       if new.wedding_id = '${weddingId}'::uuid then
         raise exception 'forced_activity_failure';
       end if;
       return new;
     end $$`,
  );
  await superuser.query(
    `create trigger ${fnName} before insert on ${TABLE} for each row execute function public.${fnName}()`,
  );
  try {
    return await fn();
  } finally {
    await superuser.query(`drop trigger ${fnName} on ${TABLE}`);
    await superuser.query(`drop function public.${fnName}()`);
  }
}

describe("wedding_activity: schema", () => {
  it("has exactly the typed columns of ADR-008, and no payload, token, note or email column", async () => {
    const columns = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string }>(
      `select column_name, data_type, udt_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'wedding_activity' order by ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: "id", data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
      { column_name: "wedding_id", data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
      { column_name: "event_type", data_type: "USER-DEFINED", udt_name: "wedding_activity_event", is_nullable: "NO" },
      { column_name: "guest_invitation_id", data_type: "uuid", udt_name: "uuid", is_nullable: "YES" },
      { column_name: "actor_kind", data_type: "USER-DEFINED", udt_name: "wedding_activity_actor", is_nullable: "NO" },
      { column_name: "actor_user_id", data_type: "uuid", udt_name: "uuid", is_nullable: "YES" },
      { column_name: "occurred_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" },
    ]);
  });

  it("closes the event and actor vocabularies (enums), with no scheduler events", async () => {
    const values = async (type: string) =>
      (
        await sql<{ v: string }>(
          `select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid
           where t.typname = $1 order by e.enumsortorder`,
          [type],
        )
      ).map((r) => r.v);
    expect(await values("wedding_activity_event")).toEqual([
      "guest_invitation_created",
      "guest_invitation_link_rotated",
      "guest_invitation_revoked",
      "guest_invitation_contact_email_changed",
      "guest_invitation_email_sent",
      "guest_rsvp_submitted",
      "guest_rsvp_updated",
      "rsvp_confirmation_email_sent",
      "rsvp_reminder_email_sent",
    ]);
    expect(await values("wedding_activity_actor")).toEqual(["member", "guest_capability", "system"]);
  });

  it("keeps history in its wedding: cascade from the wedding, SET NULL (party column only) from the party and the account", async () => {
    const fks = await sql<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.wedding_activity'::regclass and contype = 'f' order by conname`,
    );
    expect(fks).toEqual([
      {
        name: "wedding_activity_actor_user_id_fkey",
        definition: "FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL",
      },
      {
        name: "wedding_activity_guest_invitation_same_wedding",
        definition:
          "FOREIGN KEY (guest_invitation_id, wedding_id) REFERENCES guest_invitations(id, wedding_id) ON DELETE SET NULL (guest_invitation_id)",
      },
      {
        name: "wedding_activity_wedding_id_fkey",
        definition: "FOREIGN KEY (wedding_id) REFERENCES weddings(id) ON DELETE CASCADE",
      },
    ]);
  });

  it("indexes the newest-first read and the party foreign key", async () => {
    const indexes = await sql<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'wedding_activity' order by indexname",
    );
    expect(indexes.map((i) => i.indexdef.replace(/^.* USING /, ""))).toEqual([
      "btree (guest_invitation_id, wedding_id)",
      "btree (id)",
      "btree (wedding_id, occurred_at DESC, id DESC)",
    ]);
  });

  it("enables RLS; members SELECT; no client role can INSERT, UPDATE or DELETE", async () => {
    const [table] = await sql<{ rls: boolean }>(
      "select relrowsecurity as rls from pg_class where oid = 'public.wedding_activity'::regclass",
    );
    expect(table?.rls).toBe(true);
    const grants = await sql<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'wedding_activity'
         and grantee in ('anon', 'authenticated', 'PUBLIC') order by grantee, privilege_type`,
    );
    expect(grants).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });

  it("pins the function grants: read for members, revoke for members (owner-checked), recorders for service_role only", async () => {
    const can = async (signature: string) =>
      sql<{ role: string; can: boolean }>(
        `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) as r (role) order by r.role`,
        [signature],
      );
    const memberOnly = [
      { role: "anon", can: false },
      { role: "authenticated", can: true },
      { role: "service_role", can: true },
    ];
    const serviceOnly = [
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ];
    expect(await can("public.get_wedding_activity(uuid, integer)")).toEqual(memberOnly);
    expect(await can("public.revoke_guest_invitation_link(uuid, uuid)")).toEqual(memberOnly);
    expect(await can("public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid)")).toEqual(serviceOnly);
    expect(await can("public.record_rsvp_confirmation_email(uuid, uuid, text, text, text)")).toEqual(serviceOnly);
    expect(await can("public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid)")).toEqual(serviceOnly);
    // The pre-LB-15 recorder signatures are gone (no un-attributed path left).
    expect(
      await sql(
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('record_guest_invitation_email', 'record_rsvp_reminder_email')
           and p.pronargs = 5`,
      ),
    ).toEqual([]);
    // No client-executable function takes an event type: nobody can append arbitrary history.
    const writers = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private')
         and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
         and exists (select 1 from unnest(p.proargtypes) t where t = 'public.wedding_activity_event'::regtype)`,
    );
    expect(writers).toEqual([]);
  });

  it("the read function is SECURITY INVOKER (RLS decides) with a fixed search_path", async () => {
    const [fn] = await sql<{ definer: boolean; config: string[] }>(
      "select prosecdef as definer, proconfig as config from pg_proc where oid = 'public.get_wedding_activity(uuid, integer)'::regprocedure",
    );
    expect(fn).toEqual({ definer: false, config: ['search_path=""'] });
  });
});

describe("wedding_activity: tenant boundary", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda actividad A");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await fixtureWedding("ownerB", "Boda actividad B");
    await createParty("ownerA", weddingA, "Familia A");
    await createParty("ownerB", weddingB, "Familia B");
  });

  it("owner and collaborator read their wedding's history, table and function alike", async () => {
    for (const member of ["ownerA", "collabA"] as const) {
      const table = await as[member].from("wedding_activity").select("event_type").eq("wedding_id", weddingA);
      expect(table.error).toBeNull();
      expect(table.data).toEqual([{ event_type: "guest_invitation_created" }]);
      const fn = await as[member].rpc("get_wedding_activity", { target_wedding_id: weddingA });
      expect(fn.error).toBeNull();
      expect(fn.data?.map((r) => [r.event_type, r.party_label])).toEqual([["guest_invitation_created", "Familia A"]]);
    }
  });

  it("an outsider and another wedding's owner read nothing", async () => {
    for (const user of ["outsider", "ownerB"] as const) {
      const table = await as[user].from("wedding_activity").select("id").eq("wedding_id", weddingA);
      expect(table.data).toEqual([]);
      const fn = await as[user].rpc("get_wedding_activity", { target_wedding_id: weddingA });
      expect(fn.error).toBeNull();
      expect(fn.data).toEqual([]);
    }
    // Wedding B's owner sees only B.
    const own = await as.ownerB.from("wedding_activity").select("wedding_id");
    expect(new Set(own.data?.map((r) => r.wedding_id))).toEqual(new Set([weddingB]));
  });

  it("anon (and so any guest-link holder) reads nothing and can't call the read function", async () => {
    const table = await as.anon.from("wedding_activity").select("id").eq("wedding_id", weddingA);
    expect(table.error?.code ?? null).not.toBeNull();
    const fn = await as.anon.rpc("get_wedding_activity", { target_wedding_id: weddingA });
    expect(fn.error?.code).toBe(PERMISSION_DENIED);
  });
});

describe("wedding_activity: append-only", () => {
  let wedding: string;
  let party: Party;
  let row: ActivityRow;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda historial inmutable");
    await addMember(wedding, "collabA", "collaborator");
    party = await createParty("ownerA", wedding, "Familia Inmutable");
    [row] = (await activityOf(wedding)) as [ActivityRow];
  });

  it("members can't insert, update or delete history directly", async () => {
    for (const member of ["ownerA", "collabA"] as const) {
      const insert = await as[member].from("wedding_activity").insert({
        wedding_id: wedding,
        event_type: "guest_rsvp_submitted",
        guest_invitation_id: party.id,
        actor_kind: "guest_capability",
      });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      const update = await as[member]
        .from("wedding_activity")
        .update({ event_type: "guest_invitation_revoked" })
        .eq("id", row.id);
      expect(update.error?.code).toBe(PERMISSION_DENIED);
      const remove = await as[member].from("wedding_activity").delete().eq("id", row.id);
      expect(remove.error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await activityOf(wedding)).toEqual([row]);
  });

  it("anon and outsiders can't write it either", async () => {
    for (const client of [as.anon, as.outsider]) {
      const insert = await client.from("wedding_activity").insert({
        wedding_id: wedding,
        event_type: "guest_rsvp_submitted",
        guest_invitation_id: party.id,
        actor_kind: "guest_capability",
      });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      const remove = await client.from("wedding_activity").delete().eq("id", row.id);
      expect(remove.error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await activityOf(wedding)).toEqual([row]);
  });

  it("even privileged roles can't edit or delete a row (only the foreign keys' own actions may)", async () => {
    const update = await serviceRole.from("wedding_activity").update({ event_type: "guest_invitation_revoked" }).eq("id", row.id);
    expect(update.error?.code).toBe(APPEND_ONLY);
    const remove = await serviceRole.from("wedding_activity").delete().eq("id", row.id);
    expect(remove.error?.code).toBe(APPEND_ONLY);
    await expect(sql(`update ${TABLE} set occurred_at = now() - interval '1 day' where id = $1`, [row.id])).rejects.toMatchObject(
      { code: APPEND_ONLY },
    );
    await expect(sql(`update ${TABLE} set guest_invitation_id = null where id = $1`, [row.id])).rejects.toMatchObject({
      code: APPEND_ONLY,
    });
    await expect(sql(`delete from ${TABLE} where id = $1`, [row.id])).rejects.toMatchObject({ code: APPEND_ONLY });
    expect(await activityOf(wedding)).toEqual([row]);
  });

  it("the time is always the database clock, and the actor must be coherent", async () => {
    // Even a privileged insert can't backdate history.
    const [inserted] = await sql<{ occurred_at: Date }>(
      `insert into ${TABLE} (wedding_id, event_type, guest_invitation_id, actor_kind, occurred_at)
       values ($1, 'guest_rsvp_submitted', $2, 'guest_capability', '2000-01-01T00:00:00Z') returning occurred_at`,
      [wedding, party.id],
    );
    expect(Math.abs((inserted?.occurred_at.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    // A member actor must name its user; guests and the system never carry one.
    await expect(
      sql(
        `insert into ${TABLE} (wedding_id, event_type, guest_invitation_id, actor_kind) values ($1, 'guest_invitation_revoked', $2, 'member')`,
        [wedding, party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: "wedding_activity_actor_required" });
    await expect(
      sql(
        `insert into ${TABLE} (wedding_id, event_type, guest_invitation_id, actor_kind, actor_user_id) values ($1, 'guest_rsvp_submitted', $2, 'guest_capability', $3)`,
        [wedding, party.id, users.ownerA.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    // Every LB-15 event names its party.
    await expect(
      sql(`insert into ${TABLE} (wedding_id, event_type, actor_kind) values ($1, 'guest_rsvp_submitted', 'guest_capability')`, [
        wedding,
      ]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: "wedding_activity_subject_required" });
    // A party of ANOTHER wedding can't be referenced (same-wedding FK).
    const other = await fixtureWedding("ownerB", "Boda ajena historial");
    const foreign = await createParty("ownerB", other, "Familia Ajena");
    await expect(
      sql(
        `insert into ${TABLE} (wedding_id, event_type, guest_invitation_id, actor_kind) values ($1, 'guest_rsvp_submitted', $2, 'guest_capability')`,
        [wedding, foreign.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("wedding_activity: party lifecycle (create, rotate, revoke, contact email)", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda ciclo de grupos");
    await addMember(wedding, "collabA", "collaborator");
  });

  it("creating a party appends guest_invitation_created by the calling member, once", async () => {
    const byOwner = await createParty("ownerA", wedding, "Creado por dueña");
    const byCollab = await createParty("collabA", wedding, "Creado por colaboración");
    const events = await eventsOf(wedding);
    expect(events).toContainEqual(["guest_invitation_created", byOwner.id, "member", users.ownerA.id]);
    expect(events).toContainEqual(["guest_invitation_created", byCollab.id, "member", users.collabA.id]);
    expect(events.filter((e) => e[1] === byOwner.id)).toHaveLength(1);
  });

  it("a party and its history commit together: if the history insert fails, no party exists", async () => {
    const { hash } = newToken();
    const before = await activityOf(wedding);
    const result = await withFailingActivity(wedding, () => createPartyCall("ownerA", wedding, "Sin historial", hash));
    expect(result.error?.message).toBe("forced_activity_failure");
    expect(await sql("select 1 from public.guest_invitations where token_hash = $1", [hash])).toEqual([]);
    expect(await sql("select 1 from public.guest_invitations where wedding_id = $1 and label = 'Sin historial'", [wedding])).toEqual(
      [],
    );
    expect(await activityOf(wedding)).toEqual(before);
  });

  it("rotating appends guest_invitation_link_rotated by the owner; a failed history insert keeps the old link and envelope", async () => {
    const party = await createParty("ownerA", wedding, "Rotación");
    const next = newToken();
    const rotated = await rotate("ownerA", wedding, party.id, next.hash);
    expect(rotated.data).toBe(true);
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toEqual([
      ["guest_invitation_created", party.id, "member", users.ownerA.id],
      ["guest_invitation_link_rotated", party.id, "member", users.ownerA.id],
    ]);

    const secretBefore = await sql(
      "select token_hash, token_ciphertext from private.guest_invitation_capability_secrets where guest_invitation_id = $1",
      [party.id],
    );
    const failed = await withFailingActivity(wedding, () => rotate("ownerA", wedding, party.id, newToken().hash));
    expect(failed.error?.message).toBe("forced_activity_failure");
    const [stored] = await sql<{ token_hash: string }>("select token_hash from public.guest_invitations where id = $1", [party.id]);
    expect(stored?.token_hash).toBe(next.hash);
    expect(
      await sql(
        "select token_hash, token_ciphertext from private.guest_invitation_capability_secrets where guest_invitation_id = $1",
        [party.id],
      ),
    ).toEqual(secretBefore);
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toHaveLength(2);

    // A collaborator's refused rotation records nothing.
    const refused = await rotate("collabA", wedding, party.id, newToken().hash);
    expect(refused.error?.message).toBe("guest_link_owner_only");
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toHaveLength(2);
  });

  it("revoking goes through one owner-only door that records it once; the plain UPDATE door is closed", async () => {
    const party = await createParty("collabA", wedding, "Revocación");

    // Collaborator: refused by the RPC, and the column grant is gone.
    const byCollab = await revoke("collabA", wedding, party.id);
    expect(byCollab.error?.code).toBe(PERMISSION_DENIED);
    expect(byCollab.error?.message).toBe("guest_link_owner_only");
    for (const member of ["collabA", "ownerA"] as const) {
      const direct = await as[member]
        .from("guest_invitations")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", party.id)
        .select("id");
      expect(direct.error?.code).toBe(PERMISSION_DENIED);
    }
    // Outsiders and other weddings' owners get false, like a missing party.
    expect((await revoke("outsider", wedding, party.id)).data).toBe(false);
    expect((await revoke("ownerB", wedding, party.id)).data).toBe(false);
    const [still] = await sql<{ revoked_at: Date | null }>("select revoked_at from public.guest_invitations where id = $1", [
      party.id,
    ]);
    expect(still?.revoked_at).toBeNull();

    // A failed history insert leaves the link working.
    const failed = await withFailingActivity(wedding, () => revoke("ownerA", wedding, party.id));
    expect(failed.error?.message).toBe("forced_activity_failure");
    const [unchanged] = await sql<{ revoked_at: Date | null }>(
      "select revoked_at from public.guest_invitations where id = $1",
      [party.id],
    );
    expect(unchanged?.revoked_at).toBeNull();
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toEqual([
      ["guest_invitation_created", party.id, "member", users.collabA.id],
    ]);

    // Owner: revoked (database clock) and recorded once; again = no-op, no new row.
    const done = await revoke("ownerA", wedding, party.id);
    expect(done.error).toBeNull();
    expect(done.data).toBe(true);
    const [revoked] = await sql<{ revoked_at: Date | null }>("select revoked_at from public.guest_invitations where id = $1", [
      party.id,
    ]);
    expect(Math.abs((revoked?.revoked_at?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    expect((await revoke("ownerA", wedding, party.id)).data).toBe(true);
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toEqual([
      ["guest_invitation_created", party.id, "member", users.collabA.id],
      ["guest_invitation_revoked", party.id, "member", users.ownerA.id],
    ]);
    // Unknown party in the owner's wedding: false, nothing recorded.
    expect((await revoke("ownerA", wedding, randomUUID())).data).toBe(false);
  });

  it("a contact-email change is recorded (who, when), never the address; no-op and label edits aren't", async () => {
    const party = await createParty("ownerA", wedding, "Correo", "antes@example.com");
    const setEmail = (member: TestUserKey, email: string | null) =>
      as[member].from("guest_invitations").update({ contact_email: email }).eq("id", party.id).select("id");

    expect((await setEmail("collabA", "despues@example.com")).data).toHaveLength(1);
    expect((await setEmail("collabA", "despues@example.com")).data).toHaveLength(1); // unchanged value
    expect(
      (await as.ownerA.from("guest_invitations").update({ label: "Correo renombrado" }).eq("id", party.id).select("id")).data,
    ).toHaveLength(1);
    expect((await setEmail("ownerA", null)).data).toHaveLength(1); // removed

    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toEqual([
      ["guest_invitation_created", party.id, "member", users.ownerA.id],
      ["guest_invitation_contact_email_changed", party.id, "member", users.collabA.id],
      ["guest_invitation_contact_email_changed", party.id, "member", users.ownerA.id],
    ]);
    // An invalid address changes nothing and records nothing.
    expect((await setEmail("ownerA", "no es correo")).error?.code).toBe(CHECK_VIOLATION);
    expect((await eventsOf(wedding)).filter((e) => e[1] === party.id)).toHaveLength(3);
  });
});

describe("wedding_activity: RSVP", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda historial RSVP");
  });

  const rsvpEvents = async (partyId: string) =>
    (await eventsOf(wedding)).filter((e) => e[1] === partyId && String(e[0]).startsWith("guest_rsvp"));

  it("the first answer is guest_rsvp_submitted, every later one guest_rsvp_updated, by the link holder (no user id)", async () => {
    const party = await createParty("ownerA", wedding, "Responde");
    expect((await answer(party, true)).error).toBeNull();
    expect(await rsvpEvents(party.id)).toEqual([["guest_rsvp_submitted", party.id, "guest_capability", null]]);

    expect((await answer(party, false)).error).toBeNull();
    expect((await answer(party, false)).error).toBeNull(); // an unchanged re-save is still a save
    expect(await rsvpEvents(party.id)).toEqual([
      ["guest_rsvp_submitted", party.id, "guest_capability", null],
      ["guest_rsvp_updated", party.id, "guest_capability", null],
      ["guest_rsvp_updated", party.id, "guest_capability", null],
    ]);
  });

  it("an authenticated caller answering through the link is still the link holder, never a member", async () => {
    const party = await createParty("ownerA", wedding, "Responde con sesión");
    const ids = await guestIds(party.id);
    const { error } = await as.ownerA.rpc("submit_guest_rsvp", {
      invitation_token_hash: party.hash,
      responses: ids.map((id) => ({ guest_id: id, attending: true })),
    });
    expect(error).toBeNull();
    expect(await rsvpEvents(party.id)).toEqual([["guest_rsvp_submitted", party.id, "guest_capability", null]]);
  });

  it("refused submissions record nothing: unknown, revoked, expired links and bad payloads", async () => {
    const party = await createParty("ownerA", wedding, "No responde");
    const ids = await guestIds(party.id);

    const unknown = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: newToken().hash,
      responses: ids.map((id) => ({ guest_id: id, attending: true })),
    });
    expect(unknown.error?.message).toBe("guest_invitation_unavailable");
    const partial = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: party.hash,
      responses: [{ guest_id: ids[0], attending: true }],
    });
    expect(partial.error?.message).toBe("guest_rsvp_mismatch");
    const malformed = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: party.hash,
      responses: ids.map((id) => ({ guest_id: id, attending: "sí" })),
    });
    expect(malformed.error?.message).toBe("guest_rsvp_invalid");

    expect((await revoke("ownerA", wedding, party.id)).data).toBe(true);
    expect((await answer(party, true)).error?.message).toBe("guest_invitation_unavailable");

    const expired = await createParty("ownerA", wedding, "Vencido");
    await expireLink(expired.id);
    expect((await answer(expired, true)).error?.message).toBe("guest_invitation_unavailable");

    expect(await rsvpEvents(party.id)).toEqual([]);
    expect(await rsvpEvents(expired.id)).toEqual([]);
    expect(await sql("select 1 from public.rsvps where guest_id = any($1::uuid[])", [ids])).toEqual([]);
  });

  it("answers and their history commit together: a failed history insert saves no answer", async () => {
    const party = await createParty("ownerA", wedding, "Atómico");
    const failed = await withFailingActivity(wedding, () => answer(party, true));
    expect(failed.error?.message).toBe("forced_activity_failure");
    expect(await sql("select 1 from public.rsvps where guest_id = any($1::uuid[])", [await guestIds(party.id)])).toEqual([]);
    expect(await rsvpEvents(party.id)).toEqual([]);
  });
});

describe("wedding_activity: email recorders (service_role)", () => {
  let wedding: string;
  const recipient = "grupo@example.com";

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda historial correos");
    await addMember(wedding, "collabA", "collaborator");
  });

  const emailEvents = async (partyId: string) =>
    (await eventsOf(wedding)).filter((e) => e[1] === partyId && String(e[0]).endsWith("_email_sent"));

  const meta = async (partyId: string) =>
    (
      await sql<Record<string, unknown>>(
        `select invitation_email_sent_at, rsvp_confirmation_email_sent_at, rsvp_reminder_email_sent_at
         from public.guest_invitations where id = $1`,
        [partyId],
      )
    )[0];

  function recordInvitation(party: Party, actingUser: string | null, overrides: Partial<{ recipient: string; hash: string }> = {}) {
    return serviceRole.rpc("record_guest_invitation_email", {
      target_wedding_id: wedding,
      target_invitation_id: party.id,
      invitation_token_hash: overrides.hash ?? party.hash,
      recipient: overrides.recipient ?? recipient,
      provider_message_id: `msg-${randomUUID()}`,
      // The generated type is non-null; null is exercised on purpose.
      acting_user_id: actingUser as string,
    });
  }

  function recordReminder(party: Party, actingUser: string, overrides: Partial<{ recipient: string; hash: string }> = {}) {
    return serviceRole.rpc("record_rsvp_reminder_email", {
      target_wedding_id: wedding,
      target_invitation_id: party.id,
      invitation_token_hash: overrides.hash ?? party.hash,
      recipient: overrides.recipient ?? recipient,
      provider_message_id: `msg-${randomUUID()}`,
      acting_user_id: actingUser,
    });
  }

  function recordConfirmation(party: Party, overrides: Partial<{ recipient: string; hash: string }> = {}) {
    return serviceRole.rpc("record_rsvp_confirmation_email", {
      target_wedding_id: wedding,
      target_invitation_id: party.id,
      invitation_token_hash: overrides.hash ?? party.hash,
      recipient: overrides.recipient ?? recipient,
      provider_message_id: `msg-${randomUUID()}`,
    });
  }

  it("invitation: metadata and a member-attributed row together; a non-member actor records neither", async () => {
    const party = await createParty("ownerA", wedding, "Invitación", recipient);
    expect((await recordInvitation(party, users.collabA.id)).error).toBeNull();
    expect(await emailEvents(party.id)).toEqual([["guest_invitation_email_sent", party.id, "member", users.collabA.id]]);

    const other = await createParty("ownerA", wedding, "Invitación rechazada", recipient);
    for (const actor of [users.outsider.id, users.ownerB.id, randomUUID(), null]) {
      const refused = await recordInvitation(other, actor);
      expect(refused.error?.message).toBe("guest_invitation_email_not_recorded");
    }
    expect((await recordInvitation(other, users.ownerA.id, { recipient: "otro@example.com" })).error?.message).toBe(
      "guest_invitation_email_not_recorded",
    );
    expect((await recordInvitation(other, users.ownerA.id, { hash: newToken().hash })).error?.message).toBe(
      "guest_invitation_email_not_recorded",
    );
    expect((await meta(other.id))?.invitation_email_sent_at).toBeNull();
    expect(await emailEvents(other.id)).toEqual([]);

    // Forced history failure: the metadata isn't written either.
    const atomic = await createParty("ownerA", wedding, "Invitación atómica", recipient);
    const failed = await withFailingActivity(wedding, () => recordInvitation(atomic, users.ownerA.id));
    expect(failed.error?.message).toBe("forced_activity_failure");
    expect((await meta(atomic.id))?.invitation_email_sent_at).toBeNull();
    expect(await emailEvents(atomic.id)).toEqual([]);
  });

  it("confirmation: metadata and a link-holder row together; a stale link or wrong recipient records neither", async () => {
    const party = await createParty("ownerA", wedding, "Confirmación", recipient);
    expect((await recordConfirmation(party)).error).toBeNull();
    expect(await emailEvents(party.id)).toEqual([["rsvp_confirmation_email_sent", party.id, "guest_capability", null]]);

    const other = await createParty("ownerA", wedding, "Confirmación rechazada", recipient);
    expect((await recordConfirmation(other, { recipient: "otro@example.com" })).error?.message).toBe(
      "rsvp_confirmation_email_not_recorded",
    );
    expect((await recordConfirmation(other, { hash: newToken().hash })).error?.message).toBe(
      "rsvp_confirmation_email_not_recorded",
    );
    const failed = await withFailingActivity(wedding, () => recordConfirmation(other));
    expect(failed.error?.message).toBe("forced_activity_failure");
    expect((await meta(other.id))?.rsvp_confirmation_email_sent_at).toBeNull();
    expect(await emailEvents(other.id)).toEqual([]);
  });

  it("reminder: metadata and a member-attributed row together; revoked links, strangers and wrong recipients record neither", async () => {
    const party = await createParty("ownerA", wedding, "Recordatorio", recipient);
    expect((await recordReminder(party, users.ownerA.id)).error).toBeNull();
    expect((await recordReminder(party, users.collabA.id)).error).toBeNull();
    expect(await emailEvents(party.id)).toEqual([
      ["rsvp_reminder_email_sent", party.id, "member", users.ownerA.id],
      ["rsvp_reminder_email_sent", party.id, "member", users.collabA.id],
    ]);

    const other = await createParty("ownerA", wedding, "Recordatorio rechazado", recipient);
    expect((await recordReminder(other, users.outsider.id)).error?.message).toBe("rsvp_reminder_email_not_recorded");
    expect((await recordReminder(other, users.ownerA.id, { recipient: "otro@example.com" })).error?.message).toBe(
      "rsvp_reminder_email_not_recorded",
    );
    const failed = await withFailingActivity(wedding, () => recordReminder(other, users.ownerA.id));
    expect(failed.error?.message).toBe("forced_activity_failure");
    expect((await revoke("ownerA", wedding, other.id)).data).toBe(true);
    expect((await recordReminder(other, users.ownerA.id)).error?.message).toBe("rsvp_reminder_email_not_recorded");
    expect((await meta(other.id))?.rsvp_reminder_email_sent_at).toBeNull();
    expect(await emailEvents(other.id)).toEqual([]);
  });
});

describe("wedding_activity: privacy", () => {
  it("rows and the read projection carry no capability, answer, note, email or provider data", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda historial privado");
    const recipient = "privado@example.com";
    const party = await createParty("ownerA", wedding, "Privado", recipient);
    const next = newToken();
    await rotate("ownerA", wedding, party.id, next.hash);
    const current = { ...party, hash: next.hash };
    await answer(current, true);
    const providerId = `msg-${randomUUID()}`;
    await serviceRole.rpc("record_rsvp_confirmation_email", {
      target_wedding_id: wedding,
      target_invitation_id: party.id,
      invitation_token_hash: next.hash,
      recipient,
      provider_message_id: providerId,
    });

    const rows = await sql(`select * from ${TABLE} where wedding_id = $1`, [wedding]);
    const projection = await as.ownerA.rpc("get_wedding_activity", { target_wedding_id: wedding });
    expect(projection.data).toHaveLength(rows.length);
    const [secret] = await sql<{ token_ciphertext: string }>(
      "select token_ciphertext from private.guest_invitation_capability_secrets where guest_invitation_id = $1",
      [party.id],
    );
    const dump = JSON.stringify({ rows, projection: projection.data });
    for (const forbidden of [party.hash, next.hash, secret?.token_ciphertext, recipient, providerId, "nota privada", "/rsvp/"]) {
      expect(forbidden && dump.includes(forbidden), "no sensitive value in activity (redacted)").toBe(false);
    }
    expect(Object.keys(projection.data?.[0] ?? {}).sort()).toEqual([
      "actor_kind",
      "actor_membership_id",
      "event_type",
      "guest_invitation_id",
      "id",
      "occurred_at",
      "party_label",
    ]);
  });
});

describe("wedding_activity: read model and deletion", () => {
  it("newest first, at most 50 rows whatever is asked; current party label; members by membership", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda historial lectura");
    await addMember(wedding, "collabA", "collaborator");
    const party = await createParty("ownerA", wedding, "Primera");
    await createParty("collabA", wedding, "Segunda");
    await as.ownerA.from("guest_invitations").update({ label: "Primera renombrada" }).eq("id", party.id);

    const { data } = await as.collabA.rpc("get_wedding_activity", { target_wedding_id: wedding });
    const memberships = await sql<{ id: string; user_id: string }>(
      "select id, user_id from public.wedding_memberships where wedding_id = $1",
      [wedding],
    );
    const membershipOf = (userId: string) => memberships.find((m) => m.user_id === userId)?.id;
    expect(data?.map((r) => [r.event_type, r.party_label, r.actor_kind, r.actor_membership_id])).toEqual([
      ["guest_invitation_created", "Segunda", "member", membershipOf(users.collabA.id)],
      ["guest_invitation_created", "Primera renombrada", "member", membershipOf(users.ownerA.id)],
    ]);

    // 60 more rows (fixture inserts, one transaction each so the clock moves).
    for (let i = 0; i < 60; i += 1) {
      await sql(
        `insert into ${TABLE} (wedding_id, event_type, guest_invitation_id, actor_kind) values ($1, 'guest_rsvp_updated', $2, 'guest_capability')`,
        [wedding, party.id],
      );
    }
    for (const max of [undefined, 50, 1000]) {
      const page = await as.ownerA.rpc("get_wedding_activity", {
        target_wedding_id: wedding,
        ...(max === undefined ? {} : { max_events: max }),
      });
      expect(page.data).toHaveLength(50);
      const times = page.data?.map((r) => `${r.occurred_at}|${r.id}`) ?? [];
      expect([...times].sort().reverse()).toEqual(times);
    }
    expect((await as.ownerA.rpc("get_wedding_activity", { target_wedding_id: wedding, max_events: 3 })).data).toHaveLength(3);
    expect((await as.ownerA.rpc("get_wedding_activity", { target_wedding_id: wedding, max_events: -5 })).data).toHaveLength(1);
  });

  it("deleting a party keeps its history (party reference nulled); a removed member's rows lose only the label", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda historial borrado");
    await addMember(wedding, "collabA", "collaborator");
    const party = await createParty("collabA", wedding, "Se borrará");
    await answer(party, true);

    const removed = await as.collabA.from("guest_invitations").delete().eq("id", party.id).select("id");
    expect(removed.data).toHaveLength(1);
    expect(await eventsOf(wedding)).toEqual([
      ["guest_invitation_created", null, "member", users.collabA.id],
      ["guest_rsvp_submitted", null, "guest_capability", null],
    ]);
    const { data } = await as.ownerA.rpc("get_wedding_activity", { target_wedding_id: wedding });
    expect(data?.map((r) => [r.event_type, r.guest_invitation_id, r.party_label])).toEqual([
      ["guest_rsvp_submitted", null, null],
      ["guest_invitation_created", null, null],
    ]);

    // The collaborator leaves the wedding: the row stays, unlabelled.
    await sql("delete from public.wedding_memberships where wedding_id = $1 and user_id = $2", [wedding, users.collabA.id]);
    const after = await as.ownerA.rpc("get_wedding_activity", { target_wedding_id: wedding });
    expect(after.data?.map((r) => [r.event_type, r.actor_kind, r.actor_membership_id])).toEqual([
      ["guest_rsvp_submitted", "guest_capability", null],
      ["guest_invitation_created", "member", null],
    ]);
    expect((await activityOf(wedding))[0]?.actor_user_id).toBe(users.collabA.id);
  });

  it("deleting the wedding deletes its history", async () => {
    const wedding = await createFixtureWedding("ownerA", "Boda historial que se borra");
    await createParty("ownerA", wedding, "Último");
    expect(await activityOf(wedding)).toHaveLength(1);
    const { error } = await as.ownerA.from("weddings").delete().eq("id", wedding);
    expect(error).toBeNull();
    expect(await activityOf(wedding)).toEqual([]);
  });
});

describe("wedding_activity: no backfill", () => {
  it("the LB-15 migration fabricates no history for parties, sends and answers that already exist", async () => {
    // Pre-existing data with every kind of old fact: created, rotated,
    // emailed (invitation, confirmation, reminder), answered, revoked.
    const wedding = await fixtureWedding("ownerA", "Boda anterior al historial");
    const recipient = "anterior@example.com";
    const party = await createParty("ownerA", wedding, "Anterior", recipient);
    await answer(party, true);
    await serviceRole.rpc("record_rsvp_confirmation_email", {
      target_wedding_id: wedding,
      target_invitation_id: party.id,
      invitation_token_hash: party.hash,
      recipient,
      provider_message_id: `msg-${randomUUID()}`,
    });
    await revoke("ownerA", wedding, party.id);

    const migrationPath = fileURLToPath(
      new URL("../../supabase/migrations/20261010120000_lb_wedding_activity.sql", import.meta.url),
    );
    const migration = await readFile(migrationPath, "utf8");

    // In ONE transaction that is rolled back: undo LB-15's objects (test
    // tooling only), re-apply the real migration on top of this data, and
    // count what it inserted.
    const client = await superuser.connect();
    try {
      await client.query("begin");
      await client.query(`
        drop trigger guest_invitations_contact_email_activity on public.guest_invitations;
        drop function private.record_guest_invitation_contact_email_change();
        drop function public.get_wedding_activity(uuid, integer);
        drop function public.revoke_guest_invitation_link(uuid, uuid);
        drop function public.record_guest_invitation_email(uuid, uuid, text, text, text, uuid);
        drop function public.record_rsvp_reminder_email(uuid, uuid, text, text, text, uuid);
        create function public.record_guest_invitation_email(uuid, uuid, text, text, text)
          returns timestamptz language sql as 'select null::timestamptz';
        create function public.record_rsvp_reminder_email(uuid, uuid, text, text, text)
          returns timestamptz language sql as 'select null::timestamptz';
        drop table public.wedding_activity;
        drop function private.guard_wedding_activity();
        drop type public.wedding_activity_event;
        drop type public.wedding_activity_actor;
      `);
      await client.query(migration);
      const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${TABLE}`);
      expect(rows[0]?.n).toBe(0);
      // The old facts are still there, only without history.
      const { rows: old } = await client.query(
        "select 1 from public.guest_invitations where id = $1 and revoked_at is not null and rsvp_confirmation_email_sent_at is not null",
        [party.id],
      );
      expect(old).toHaveLength(1);
    } finally {
      await client.query("rollback");
      client.release();
    }
    // The rollback restored the real history untouched.
    expect((await eventsOf(wedding)).map((e) => e[0])).toEqual([
      "guest_invitation_created",
      "guest_rsvp_submitted",
      "rsvp_confirmation_email_sent",
      "guest_invitation_revoked",
    ]);
  });
});
