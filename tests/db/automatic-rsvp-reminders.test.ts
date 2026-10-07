import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  emailDeliveriesFor,
  createWedding as createFixtureWedding,
  serviceRole,
  shapedEnvelope,
  sql,
  superuser,
  users,
} from "./support";

// LB-17 (ADR-010): the automatic RSVP reminder scheduler's database boundary,
// exercised as real anon, authenticated and service_role callers through the
// Data API. The superuser connection only arranges fixtures (including
// moving times into the past, since the database clock can't be faked) and
// reads ground truth; it never performs the action under test.

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

const SCHEDULER_FUNCTIONS = [
  "public.claim_automatic_rsvp_reminders(integer, integer)",
  "public.prepare_automatic_rsvp_reminder(uuid, uuid)",
  "public.begin_automatic_rsvp_reminder_send(uuid, uuid, text, text)",
  "public.record_automatic_rsvp_reminder_email(uuid, uuid, text, text, text)",
  "public.finish_automatic_rsvp_reminder(uuid, uuid, automatic_rsvp_reminder_finish_outcome)",
];
const POLICY_FUNCTION = "public.set_rsvp_reminder_policy(uuid, boolean, integer)";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

// Every test starts from a quiet scheduler: claims are global, so leftovers
// from another test (or file) must not be picked up.
beforeEach(async () => {
  await sql("delete from public.automatic_rsvp_reminders");
  await sql("update public.wedding_rsvp_reminder_policies set enabled = false");
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

type Party = { id: string; hash: string; weddingId: string };

async function createParty(weddingId: string, label: string, contactEmail: string | null = "familia@example.com") {
  const { hash } = newToken();
  const { data, error } = await as.ownerA.rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: ["Invitada Uno", "Invitado Dos"],
    ...(contactEmail ? { party_contact_email: contactEmail } : {}),
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, hash, weddingId } satisfies Party;
}

/**
 * Wedding (UTC) whose 14-day reminder became due within the last 24 hours,
 * with the policy enabled by the owner and enabled_at moved a month back.
 */
async function dueWedding(name: string, opts: { daysBefore?: 14 | 21 | 30 } = {}): Promise<string> {
  const days = opts.daysBefore ?? 14;
  const id = await fixtureWedding("ownerA", name);
  await sql(
    `update public.weddings set time_zone = 'UTC',
       wedding_date = ((now() at time zone 'UTC') - interval '10 hours')::date + $2::integer
     where id = $1`,
    [id, days],
  );
  await enable(id, days);
  await sql(
    "update public.wedding_rsvp_reminder_policies set enabled_at = now() - interval '30 days' where wedding_id = $1",
    [id],
  );
  return id;
}

async function enable(weddingId: string, days = 14) {
  const { data, error } = await as.ownerA.rpc("set_rsvp_reminder_policy", {
    target_wedding_id: weddingId,
    reminders_enabled: true,
    reminder_days_before: days,
  });
  if (error || data !== true) throw new Error(`set_rsvp_reminder_policy failed: ${error?.message}`);
}

async function claim(maxTotal = 50, maxPerWedding = 25) {
  const { data, error } = await serviceRole.rpc("claim_automatic_rsvp_reminders", {
    max_total: maxTotal,
    max_per_wedding: maxPerWedding,
  });
  if (error || !data) throw new Error(`claim failed: ${error?.message}`);
  return data.map((r) => ({ id: r.occurrence_id, token: r.occurrence_claim_token }));
}

async function claimFor(party: Party) {
  const claimed = await claim();
  const rows = await occurrenceOf(party.id);
  const mine = claimed.find((c) => c.id === rows?.id);
  return mine ?? null;
}

type OccurrenceRow = {
  id: string;
  state: string;
  outcome_reason: string | null;
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: Date | null;
  first_attempt_at: Date | null;
  next_attempt_at: Date | null;
  sent_at: Date | null;
  due_at: Date;
};

async function occurrenceOf(partyId: string): Promise<OccurrenceRow | undefined> {
  const [row] = await sql<OccurrenceRow>(
    `select id, state, outcome_reason, attempt_count, claim_token, lease_expires_at, first_attempt_at,
            next_attempt_at, sent_at, due_at
     from public.automatic_rsvp_reminders where guest_invitation_id = $1`,
    [partyId],
  );
  return row;
}

async function prepare(c: { id: string; token: string }) {
  const { data, error } = await serviceRole.rpc("prepare_automatic_rsvp_reminder", {
    target_occurrence_id: c.id,
    occurrence_claim_token: c.token,
  });
  if (error || !data?.[0]) throw new Error(`prepare failed: ${error?.message}`);
  return data[0];
}

async function begin(c: { id: string; token: string }, hash: string, recipient: string) {
  const { data, error } = await serviceRole.rpc("begin_automatic_rsvp_reminder_send", {
    target_occurrence_id: c.id,
    occurrence_claim_token: c.token,
    expected_token_hash: hash,
    expected_recipient: recipient,
  });
  if (error || !data?.[0]) throw new Error(`begin failed: ${error?.message}`);
  return data[0];
}

function record(c: { id: string; token: string }, hash: string, recipient: string, providerId = `msg-auto-${randomUUID()}`) {
  return serviceRole.rpc("record_automatic_rsvp_reminder_email", {
    target_occurrence_id: c.id,
    occurrence_claim_token: c.token,
    invitation_token_hash: hash,
    recipient,
    provider_message_id: providerId,
  });
}

async function finish(
  c: { id: string; token: string },
  outcome: "link_unrecoverable" | "sent_unrecorded" | "retry" | "recipient_rejected" | "idempotency_conflict",
) {
  const { data, error } = await serviceRole.rpc("finish_automatic_rsvp_reminder", {
    target_occurrence_id: c.id,
    occurrence_claim_token: c.token,
    outcome,
  });
  if (error) throw new Error(`finish failed: ${error.message}`);
  return data;
}

/** Claim → prepare → begin for one party; returns its claim. */
async function toSending(party: Party, recipient = "familia@example.com") {
  const c = await claimFor(party);
  if (!c) throw new Error("not claimed");
  expect((await prepare(c)).status).toBe("ready");
  expect((await begin(c, party.hash, recipient)).status).toBe("sending");
  return c;
}

async function answer(party: Party) {
  const guests = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at",
    [party.id],
  );
  const { error } = await as.anon.rpc("submit_guest_rsvp", {
    invitation_token_hash: party.hash,
    responses: guests.map((g) => ({ guest_id: g.id, attending: true })),
  });
  if (error) throw new Error(`submit_guest_rsvp failed: ${error.message}`);
}

async function activityFor(partyId: string) {
  return sql<{ event_type: string; actor_kind: string; actor_user_id: string | null }>(
    "select event_type, actor_kind, actor_user_id from public.wedding_activity where guest_invitation_id = $1 order by occurred_at",
    [partyId],
  );
}

async function reminderMetadata(partyId: string) {
  const [row] = await sql<{ at: Date | null; to: string | null; provider: string | null }>(
    `select rsvp_reminder_email_sent_at as at, rsvp_reminder_email_sent_to as to,
            rsvp_reminder_email_provider_id as provider
     from public.guest_invitations where id = $1`,
    [partyId],
  );
  return row!;
}

/** Arranges an occurrence in any (legal) state, as ground truth. */
async function arrange(partyId: string, weddingId: string, values: Record<string, unknown>) {
  await sql("delete from public.automatic_rsvp_reminders where guest_invitation_id = $1", [partyId]);
  const columns = ["wedding_id", "guest_invitation_id", "due_at", ...Object.keys(values)];
  const params = [weddingId, partyId, new Date(), ...Object.values(values)];
  const [row] = await sql<{ id: string }>(
    `insert into public.automatic_rsvp_reminders (${columns.join(", ")})
     values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    params,
  );
  return row!.id;
}

// =========================================================== catalog

describe("schema and grants", () => {
  it("both tables have RLS; anon has nothing; members only SELECT (display columns of occurrences)", async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace
         and relname in ('wedding_rsvp_reminder_policies', 'automatic_rsvp_reminders') order by relname`,
    );
    expect(rls).toEqual([
      { relname: "automatic_rsvp_reminders", relrowsecurity: true },
      { relname: "wedding_rsvp_reminder_policies", relrowsecurity: true },
    ]);

    const tableGrants = await sql<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated')
         and table_name in ('wedding_rsvp_reminder_policies', 'automatic_rsvp_reminders')
       order by grantee, table_name, privilege_type`,
    );
    expect(tableGrants).toEqual([
      { grantee: "authenticated", table_name: "wedding_rsvp_reminder_policies", privilege_type: "SELECT" },
    ]);

    const columnGrants = await sql<{ grantee: string; column_name: string; privilege_type: string }>(
      `select grantee, column_name, privilege_type from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'automatic_rsvp_reminders'
         and grantee in ('anon', 'authenticated')
       order by column_name`,
    );
    expect(columnGrants.every((g) => g.grantee === "authenticated" && g.privilege_type === "SELECT")).toBe(true);
    expect(columnGrants.map((g) => g.column_name)).toEqual([
      "attempt_count",
      "created_at",
      "due_at",
      "guest_invitation_id",
      "id",
      "outcome_reason",
      "sent_at",
      "state",
      "updated_at",
      "wedding_id",
    ]);
  });

  it("the five scheduler functions are executable ONLY by service_role; the policy writer only by authenticated", async () => {
    for (const fn of SCHEDULER_FUNCTIONS) {
      const rows = await sql<{ role: string; can: boolean }>(
        `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
         from (values ('anon'), ('authenticated'), ('service_role')) as r (role) order by r.role`,
        [fn],
      );
      expect(rows, fn).toEqual([
        { role: "anon", can: false },
        { role: "authenticated", can: false },
        { role: "service_role", can: true },
      ]);
    }
    const policy = await sql<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
       from (values ('anon'), ('authenticated')) as r (role) order by r.role`,
      [POLICY_FUNCTION],
    );
    expect(policy).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: true },
    ]);
    const config = await sql<{ name: string; definer: boolean; config: string[] | null }>(
      `select p.oid::regprocedure::text as name, p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = any($1::regprocedure[])`,
      [[...SCHEDULER_FUNCTIONS, POLICY_FUNCTION]],
    );
    expect(config).toHaveLength(6);
    for (const fn of config) {
      expect(fn.definer, fn.name).toBe(true);
      expect(fn.config, fn.name).toEqual(['search_path=""']);
    }
  });

  it("clients calling a scheduler function get permission denied", async () => {
    for (const client of [as.anon, as.ownerA, as.collabA]) {
      const { error } = await client.rpc("claim_automatic_rsvp_reminders", { max_total: 50, max_per_wedding: 25 });
      expect(error?.code).toBe(PERMISSION_DENIED);
      const prepared = await client.rpc("prepare_automatic_rsvp_reminder", {
        target_occurrence_id: randomUUID(),
        occurrence_claim_token: randomUUID(),
      });
      expect(prepared.error?.code).toBe(PERMISSION_DENIED);
      const finished = await client.rpc("finish_automatic_rsvp_reminder", {
        target_occurrence_id: randomUUID(),
        occurrence_claim_token: randomUUID(),
        outcome: "retry",
      });
      expect(finished.error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("closed enums: exact states, outcome reasons and finish outcomes", async () => {
    const values = async (type: string) =>
      (
        await sql<{ v: string }>(
          `select e.enumlabel as v from pg_enum e where e.enumtypid = $1::regtype order by e.enumsortorder`,
          [type],
        )
      ).map((r) => r.v);
    expect(await values("public.automatic_rsvp_reminder_state")).toEqual([
      "claimed",
      "sending",
      "retry_wait",
      "sent",
      "sent_unrecorded",
      "skipped",
      "failed",
      "unknown",
    ]);
    expect(await values("public.automatic_rsvp_reminder_outcome_reason")).toEqual([
      "answered",
      "no_contact_email",
      "link_unavailable",
      "link_unrecoverable",
      "recently_reminded",
      "policy_disabled",
      "out_of_window",
      "recipient_undeliverable",
      "recipient_rejected",
      "ineligible_after_attempt",
      "idempotency_conflict",
      "attempts_exhausted",
      "replay_window_expired",
    ]);
    expect(await values("public.automatic_rsvp_reminder_finish_outcome")).toEqual([
      "link_unrecoverable",
      "sent_unrecorded",
      "retry",
      "recipient_rejected",
      "idempotency_conflict",
    ]);
  });

  it("the occurrence table stores no capability, recipient, provider id or content", async () => {
    const columns = await sql<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'automatic_rsvp_reminders' order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "attempt_count",
      "claim_token",
      "created_at",
      "due_at",
      "first_attempt_at",
      "guest_invitation_id",
      "id",
      "lease_expires_at",
      "next_attempt_at",
      "outcome_reason",
      "sent_at",
      "state",
      "updated_at",
      "wedding_id",
    ]);
    expect(columns.some((c) => c.data_type === "json" || c.data_type === "jsonb" || c.data_type === "text")).toBe(false);
  });

  it("zero backfill, default OFF: no policy row exists that the owner RPC didn't write; the default is disabled", async () => {
    const [{ orphans }] = await sql<{ orphans: string }>(
      "select count(*) as orphans from public.wedding_rsvp_reminder_policies where updated_by is null",
    );
    expect(Number(orphans)).toBe(0);
    const [column] = await sql<{ column_default: string }>(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'wedding_rsvp_reminder_policies' and column_name = 'enabled'`,
    );
    expect(column?.column_default).toBe("false");
    // A brand-new wedding has no policy at all (OFF).
    const weddingId = await fixtureWedding("ownerA", "Boda sin política");
    const rows = await sql("select 1 from public.wedding_rsvp_reminder_policies where wedding_id = $1", [weddingId]);
    expect(rows).toEqual([]);
  });
});

// ============================================================= policy

describe("set_rsvp_reminder_policy (owner only)", () => {
  it("an owner enables it (date + zone required); enabled_at and updated_by come from the database", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda política");
    const noDate = await as.ownerA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: true,
      reminder_days_before: 21,
    });
    expect(noDate.error?.message).toContain("rsvp_reminder_policy_needs_date");

    await sql("update public.weddings set wedding_date = '2090-06-01' where id = $1", [weddingId]);
    const noZone = await as.ownerA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: true,
      reminder_days_before: 21,
    });
    expect(noZone.error?.message).toContain("rsvp_reminder_policy_needs_date");

    await sql("update public.weddings set time_zone = 'America/Costa_Rica' where id = $1", [weddingId]);
    const before = Date.now();
    await enable(weddingId, 21);
    const [row] = await sql<{ enabled: boolean; days_before: number; enabled_at: Date; updated_by: string }>(
      "select enabled, days_before, enabled_at, updated_by from public.wedding_rsvp_reminder_policies where wedding_id = $1",
      [weddingId],
    );
    expect(row).toMatchObject({ enabled: true, days_before: 21, updated_by: users.ownerA.id });
    expect(row!.enabled_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // Disabling needs nothing; it keeps the old enabled_at.
    await sql("update public.weddings set wedding_date = null where id = $1", [weddingId]);
    const off = await as.ownerA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: false,
      reminder_days_before: 21,
    });
    expect(off.error).toBeNull();
    expect(off.data).toBe(true);
  });

  it("off → on resets enabled_at; changing days while on keeps it", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda reinicio");
    await sql("update public.weddings set wedding_date = '2090-06-01', time_zone = 'UTC' where id = $1", [weddingId]);
    await enable(weddingId, 21);
    await sql(
      "update public.wedding_rsvp_reminder_policies set enabled_at = '2000-01-01' where wedding_id = $1",
      [weddingId],
    );
    await enable(weddingId, 30);
    const kept = await sql<{ enabled_at: Date; days_before: number }>(
      "select enabled_at, days_before from public.wedding_rsvp_reminder_policies where wedding_id = $1",
      [weddingId],
    );
    expect(kept[0]!.enabled_at.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(kept[0]!.days_before).toBe(30);

    await as.ownerA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: false,
      reminder_days_before: 30,
    });
    await enable(weddingId, 30);
    const reset = await sql<{ enabled_at: Date }>(
      "select enabled_at from public.wedding_rsvp_reminder_policies where wedding_id = $1",
      [weddingId],
    );
    expect(reset[0]!.enabled_at.getFullYear()).toBeGreaterThan(2000);
  });

  it("a collaborator is refused, an outsider gets false, days outside 14/21/30 are invalid", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda colaboradora política");
    await addMember(weddingId, "collabA", "collaborator");
    await sql("update public.weddings set wedding_date = '2090-06-01', time_zone = 'UTC' where id = $1", [weddingId]);

    const collab = await as.collabA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: true,
      reminder_days_before: 21,
    });
    expect(collab.error?.code).toBe(PERMISSION_DENIED);
    expect(collab.error?.message).toContain("rsvp_reminder_policy_owner_only");

    const outsider = await as.outsider.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: true,
      reminder_days_before: 21,
    });
    expect(outsider.error).toBeNull();
    expect(outsider.data).toBe(false);

    for (const days of [0, 7, 15, 31, -14]) {
      const invalid = await as.ownerA.rpc("set_rsvp_reminder_policy", {
        target_wedding_id: weddingId,
        reminders_enabled: true,
        reminder_days_before: days,
      });
      expect(invalid.error?.code, String(days)).toBe("22023");
    }
    expect(await sql("select 1 from public.wedding_rsvp_reminder_policies where wedding_id = $1", [weddingId])).toEqual(
      [],
    );
  });

  it("nobody writes either table directly; members read, outsiders don't", async () => {
    const weddingId = await dueWedding("Boda RLS automática");
    await addMember(weddingId, "collabA", "collaborator");
    const party = await createParty(weddingId, "Familia RLS");
    await claimFor(party);

    const insert = await as.ownerA
      .from("wedding_rsvp_reminder_policies")
      .insert({ wedding_id: weddingId, enabled: true, days_before: 14 });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    const update = await as.ownerA
      .from("wedding_rsvp_reminder_policies")
      .update({ enabled: false })
      .eq("wedding_id", weddingId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const occurrenceUpdate = await as.ownerA
      .from("automatic_rsvp_reminders")
      .update({ state: "sent" })
      .eq("guest_invitation_id", party.id);
    expect(occurrenceUpdate.error?.code).toBe(PERMISSION_DENIED);

    for (const member of [as.ownerA, as.collabA]) {
      const policy = await member.from("wedding_rsvp_reminder_policies").select("enabled").eq("wedding_id", weddingId);
      expect(policy.data).toEqual([{ enabled: true }]);
      const occurrence = await member
        .from("automatic_rsvp_reminders")
        .select("state, outcome_reason, attempt_count")
        .eq("guest_invitation_id", party.id);
      expect(occurrence.data).toEqual([{ state: "claimed", outcome_reason: null, attempt_count: 0 }]);
      const token = await member.from("automatic_rsvp_reminders").select("claim_token").eq("guest_invitation_id", party.id);
      expect(token.error?.code).toBe(PERMISSION_DENIED);
    }
    const outsiderPolicy = await as.outsider.from("wedding_rsvp_reminder_policies").select("enabled").eq("wedding_id", weddingId);
    expect(outsiderPolicy.data).toEqual([]);
    const outsiderOccurrence = await as.outsider
      .from("automatic_rsvp_reminders")
      .select("state")
      .eq("guest_invitation_id", party.id);
    expect(outsiderOccurrence.data).toEqual([]);
  });
});

// ================================================== occurrence model

describe("occurrence invariants (CHECK, UNIQUE, FK)", () => {
  it("rejects every illegal state / outcome_reason / attempt_count combination", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda invariantes");
    const party = await createParty(weddingId, "Familia Invariantes");
    const lease = { claim_token: randomUUID(), lease_expires_at: new Date(Date.now() + 600_000) };
    const past = new Date(Date.now() - 60_000);
    const illegal: Array<[string, Record<string, unknown>]> = [
      ["sent with a reason", { state: "sent", attempt_count: 1, first_attempt_at: past, sent_at: past, outcome_reason: "answered" }],
      ["sent without sent_at", { state: "sent", attempt_count: 1, first_attempt_at: past }],
      ["skipped after an attempt", { state: "skipped", attempt_count: 1, first_attempt_at: past, outcome_reason: "no_contact_email" }],
      ["skipped without a reason", { state: "skipped" }],
      ["skipped with a provider reason", { state: "skipped", outcome_reason: "recipient_rejected" }],
      ["failed with a pre-provider reason", { state: "failed", attempt_count: 1, first_attempt_at: past, outcome_reason: "answered" }],
      ["failed before any attempt", { state: "failed", outcome_reason: "recipient_rejected" }],
      ["unknown before any attempt", { state: "unknown", outcome_reason: "attempts_exhausted" }],
      ["unknown with a pre-provider reason", { state: "unknown", attempt_count: 1, first_attempt_at: past, outcome_reason: "answered" }],
      ["claimed without a lease", { state: "claimed" }],
      ["claimed with a reason", { state: "claimed", outcome_reason: "answered", ...lease }],
      ["claimed with 3 attempts", { state: "claimed", attempt_count: 3, first_attempt_at: past, ...lease }],
      ["sending with no attempt", { state: "sending", ...lease }],
      ["sending without a lease", { state: "sending", attempt_count: 1, first_attempt_at: past }],
      ["retry_wait without next_attempt_at", { state: "retry_wait", attempt_count: 1, first_attempt_at: past }],
      ["retry_wait at 3 attempts", { state: "retry_wait", attempt_count: 3, first_attempt_at: past, next_attempt_at: past }],
      ["retry_wait holding a lease", { state: "retry_wait", attempt_count: 1, first_attempt_at: past, next_attempt_at: past, ...lease }],
      ["attempts without first_attempt_at", { state: "sent_unrecorded", attempt_count: 1 }],
      ["4 attempts", { state: "unknown", attempt_count: 4, first_attempt_at: past, outcome_reason: "attempts_exhausted" }],
      ["sent_unrecorded with a reason", { state: "sent_unrecorded", attempt_count: 1, first_attempt_at: past, outcome_reason: "idempotency_conflict" }],
    ];
    for (const [label, values] of illegal) {
      await expect(arrange(party.id, weddingId, values), label).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    // And the legal shapes are accepted.
    const legal: Array<Record<string, unknown>> = [
      { state: "claimed", ...lease },
      { state: "claimed", attempt_count: 2, first_attempt_at: past, ...lease },
      { state: "sending", attempt_count: 3, first_attempt_at: past, ...lease },
      { state: "retry_wait", attempt_count: 2, first_attempt_at: past, next_attempt_at: past },
      { state: "sent", attempt_count: 1, first_attempt_at: past, sent_at: past },
      { state: "sent_unrecorded", attempt_count: 1, first_attempt_at: past },
      { state: "skipped", outcome_reason: "out_of_window" },
      { state: "failed", attempt_count: 2, first_attempt_at: past, outcome_reason: "recipient_rejected" },
      { state: "unknown", attempt_count: 1, first_attempt_at: past, outcome_reason: "replay_window_expired" },
    ];
    for (const values of legal) {
      await expect(arrange(party.id, weddingId, values)).resolves.toBeTruthy();
    }
  });

  it("one occurrence per party, ever; same-wedding FK; deleting the party deletes it (history stays)", async () => {
    const weddingId = await dueWedding("Boda única");
    const otherWedding = await fixtureWedding("ownerB", "Boda ajena");
    const party = await createParty(weddingId, "Familia Única");
    await arrange(party.id, weddingId, { state: "skipped", outcome_reason: "answered" });
    await expect(
      sql(
        `insert into public.automatic_rsvp_reminders (wedding_id, guest_invitation_id, state, due_at, outcome_reason)
         values ($1, $2, 'skipped', now(), 'answered')`,
        [weddingId, party.id],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await sql("delete from public.automatic_rsvp_reminders where guest_invitation_id = $1", [party.id]);
    await expect(
      sql(
        `insert into public.automatic_rsvp_reminders (wedding_id, guest_invitation_id, state, due_at, outcome_reason)
         values ($1, $2, 'skipped', now(), 'answered')`,
        [otherWedding, party.id],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION });

    const c = await toSending(party);
    expect((await record(c, party.hash, "familia@example.com")).error).toBeNull();
    await sql("delete from public.guest_invitations where id = $1", [party.id]);
    expect(await occurrenceOf(party.id)).toBeUndefined();
    const history = await sql(
      "select 1 from public.wedding_activity where wedding_id = $1 and event_type = 'rsvp_reminder_email_sent' and actor_kind = 'system'",
      [weddingId],
    );
    expect(history).toHaveLength(1);
  });
});

// ============================================================== claim

describe("claim", () => {
  it("claims a due, eligible party: claimed, attempt 0, fresh token, 10-minute lease; returns only id + token", async () => {
    const weddingId = await dueWedding("Boda reclamar");
    const party = await createParty(weddingId, "Familia Debida");
    const { data, error } = await serviceRole.rpc("claim_automatic_rsvp_reminders", { max_total: 50, max_per_wedding: 25 });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(Object.keys(data![0]!).sort()).toEqual(["occurrence_claim_token", "occurrence_id"]);
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "claimed", attempt_count: 0, outcome_reason: null, first_attempt_at: null });
    expect(row!.claim_token).toBe(data![0]!.occurrence_claim_token);
    const leaseMs = row!.lease_expires_at!.getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(8 * 60_000);
    expect(leaseMs).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    // The live lease is never claimed again.
    expect(await claim()).toEqual([]);
  });

  it("due_at is 10:00 wedding-local, days_before days before, in the wedding's own zone", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda zona");
    await sql("update public.weddings set wedding_date = '2090-03-31', time_zone = 'Europe/Madrid' where id = $1", [
      weddingId,
    ]);
    const [{ due }] = await sql<{ due: Date }>(
      "select private.automatic_rsvp_reminder_due_at(w.wedding_date, w.time_zone, 21::smallint) as due from public.weddings w where w.id = $1",
      [weddingId],
    );
    // 2090-03-10 10:00 in Madrid (CET, UTC+1, before the DST change).
    expect(due.toISOString()).toBe("2090-03-10T09:00:00.000Z");
    const [{ dueSummer }] = await sql<{ dueSummer: Date }>(
      `select private.automatic_rsvp_reminder_due_at('2090-07-31', 'America/Mexico_City', 14::smallint) as "dueSummer"`,
    );
    expect(dueSummer.toISOString()).toBe("2090-07-17T16:00:00.000Z");
    const nulls = await sql<{ a: Date | null; b: Date | null }>(
      `select private.automatic_rsvp_reminder_due_at(null, 'UTC', 14::smallint) as a,
              private.automatic_rsvp_reminder_due_at('2090-07-31', null, 14::smallint) as b`,
    );
    expect(nulls[0]).toEqual({ a: null, b: null });
  });

  it("never claims: policy off, no date, no zone, before the window, after it, or due before enabled_at", async () => {
    const weddingId = await dueWedding("Boda no debida");
    const party = await createParty(weddingId, "Familia Espera");

    const cases: Array<[string, string]> = [
      ["policy off", "update public.wedding_rsvp_reminder_policies set enabled = false where wedding_id = $1"],
      ["no date", "update public.weddings set wedding_date = null where id = $1"],
      ["no zone", "update public.weddings set time_zone = null where id = $1"],
      ["before the window", "update public.weddings set wedding_date = current_date + 40 where id = $1"],
      ["after the window", "update public.weddings set wedding_date = current_date + 11 where id = $1"],
      [
        "due before enabled_at",
        "update public.wedding_rsvp_reminder_policies set enabled_at = now() where wedding_id = $1",
      ],
    ];
    for (const [label, change] of cases) {
      await sql("delete from public.automatic_rsvp_reminders");
      await sql(
        `update public.weddings set time_zone = 'UTC',
           wedding_date = ((now() at time zone 'UTC') - interval '10 hours')::date + 14 where id = $1`,
        [weddingId],
      );
      await sql(
        "update public.wedding_rsvp_reminder_policies set enabled = true, enabled_at = now() - interval '30 days' where wedding_id = $1",
        [weddingId],
      );
      await sql(change, [weddingId]);
      expect(await claim(), label).toEqual([]);
      expect(await occurrenceOf(party.id), label).toBeUndefined();
    }
  });

  it("never claims an ineligible due party; it records why (skipped, no attempt) for organizers", async () => {
    const weddingId = await dueWedding("Boda inelegible");
    const answered = await createParty(weddingId, "Ya respondió");
    await answer(answered);
    const noEmail = await createParty(weddingId, "Sin correo", null);
    const revoked = await createParty(weddingId, "Revocado");
    await as.ownerA.rpc("revoke_guest_invitation_link", { target_wedding_id: weddingId, target_invitation_id: revoked.id });
    const legacy = await createParty(weddingId, "Legado");
    await sql("delete from private.guest_invitation_capability_secrets where guest_invitation_id = $1", [legacy.id]);
    const reminded = await createParty(weddingId, "Recordado");
    await sql(
      `update public.guest_invitations set rsvp_reminder_email_sent_at = now() - interval '6 days',
         rsvp_reminder_email_sent_to = contact_email, rsvp_reminder_email_provider_id = 'manual-1' where id = $1`,
      [reminded.id],
    );
    const invited = await createParty(weddingId, "Invitado hace poco");
    await sql(
      `update public.guest_invitations set invitation_email_sent_at = now() - interval '1 day',
         invitation_email_sent_to = contact_email, invitation_email_provider_id = 'inv-1' where id = $1`,
      [invited.id],
    );
    // Older than 7 days: no longer suppresses.
    const longAgo = await createParty(weddingId, "Recordado hace mucho");
    await sql(
      `update public.guest_invitations set rsvp_reminder_email_sent_at = now() - interval '8 days',
         rsvp_reminder_email_sent_to = contact_email, rsvp_reminder_email_provider_id = 'manual-0' where id = $1`,
      [longAgo.id],
    );
    const eligible = await createParty(weddingId, "Elegible");

    const claimed = await claim();
    expect(claimed).toHaveLength(2);
    expect((await occurrenceOf(eligible.id))?.state).toBe("claimed");
    expect((await occurrenceOf(longAgo.id))?.state).toBe("claimed");
    const expected: Array<[Party, string]> = [
      [answered, "answered"],
      [noEmail, "no_contact_email"],
      [revoked, "link_unavailable"],
      [legacy, "link_unrecoverable"],
      [reminded, "recently_reminded"],
      [invited, "recently_reminded"],
    ];
    for (const [p, reason] of expected) {
      expect(await occurrenceOf(p.id), reason).toMatchObject({
        state: "skipped",
        outcome_reason: reason,
        attempt_count: 0,
        claim_token: null,
        lease_expires_at: null,
      });
    }
    // Nothing is recorded for parties that aren't due.
    const notDue = await fixtureWedding("ownerA", "Boda futura");
    await sql("update public.weddings set wedding_date = current_date + 60, time_zone = 'UTC' where id = $1", [notDue]);
    await enable(notDue, 14);
    const future = await createParty(notDue, "Futuro", null);
    await claim();
    expect(await occurrenceOf(future.id)).toBeUndefined();
  });

  it("caps: at most max_per_wedding per wedding and max_total per run; both clamped to 25 and 50", async () => {
    const weddingA = await dueWedding("Boda tope A");
    const weddingB = await dueWedding("Boda tope B");
    for (let i = 0; i < 3; i += 1) await createParty(weddingA, `A ${i}`);
    await createParty(weddingB, "B 0");
    const first = await claim(2, 1);
    expect(first).toHaveLength(2);
    const perWedding = await sql<{ wedding_id: string; n: string }>(
      "select wedding_id, count(*) as n from public.automatic_rsvp_reminders group by wedding_id",
    );
    expect(perWedding.map((r) => Number(r.n))).toEqual([1, 1]);
    expect(await claim(0, 25)).toEqual([]);

    // 27 more parties in one wedding: one call claims at most 25 of them.
    const weddingC = await dueWedding("Boda tope C");
    await sql(
      `with parties as (
         insert into public.guest_invitations (wedding_id, label, token_hash, contact_email, created_by)
         select $1, 'Masivo ' || g, encode(sha256(convert_to('masivo-' || g || $2, 'UTF8')), 'hex'), 'masivo@example.com', $3
         from generate_series(1, 27) g
         returning id, wedding_id, token_hash
       ), guests as (
         insert into public.guests (guest_invitation_id, wedding_id, name)
         select id, wedding_id, 'Invitado' from parties
       )
       insert into private.guest_invitation_capability_secrets (guest_invitation_id, wedding_id, token_hash, token_ciphertext)
       select id, wedding_id, token_hash, $4 from parties`,
      [weddingC, randomUUID(), users.ownerA.id, shapedEnvelope()],
    );
    const bulk = await claim(1000, 1000);
    const inC = await sql<{ n: string }>(
      "select count(*) as n from public.automatic_rsvp_reminders where wedding_id = $1",
      [weddingC],
    );
    expect(Number(inC[0]!.n)).toBe(25);
    expect(bulk.length).toBeLessThanOrEqual(50);
  });

  it("SKIP LOCKED: a party locked by an in-flight RSVP waits for the next run; concurrent claims never share a row", async () => {
    const weddingId = await dueWedding("Boda bloqueo");
    const locked = await createParty(weddingId, "Bloqueada");
    const free = await Promise.all([1, 2, 3, 4].map((i) => createParty(weddingId, `Libre ${i}`)));

    const holder = await superuser.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.guest_invitations where id = $1 for update", [locked.id]);
      const [a, b] = await Promise.all([claim(), claim()]);
      const ids = [...a, ...b].map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(free.length);
      expect(await occurrenceOf(locked.id)).toBeUndefined();
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    const next = await claim();
    expect(next).toHaveLength(1);
    expect((await occurrenceOf(locked.id))?.state).toBe("claimed");
  });

  it("reclaims an expired claim with a fresh token (the old worker is stale); never a live one", async () => {
    const weddingId = await dueWedding("Boda arrendamiento");
    const party = await createParty(weddingId, "Familia Arriendo");
    const first = (await claimFor(party))!;
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where id = $1", [
      first.id,
    ]);
    const second = (await claimFor(party))!;
    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect((await occurrenceOf(party.id))?.attempt_count).toBe(0);
    expect((await prepare(first)).status).toBe("stale");
    expect((await prepare(second)).status).toBe("ready");
  });
});

// ============================================================ prepare

describe("prepare", () => {
  it("returns CURRENT capability and render context; consumes no attempt; renews the lease", async () => {
    const weddingId = await dueWedding("Boda preparar");
    await sql("update public.weddings set city = 'Ciudad Ejemplo' where id = $1", [weddingId]);
    const party = await createParty(weddingId, "Familia Prepara");
    const c = (await claimFor(party))!;
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() + interval '1 minute' where id = $1", [c.id]);
    const ready = await prepare(c);
    const [secret] = await sql<{ token_ciphertext: string }>(
      "select token_ciphertext from private.guest_invitation_capability_secrets where guest_invitation_id = $1",
      [party.id],
    );
    const [wedding] = await sql<{ name: string; wedding_date: string }>(
      "select name, wedding_date::text from public.weddings where id = $1",
      [weddingId],
    );
    expect(ready).toEqual({
      status: "ready",
      current_token_hash: party.hash,
      current_token_ciphertext: secret!.token_ciphertext,
      current_recipient: "familia@example.com",
      current_party_label: "Familia Prepara",
      current_wedding_name: wedding!.name,
      current_wedding_date: wedding!.wedding_date,
      current_wedding_city: "Ciudad Ejemplo",
      current_site_slug: null,
    });
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "claimed", attempt_count: 0, first_attempt_at: null });
    expect(row!.lease_expires_at!.getTime() - Date.now()).toBeGreaterThan(8 * 60_000);

    // The slug only while published.
    await sql("insert into public.wedding_publications (wedding_id, slug, published_at) values ($1, $2, now())", [
      weddingId,
      `boda-auto-${randomBytes(4).toString("hex")}`,
    ]);
    expect((await prepare(c)).current_site_slug).toMatch(/^boda-auto-/);
  });

  it("refuses a stale token, an expired lease or a non-claimed row", async () => {
    const weddingId = await dueWedding("Boda obsoleta");
    const party = await createParty(weddingId, "Familia Obsoleta");
    const c = (await claimFor(party))!;
    expect((await prepare({ id: c.id, token: randomUUID() })).status).toBe("stale");
    expect((await prepare({ id: randomUUID(), token: c.token })).status).toBe("stale");
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where id = $1", [c.id]);
    expect((await prepare(c)).status).toBe("stale");
  });

  it("ineligible before any attempt → skipped (reason); after an attempt → unknown (ineligible_after_attempt)", async () => {
    const weddingId = await dueWedding("Boda prepara inelegible");
    const party = await createParty(weddingId, "Familia Responde");
    const c = (await claimFor(party))!;
    await answer(party);
    expect((await prepare(c)).status).toBe("skipped");
    expect(await occurrenceOf(party.id)).toMatchObject({
      state: "skipped",
      outcome_reason: "answered",
      attempt_count: 0,
      claim_token: null,
      lease_expires_at: null,
    });

    const other = await createParty(weddingId, "Familia Intento");
    const c2 = await toSending(other);
    await finish(c2, "retry");
    await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where id = $1", [c2.id]);
    const reclaimed = (await claimFor(other))!;
    await sql("update public.guest_invitations set contact_email = null where id = $1", [other.id]);
    expect((await prepare(reclaimed)).status).toBe("unknown");
    expect(await occurrenceOf(other.id)).toMatchObject({
      state: "unknown",
      outcome_reason: "ineligible_after_attempt",
      attempt_count: 1,
    });
  });
});

// ============================================================== begin

describe("begin (the provider boundary)", () => {
  it("claimed → sending, attempt_count + 1 and first_attempt_at exactly here; once", async () => {
    const weddingId = await dueWedding("Boda comenzar");
    const party = await createParty(weddingId, "Familia Comienza");
    const c = (await claimFor(party))!;
    expect((await occurrenceOf(party.id))?.attempt_count).toBe(0);
    await prepare(c);
    expect((await occurrenceOf(party.id))?.attempt_count).toBe(0);
    const begun = await begin(c, party.hash, "familia@example.com");
    expect(begun).toEqual({ status: "sending", attempt_number: 1 });
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "sending", attempt_count: 1 });
    expect(row!.first_attempt_at).not.toBeNull();
    // A second begin for the same claim authorizes nothing more.
    expect((await begin(c, party.hash, "familia@example.com")).status).toBe("stale");
    expect((await occurrenceOf(party.id))?.attempt_count).toBe(1);
  });

  it("an RSVP that lands after prepare stops the send (skipped, answered), waiting for the RSVP's lock", async () => {
    const weddingId = await dueWedding("Boda carrera RSVP");
    const party = await createParty(weddingId, "Familia Carrera");
    const c = (await claimFor(party))!;
    expect((await prepare(c)).status).toBe("ready");

    const guests = await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [party.id]);
    const rsvp = await superuser.connect();
    try {
      await rsvp.query("begin");
      await rsvp.query("select 1 from public.guest_invitations where id = $1 for update", [party.id]);
      const pending = begin(c, party.hash, "familia@example.com");
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const g of guests) {
        await rsvp.query("insert into public.rsvps (guest_id, wedding_id, attending) values ($1, $2, true)", [g.id, weddingId]);
      }
      await rsvp.query("commit");
      expect((await pending).status).toBe("skipped");
    } finally {
      rsvp.release();
    }
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "answered", attempt_count: 0 });
  });

  it("a rotated link or a changed recipient since prepare: context_changed, nothing consumed, lease released", async () => {
    const weddingId = await dueWedding("Boda contexto");
    const party = await createParty(weddingId, "Familia Contexto");
    const c = (await claimFor(party))!;
    await prepare(c);
    const rotated = newToken();
    const { error } = await as.ownerA.rpc("rotate_guest_invitation_link", {
      target_wedding_id: weddingId,
      target_invitation_id: party.id,
      invitation_token_hash: rotated.hash,
      invitation_token_ciphertext: shapedEnvelope(),
    });
    expect(error).toBeNull();
    expect((await begin(c, party.hash, "familia@example.com")).status).toBe("context_changed");
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "claimed", attempt_count: 0 });
    expect(row!.lease_expires_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // Next run: prepared again from current truth, the NEW link.
    const again = (await claimFor(party))!;
    expect((await prepare(again)).current_token_hash).toBe(rotated.hash);
    await sql("update public.guest_invitations set contact_email = 'nuevo@example.com' where id = $1", [party.id]);
    expect((await begin(again, rotated.hash, "familia@example.com")).status).toBe("context_changed");
    expect((await occurrenceOf(party.id))?.attempt_count).toBe(0);
  });

  it("revoked, recently reminded or policy disabled since prepare → skipped with that reason", async () => {
    const weddingId = await dueWedding("Boda revocada después");
    const cases: Array<[string, (p: Party) => PromiseLike<unknown>]> = [
      [
        "link_unavailable",
        (p) => as.ownerA.rpc("revoke_guest_invitation_link", { target_wedding_id: weddingId, target_invitation_id: p.id }),
      ],
      [
        "recently_reminded",
        (p) =>
          sql(
            `update public.guest_invitations set rsvp_reminder_email_sent_at = now(),
               rsvp_reminder_email_sent_to = contact_email, rsvp_reminder_email_provider_id = 'manual-2' where id = $1`,
            [p.id],
          ),
      ],
      [
        "policy_disabled",
        () =>
          as.ownerA.rpc("set_rsvp_reminder_policy", {
            target_wedding_id: weddingId,
            reminders_enabled: false,
            reminder_days_before: 14,
          }),
      ],
    ];
    for (const [reason, change] of cases) {
      await sql(
        "update public.wedding_rsvp_reminder_policies set enabled = true, enabled_at = now() - interval '30 days' where wedding_id = $1",
        [weddingId],
      );
      const party = await createParty(weddingId, `Familia ${reason}`);
      const c = (await claimFor(party))!;
      await prepare(c);
      await change(party);
      expect((await begin(c, party.hash, "familia@example.com")).status, reason).toBe("skipped");
      expect(await occurrenceOf(party.id), reason).toMatchObject({ state: "skipped", outcome_reason: reason });
    }
  });

  it("23 h after the first attempt, begin refuses: unknown (replay_window_expired)", async () => {
    const weddingId = await dueWedding("Boda ventana");
    const party = await createParty(weddingId, "Familia Ventana");
    const c = await toSending(party);
    await finish(c, "retry");
    await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where id = $1", [c.id]);
    const again = (await claimFor(party))!;
    await prepare(again);
    await sql("update public.automatic_rsvp_reminders set first_attempt_at = now() - interval '23 hours 1 minute' where id = $1", [
      c.id,
    ]);
    expect((await begin(again, party.hash, "familia@example.com")).status).toBe("unknown");
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "unknown", outcome_reason: "replay_window_expired", attempt_count: 1 });
  });
});

// ============================================================= record

describe("record", () => {
  it("atomically: latest-reminder metadata, a SYSTEM activity row (no user id), the ledger row, sending → sent", async () => {
    const weddingId = await dueWedding("Boda registrar");
    const party = await createParty(weddingId, "Familia Registra");
    const c = await toSending(party);
    const providerId = `msg-auto-ok-${randomUUID()}`;
    const { data, error } = await record(c, party.hash, "familia@example.com", providerId);
    expect(error).toBeNull();
    const meta = await reminderMetadata(party.id);
    expect(meta).toMatchObject({ to: "familia@example.com", provider: providerId });
    // LB-18.1 (ADR-011): exactly one AUTOMATIC ledger row, same transaction and clock.
    expect(await emailDeliveriesFor(party.id)).toEqual([
      {
        wedding_id: weddingId,
        guest_invitation_id: party.id,
        kind: "rsvp_reminder_automatic",
        provider_message_id: providerId,
        recipient: "familia@example.com",
        accepted_at: meta.at,
      },
    ]);
    expect(meta.at?.toISOString()).toBe(new Date(data!).toISOString());
    expect(await activityFor(party.id)).toContainEqual({
      event_type: "rsvp_reminder_email_sent",
      actor_kind: "system",
      actor_user_id: null,
    });
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "sent", attempt_count: 1, claim_token: null, lease_expires_at: null });
    expect(row!.sent_at?.toISOString()).toBe(meta.at?.toISOString());
    // A sent occurrence is never claimed again.
    expect(await claim()).toEqual([]);
  });

  it("refuses (changing nothing) a stale token, a non-sending row, a changed recipient or link, a bad provider id", async () => {
    const weddingId = await dueWedding("Boda no registrar");
    const party = await createParty(weddingId, "Familia NoRegistra");
    const c = (await claimFor(party))!;
    await prepare(c);
    // Not sending yet.
    expect((await record(c, party.hash, "familia@example.com")).error).not.toBeNull();
    await begin(c, party.hash, "familia@example.com");

    expect((await record({ id: c.id, token: randomUUID() }, party.hash, "familia@example.com")).error).not.toBeNull();
    expect((await record(c, party.hash, "familia@example.com", "bad id with spaces")).error).not.toBeNull();
    await sql("update public.guest_invitations set contact_email = 'otra@example.com' where id = $1", [party.id]);
    expect((await record(c, party.hash, "familia@example.com")).error).not.toBeNull();
    await sql("update public.guest_invitations set contact_email = 'familia@example.com' where id = $1", [party.id]);
    expect((await record(c, newToken().hash, "familia@example.com")).error).not.toBeNull();

    expect(await reminderMetadata(party.id)).toEqual({ at: null, to: null, provider: null });
    expect((await activityFor(party.id)).filter((a) => a.event_type === "rsvp_reminder_email_sent")).toEqual([]);
    expect((await occurrenceOf(party.id))?.state).toBe("sending");
    // LB-18.1: no orphan ledger row for a send that couldn't be recorded.
    expect(await emailDeliveriesFor(party.id)).toEqual([]);

    // The runner then reports it: sent_unrecorded, terminal, never claimed again.
    expect(await finish(c, "sent_unrecorded")).toBe("sent_unrecorded");
    expect(await claim()).toEqual([]);
    expect((await occurrenceOf(party.id))?.state).toBe("sent_unrecorded");
    expect(await emailDeliveriesFor(party.id)).toEqual([]);
  });
});

// ============================================================= finish

describe("finish", () => {
  it("retry → retry_wait in 1 h; the third attempt → attempts_exhausted; past 23 h → replay_window_expired", async () => {
    const weddingId = await dueWedding("Boda reintento");
    const party = await createParty(weddingId, "Familia Reintento");
    let c = await toSending(party);
    expect(await finish(c, "retry")).toBe("retry_wait");
    const row = await occurrenceOf(party.id);
    expect(row).toMatchObject({ state: "retry_wait", attempt_count: 1, claim_token: null });
    const wait = row!.next_attempt_at!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(55 * 60_000);
    // Not due yet: not reclaimed.
    expect(await claim()).toEqual([]);

    for (const attempt of [2, 3]) {
      await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where id = $1", [c.id]);
      c = (await claimFor(party))!;
      expect((await occurrenceOf(party.id))?.attempt_count).toBe(attempt - 1);
      await prepare(c);
      expect((await begin(c, party.hash, "familia@example.com")).attempt_number).toBe(attempt);
      const state = await finish(c, "retry");
      expect(state).toBe(attempt < 3 ? "retry_wait" : "unknown");
    }
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "unknown", outcome_reason: "attempts_exhausted", attempt_count: 3 });

    const late = await createParty(weddingId, "Familia Tarde");
    const lc = await toSending(late);
    await sql("update public.automatic_rsvp_reminders set first_attempt_at = now() - interval '23 hours 1 minute' where id = $1", [
      lc.id,
    ]);
    expect(await finish(lc, "retry")).toBe("unknown");
    expect(await occurrenceOf(late.id)).toMatchObject({ outcome_reason: "replay_window_expired" });
  });

  it("recipient_rejected → failed; idempotency_conflict → unknown; sent_unrecorded → sent_unrecorded", async () => {
    const weddingId = await dueWedding("Boda finales");
    const expected: Array<[Parameters<typeof finish>[1], string, string | null]> = [
      ["recipient_rejected", "failed", "recipient_rejected"],
      ["idempotency_conflict", "unknown", "idempotency_conflict"],
      ["sent_unrecorded", "sent_unrecorded", null],
    ];
    for (const [outcome, state, reason] of expected) {
      const party = await createParty(weddingId, `Familia ${outcome}`);
      const c = await toSending(party);
      expect(await finish(c, outcome)).toBe(state);
      expect(await occurrenceOf(party.id)).toMatchObject({ state, outcome_reason: reason, claim_token: null });
    }
  });

  it("link_unrecoverable (decryption failed before the provider): skipped with no attempt, unknown after one", async () => {
    const weddingId = await dueWedding("Boda descifrar");
    const party = await createParty(weddingId, "Familia Descifra");
    const c = (await claimFor(party))!;
    await prepare(c);
    expect(await finish(c, "link_unrecoverable")).toBe("skipped");
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "link_unrecoverable", attempt_count: 0 });

    const other = await createParty(weddingId, "Familia Descifra Dos");
    const s = await toSending(other);
    // Not legal from sending (the boundary was crossed).
    expect(await finish(s, "link_unrecoverable")).toBeNull();
    expect((await occurrenceOf(other.id))?.state).toBe("sending");
    await finish(s, "retry");
    await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where id = $1", [s.id]);
    const again = (await claimFor(other))!;
    await prepare(again);
    expect(await finish(again, "link_unrecoverable")).toBe("unknown");
    expect(await occurrenceOf(other.id)).toMatchObject({ outcome_reason: "ineligible_after_attempt" });
  });

  it("a stale worker changes nothing", async () => {
    const weddingId = await dueWedding("Boda trabajador viejo");
    const party = await createParty(weddingId, "Familia Vieja");
    const c = await toSending(party);
    expect(await finish({ id: c.id, token: randomUUID() }, "sent_unrecorded")).toBeNull();
    expect((await occurrenceOf(party.id))?.state).toBe("sending");
  });
});

// ======================================================= sweep / reclaim

describe("sweep and reclaim of in-flight rows", () => {
  it("an expired send inside the window is reclaimed (same row, attempt unchanged); past it → unknown; a live lease is never swept", async () => {
    const weddingId = await dueWedding("Boda barrido");
    const crashed = await createParty(weddingId, "Familia Caída");
    const c = await toSending(crashed);
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where id = $1", [c.id]);
    const again = (await claimFor(crashed))!;
    expect(again.id).toBe(c.id);
    expect(await occurrenceOf(crashed.id)).toMatchObject({ state: "claimed", attempt_count: 1 });

    const old = await createParty(weddingId, "Familia Antigua");
    const oc = await toSending(old);
    await sql(
      "update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second', first_attempt_at = now() - interval '24 hours' where id = $1",
      [oc.id],
    );
    const live = await createParty(weddingId, "Familia Viva");
    const lc = await toSending(live);
    await sql("update public.automatic_rsvp_reminders set first_attempt_at = now() - interval '24 hours' where id = $1", [lc.id]);
    const exhausted = await createParty(weddingId, "Familia Agotada");
    const ec = await toSending(exhausted);
    await sql(
      "update public.automatic_rsvp_reminders set attempt_count = 3, lease_expires_at = now() - interval '1 second' where id = $1",
      [ec.id],
    );
    const waiting = await createParty(weddingId, "Familia Esperando");
    const wc = await toSending(waiting);
    await finish(wc, "retry");
    await sql("update public.automatic_rsvp_reminders set first_attempt_at = now() - interval '24 hours' where id = $1", [wc.id]);

    await claim();
    expect(await occurrenceOf(old.id)).toMatchObject({ state: "unknown", outcome_reason: "replay_window_expired" });
    expect(await occurrenceOf(exhausted.id)).toMatchObject({ state: "unknown", outcome_reason: "attempts_exhausted" });
    expect(await occurrenceOf(waiting.id)).toMatchObject({ state: "unknown", outcome_reason: "replay_window_expired" });
    // The live lease is its worker's to decide.
    expect(await occurrenceOf(live.id)).toMatchObject({ state: "sending", claim_token: lc.token });
  });

  it("terminal states are never claimed again (sent, sent_unrecorded, failed, unknown)", async () => {
    const weddingId = await dueWedding("Boda terminal");
    const past = new Date(Date.now() - 60_000);
    const terminal: Array<Record<string, unknown>> = [
      { state: "sent", attempt_count: 1, first_attempt_at: past, sent_at: past },
      { state: "sent_unrecorded", attempt_count: 1, first_attempt_at: past },
      { state: "failed", attempt_count: 1, first_attempt_at: past, outcome_reason: "recipient_rejected" },
      { state: "unknown", attempt_count: 1, first_attempt_at: past, outcome_reason: "idempotency_conflict" },
      { state: "unknown", attempt_count: 2, first_attempt_at: past, outcome_reason: "attempts_exhausted" },
    ];
    const parties: Party[] = [];
    for (const [i, values] of terminal.entries()) {
      const party = await createParty(weddingId, `Terminal ${i}`);
      await arrange(party.id, weddingId, values);
      parties.push(party);
    }
    expect(await claim()).toEqual([]);
    for (const [i, party] of parties.entries()) {
      expect((await occurrenceOf(party.id))?.state).toBe(terminal[i]!.state);
    }
  });
});

// ========================================================= reactivation

describe("reactivation matrix (skipped, attempt_count = 0)", () => {
  it.each([
    ["no_contact_email", true],
    ["link_unrecoverable", true],
    ["link_unavailable", true],
    ["policy_disabled", true],
    ["out_of_window", true],
    ["recipient_undeliverable", true],
    ["recently_reminded", false],
    ["answered", false],
  ] as const)("%s → reactivatable: %s (when every current check passes)", async (reason, reactivatable) => {
    const weddingId = await dueWedding(`Boda reactivar ${reason}`);
    const party = await createParty(weddingId, `Familia ${reason}`);
    const id = await arrange(party.id, weddingId, { state: "skipped", outcome_reason: reason });
    const claimed = await claim();
    expect(claimed.map((c) => c.id)).toEqual(reactivatable ? [id] : []);
    const row = await occurrenceOf(party.id);
    if (reactivatable) {
      // The same row, fresh token and lease, no attempt consumed.
      expect(row).toMatchObject({ id, state: "claimed", outcome_reason: null, attempt_count: 0 });
    } else {
      expect(row).toMatchObject({ id, state: "skipped", outcome_reason: reason });
    }
  });

  it("a remediable skip stays skipped while its condition holds, and returns once it's fixed", async () => {
    const weddingId = await dueWedding("Boda arreglo");
    const party = await createParty(weddingId, "Familia Sin Correo", null);
    // The skip a run would have written when the email was removed mid-flight.
    const c = await arrange(party.id, weddingId, { state: "skipped", outcome_reason: "no_contact_email" });
    expect(await claim()).toEqual([]);
    await as.ownerA
      .from("guest_invitations")
      .update({ contact_email: "nueva@example.com" })
      .eq("id", party.id)
      .eq("wedding_id", weddingId);
    const claimed = await claim();
    expect(claimed.map((x) => x.id)).toEqual([c]);
  });

  it("E4 applies to reactivation except for policy_disabled (re-enabling resets enabled_at)", async () => {
    const weddingId = await dueWedding("Boda E4");
    const a = await createParty(weddingId, "Familia E4 correo");
    const b = await createParty(weddingId, "Familia E4 política");
    await arrange(a.id, weddingId, { state: "skipped", outcome_reason: "no_contact_email" });
    const bId = await arrange(b.id, weddingId, { state: "skipped", outcome_reason: "policy_disabled" });
    await sql("update public.wedding_rsvp_reminder_policies set enabled_at = now() where wedding_id = $1", [weddingId]);
    const claimed = await claim();
    expect(claimed.map((c) => c.id)).toEqual([bId]);
    expect((await occurrenceOf(a.id))?.state).toBe("skipped");
  });

  it("never reactivates a skip whose party is still ineligible, nor a row past the window", async () => {
    const weddingId = await dueWedding("Boda sigue inelegible");
    const party = await createParty(weddingId, "Familia Revocada");
    await as.ownerA.rpc("revoke_guest_invitation_link", { target_wedding_id: weddingId, target_invitation_id: party.id });
    await arrange(party.id, weddingId, { state: "skipped", outcome_reason: "link_unavailable" });
    expect(await claim()).toEqual([]);
    // An owner's new link makes it usable again → reactivated.
    const fresh = newToken();
    await as.ownerA.rpc("rotate_guest_invitation_link", {
      target_wedding_id: weddingId,
      target_invitation_id: party.id,
      invitation_token_hash: fresh.hash,
      invitation_token_ciphertext: shapedEnvelope(),
    });
    expect(await claim()).toHaveLength(1);

    const closed = await createParty(weddingId, "Familia Ventana Cerrada");
    await arrange(closed.id, weddingId, { state: "skipped", outcome_reason: "no_contact_email" });
    await sql("update public.weddings set wedding_date = current_date + 10 where id = $1", [weddingId]);
    expect(await claim()).toEqual([]);
  });
});
