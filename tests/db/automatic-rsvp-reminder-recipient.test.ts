import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { as, createWedding as createFixtureWedding, ctx, serviceRole, sql, superuser, users } from "./support";

vi.mock("server-only", () => ({}));

const { createGuestParty, updateGuestPartyContactEmail } = await import("@/lib/guests/service");
const { sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");
const { createRsvpReminderStore } = await import("@/lib/scheduler/rsvp-reminder-store");
const { runAutomaticRsvpReminders } = await import("@/lib/scheduler/rsvp-reminder-runner");

// LB-18.4 (ADR-010 §7 E9/E11, §8b; ADR-011 §10): automatic reminders become
// recipient-aware, against the real local stack.
//
// * recipient_undeliverable: the party's CURRENT contact email has a
//   suppressed / bounced / complained delivery in the SAME wedding (the
//   LB-18.3 determination). Pre-provider: skipped, attempt 0, remediable by a
//   genuinely different address, never by a case-only edit.
// * recently_reminded counts only invitation / reminder sends TO the current
//   address (comparison form: trim + lowercase).
//
// Sends go through the real services and the real service_role recorder with
// a FAKE provider; delivery statuses advance only through the real ingest
// function (the webhook's one writer); the scheduler runs as service_role
// (the real store and runner). The superuser connection only moves times
// into the past (the database clock can't be faked) and reads ground truth.

type EventType = Database["public"]["Enums"]["email_delivery_event_type"];
type DeliveryStatus = Database["public"]["Enums"]["email_delivery_status"];

const APP_ORIGIN = "http://localhost:3100";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

// Claims are global: every test starts from a quiet scheduler.
beforeEach(async () => {
  await sql("delete from public.automatic_rsvp_reminders");
  await sql("update public.wedding_rsvp_reminder_policies set enabled = false");
});

let counter = 0;
const address = (tag: string) => `lb184-${tag}-${++counter}-${randomUUID().slice(0, 8)}@example.com`;

async function sessionClient(user: TestUserKey) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return supabase;
}

/** A wedding whose 14-day reminder is due now, policy enabled a month ago. */
async function dueWedding(name: string): Promise<string> {
  const id = await createFixtureWedding("ownerA", name);
  createdWeddings.push(id);
  await sql(
    `update public.weddings set time_zone = 'UTC',
       wedding_date = ((now() at time zone 'UTC') - interval '10 hours')::date + 14
     where id = $1`,
    [id],
  );
  const { error } = await as.ownerA.rpc("set_rsvp_reminder_policy", {
    target_wedding_id: id,
    reminders_enabled: true,
    reminder_days_before: 14,
  });
  if (error) throw new Error(`policy failed: ${error.message}`);
  await sql(
    "update public.wedding_rsvp_reminder_policies set enabled_at = now() - interval '30 days' where wedding_id = $1",
    [id],
  );
  return id;
}

type Party = { id: string; token: string; weddingId: string };

/** A party with a REAL recoverable link (envelope under the test key). */
async function newParty(weddingId: string, contactEmail: string | null): Promise<Party> {
  const result = await createGuestParty(
    await sessionClient("ownerA"),
    weddingId,
    { label: `Familia ${++counter}`, guestNames: ["Ana Prueba"], contactEmail },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  return { id: result.guestInvitationId, token: result.token, weddingId };
}

function recorder(): DeliveryRecorder {
  return createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
}

/** Sends the party's invitation through the real service (fake provider); returns the provider id. */
async function invite(party: Party): Promise<string> {
  const ids: string[] = [];
  const sender: EmailSender = {
    async send() {
      const id = `fake-${randomUUID()}`;
      ids.push(id);
      return { ok: true, messageId: id };
    },
  };
  const outcome = await sendGuestInvitationEmail(
    await sessionClient("ownerA"),
    party.weddingId,
    party.id,
    party.token,
    { sender, appOrigin: APP_ORIGIN, recorder: recorder() },
  );
  if (outcome.outcome !== "sent") throw new Error(`invitation not sent: ${JSON.stringify(outcome)}`);
  return ids[0]!;
}

/** The provider reports an outcome, through the webhook's one writer. */
async function report(providerMessageId: string, eventType: EventType) {
  const { data, error } = await serviceRole.rpc("ingest_email_delivery_event", {
    provider_event_id: `msg_lb184${randomUUID().replace(/-/g, "")}`,
    provider_message_id: providerMessageId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    ...(eventType === "bounced" ? { bounce_type: "permanent" as const } : {}),
  });
  if (error || data !== "applied") throw new Error(`ingest failed: ${error?.message ?? data}`);
}

/**
 * Makes `email` known in `weddingId` with `status`: ANOTHER party of the same
 * wedding is invited at that address and the provider reports the status. The
 * party under test then has no send of its own (nothing recent to suppress it).
 */
async function knownAddress(weddingId: string, email: string, status: DeliveryStatus) {
  const other = await newParty(weddingId, email);
  const id = await invite(other);
  if (status !== "accepted") await report(id, status === "delayed" ? "delivery_delayed" : status);
  return { party: other, providerId: id };
}

async function setContactEmail(party: Party, email: string | null) {
  const result = await updateGuestPartyContactEmail(await sessionClient("ownerA"), party.weddingId, party.id, email);
  if (!result.ok) throw new Error(`updateGuestPartyContactEmail failed: ${result.reason}`);
}

/** Moves a party's recorded sends (metadata and ledger rows) `days` into the past. */
async function ageSends(partyId: string, days: number) {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    // Fixture only: the ledger guard keeps accepted_at immutable for every
    // role; replica mode skips that trigger for this one arranged update.
    await client.query("set local session_replication_role = replica");
    await client.query(
      `update public.email_deliveries set accepted_at = accepted_at - make_interval(days => $2)
       where guest_invitation_id = $1`,
      [partyId, days],
    );
    await client.query(
      `update public.guest_invitations set
         invitation_email_sent_at = invitation_email_sent_at - make_interval(days => $2),
         rsvp_reminder_email_sent_at = rsvp_reminder_email_sent_at - make_interval(days => $2)
       where id = $1`,
      [partyId, days],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function claim() {
  const { data, error } = await serviceRole.rpc("claim_automatic_rsvp_reminders", { max_total: 50, max_per_wedding: 25 });
  if (error || !data) throw new Error(`claim failed: ${error?.message}`);
  return data.map((r) => ({ id: r.occurrence_id, token: r.occurrence_claim_token }));
}

type OccurrenceRow = {
  id: string;
  state: string;
  outcome_reason: string | null;
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: Date | null;
  first_attempt_at: Date | null;
};

async function occurrenceOf(partyId: string): Promise<OccurrenceRow | undefined> {
  const [row] = await sql<OccurrenceRow>(
    `select id, state, outcome_reason, attempt_count, claim_token, lease_expires_at, first_attempt_at
     from public.automatic_rsvp_reminders where guest_invitation_id = $1`,
    [partyId],
  );
  return row;
}

async function claimFor(party: Party) {
  const claimed = await claim();
  const row = await occurrenceOf(party.id);
  return claimed.find((c) => c.id === row?.id) ?? null;
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

/** Everything a pre-provider skip must leave untouched for the party. */
async function sideEffects(partyId: string) {
  const [row] = await sql<Record<string, unknown>>(
    `select i.rsvp_reminder_email_sent_at, i.rsvp_reminder_email_sent_to, i.rsvp_reminder_email_provider_id,
            (select count(*)::int from public.wedding_activity a
              where a.guest_invitation_id = i.id and a.event_type = 'rsvp_reminder_email_sent') as reminder_activity,
            (select count(*)::int from public.email_deliveries d
              where d.guest_invitation_id = i.id and d.kind = 'rsvp_reminder_automatic') as automatic_deliveries
     from public.guest_invitations i where i.id = $1`,
    [partyId],
  );
  return row!;
}

const NO_REMINDER = {
  rsvp_reminder_email_sent_at: null,
  rsvp_reminder_email_sent_to: null,
  rsvp_reminder_email_provider_id: null,
  reminder_activity: 0,
  automatic_deliveries: 0,
};

/** The members' (LB-18.3) answer for the party's current address. */
async function memberBlock(party: Party, recipient: string) {
  const { data, error } = await as.ownerA.rpc("get_guest_invitation_email_block", {
    target_wedding_id: party.weddingId,
    target_invitation_id: party.id,
    target_recipient: recipient,
  });
  if (error) throw new Error(`get_guest_invitation_email_block failed: ${error.message}`);
  return data;
}

function countingSender() {
  const delivered: OutgoingEmail[] = [];
  const sender: EmailSender = {
    async send(email) {
      delivered.push(email);
      return { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
  return { sender, delivered };
}

const store = () => createRsvpReminderStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });

function runner(sender: EmailSender, overrides: Partial<Parameters<typeof runAutomaticRsvpReminders>[0]> = {}) {
  return runAutomaticRsvpReminders({
    store: store(),
    sender,
    appOrigin: APP_ORIGIN,
    encryption: ENCRYPTION,
    sleep: async () => {},
    ...overrides,
  });
}

const SKIPPED_UNDELIVERABLE = {
  state: "skipped",
  outcome_reason: "recipient_undeliverable",
  attempt_count: 0,
  claim_token: null,
  lease_expires_at: null,
  first_attempt_at: null,
};

// ==================================================== the recipient rule

describe("recipient_undeliverable: the current address's delivery status in this wedding", () => {
  it.each([
    ["accepted", null],
    ["delayed", null],
    ["failed", null],
    ["delivered", null],
    ["suppressed", "suppressed"],
    ["bounced", "bounced"],
    ["complained", "complained"],
  ] as const)("%s → %s", async (status, block) => {
    const weddingId = await dueWedding(`Boda estado ${status}`);
    const email = address(status);
    await knownAddress(weddingId, email, status);
    const party = await newParty(weddingId, email);

    // LB-18.3 and LB-18.4 agree: the members' warning and the scheduler.
    expect(await memberBlock(party, email)).toBe(block ?? "none");
    const c = await claimFor(party);
    if (block) {
      expect(c).toBeNull();
      expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
      expect(await sideEffects(party.id)).toEqual(NO_REMINDER);
    } else {
      expect(c).not.toBeNull();
      expect(await occurrenceOf(party.id)).toMatchObject({ state: "claimed", outcome_reason: null, attempt_count: 0 });
    }
  });

  it("compared in the comparison form: a bounce to Victor@… blocks victor@… (and a case-only edit stays blocked)", async () => {
    const weddingId = await dueWedding("Boda mayúsculas");
    const tag = randomUUID().slice(0, 8);
    await knownAddress(weddingId, `Victor.${tag}@example.com`, "bounced");
    const party = await newParty(weddingId, `victor.${tag}@example.com`);
    expect(await memberBlock(party, `victor.${tag}@example.com`)).toBe("bounced");
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);

    // A case-only edit is the SAME address: not a remedy.
    await setContactEmail(party, `VICTOR.${tag}@example.com`);
    expect(await claim()).toEqual([]);
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
  });

  it("dots and +tags stay significant: a bounce to a.b@ / a+x@ never blocks ab@", async () => {
    const weddingId = await dueWedding("Boda alias");
    const tag = randomUUID().slice(0, 8);
    await knownAddress(weddingId, `a.b${tag}@example.com`, "bounced");
    await knownAddress(weddingId, `ab${tag}+x@example.com`, "bounced");
    const party = await newParty(weddingId, `ab${tag}@example.com`);
    expect(await claimFor(party)).not.toBeNull();
  });

  it("tenant isolation: the same address bounced in wedding A never blocks wedding B", async () => {
    const weddingA = await dueWedding("Boda A rebote");
    const weddingB = await dueWedding("Boda B limpia");
    const email = address("shared");
    await knownAddress(weddingA, email, "bounced");
    const party = await newParty(weddingB, email);
    expect(await memberBlock(party, email)).toBe("none");
    expect(await claimFor(party)).not.toBeNull();
  });
});

// ======================================================== reactivation

describe("reactivation (skipped recipient_undeliverable, attempt_count = 0)", () => {
  it("a genuinely different clean address reactivates the SAME row with nothing consumed; the send then goes to it", async () => {
    const weddingId = await dueWedding("Boda nueva dirección");
    const oldEmail = address("old");
    await knownAddress(weddingId, oldEmail, "bounced");
    const party = await newParty(weddingId, oldEmail);
    await claim();
    const skipped = await occurrenceOf(party.id);
    expect(skipped).toMatchObject(SKIPPED_UNDELIVERABLE);

    // Still the same address: stays skipped, run after run.
    expect(await claim()).toEqual([]);

    const newEmail = address("new");
    await setContactEmail(party, newEmail);
    const claimed = await claim();
    expect(claimed.map((c) => c.id)).toEqual([skipped!.id]);
    // Reactivated: same row, fresh lease, still no attempt (the provider opportunity is unconsumed).
    expect(await occurrenceOf(party.id)).toMatchObject({
      id: skipped!.id,
      state: "claimed",
      outcome_reason: null,
      attempt_count: 0,
      first_attempt_at: null,
    });
    // Expire that claim so the runner reclaims it; the send goes to the NEW address.
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() where id = $1", [skipped!.id]);
    const { sender, delivered } = countingSender();
    expect(await runner(sender)).toMatchObject({ sent: 1 });
    expect(delivered.map((e) => e.to)).toEqual([newEmail]);
    expect(await occurrenceOf(party.id)).toMatchObject({ id: skipped!.id, state: "sent", attempt_count: 1 });
  });

  it("a new address that is itself already bad in this wedding stays skipped", async () => {
    const weddingId = await dueWedding("Boda otra mala");
    const first = address("first");
    const second = address("second");
    await knownAddress(weddingId, first, "bounced");
    await knownAddress(weddingId, second, "complained");
    const party = await newParty(weddingId, first);
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    await setContactEmail(party, second);
    expect(await claim()).toEqual([]);
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
  });

  it("removing the address turns it into no_contact_email (remediable as before)", async () => {
    const weddingId = await dueWedding("Boda sin dirección");
    const email = address("removed");
    await knownAddress(weddingId, email, "suppressed");
    const party = await newParty(weddingId, email);
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    await setContactEmail(party, null);
    expect(await claim()).toEqual([]);
    // The row keeps its last recorded reason until a run re-evaluates it; a
    // clean address then reactivates it.
    await setContactEmail(party, address("clean"));
    expect(await claimFor(party)).not.toBeNull();
  });
});

// ================================================ recently_reminded per address

describe("recently_reminded counts only sends to the CURRENT address", () => {
  it("a recent invitation to the current address → recently_reminded", async () => {
    const weddingId = await dueWedding("Boda reciente actual");
    const party = await newParty(weddingId, address("current"));
    await invite(party);
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "recently_reminded", attempt_count: 0 });
  });

  it("a recent invitation to an OLD address doesn't suppress the reminder to the new one", async () => {
    const weddingId = await dueWedding("Boda reciente vieja");
    const party = await newParty(weddingId, address("old"));
    await invite(party);
    const newEmail = address("new");
    await setContactEmail(party, newEmail);
    const { sender, delivered } = countingSender();
    expect(await runner(sender)).toMatchObject({ claimed: 1, sent: 1 });
    expect(delivered.map((e) => e.to)).toEqual([newEmail]);
  });

  it("a recent send to a case variant of the current address → recently_reminded", async () => {
    const weddingId = await dueWedding("Boda reciente mayúsculas");
    const tag = randomUUID().slice(0, 8);
    const party = await newParty(weddingId, `Victor.${tag}@example.com`);
    await invite(party);
    await setContactEmail(party, `victor.${tag}@example.com`);
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "recently_reminded" });
  });

  it("a send to the current address older than 7 days no longer suppresses", async () => {
    const weddingId = await dueWedding("Boda antigua");
    const party = await newParty(weddingId, address("aged"));
    await invite(party);
    await ageSends(party.id, 8);
    expect(await claimFor(party)).not.toBeNull();
  });

  it("the ledger keeps an earlier send to the current address visible behind a later send elsewhere", async () => {
    const weddingId = await dueWedding("Boda intercalada");
    const a = address("a");
    const party = await newParty(weddingId, a);
    await invite(party); // to A
    await setContactEmail(party, address("b"));
    await invite(party); // to B: the latest-send metadata now names B
    await setContactEmail(party, a);
    await claim();
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "recently_reminded" });
  });

  it("channels unchanged: a recorded reminder counts; an RSVP confirmation never did and still doesn't", async () => {
    const weddingId = await dueWedding("Boda canales");
    const reminded = await newParty(weddingId, address("reminded"));
    await sql(
      `update public.guest_invitations set rsvp_reminder_email_sent_at = now() - interval '2 days',
         rsvp_reminder_email_sent_to = contact_email, rsvp_reminder_email_provider_id = 'manual-lb184' where id = $1`,
      [reminded.id],
    );
    const remindedElsewhere = await newParty(weddingId, address("elsewhere"));
    await sql(
      `update public.guest_invitations set rsvp_reminder_email_sent_at = now() - interval '2 days',
         rsvp_reminder_email_sent_to = $2, rsvp_reminder_email_provider_id = 'manual-lb184-old' where id = $1`,
      [remindedElsewhere.id, address("previous")],
    );
    const confirmed = await newParty(weddingId, address("confirmed"));
    await sql(
      `update public.guest_invitations set rsvp_confirmation_email_sent_at = now() - interval '1 day',
         rsvp_confirmation_email_sent_to = contact_email, rsvp_confirmation_email_provider_id = 'conf-lb184' where id = $1`,
      [confirmed.id],
    );
    await sql(
      `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient)
       select wedding_id, id, 'rsvp_confirmation', 'conf-lb184-' || left(id::text, 8), contact_email
       from public.guest_invitations where id = $1`,
      [confirmed.id],
    );
    await claim();
    expect(await occurrenceOf(reminded.id)).toMatchObject({ state: "skipped", outcome_reason: "recently_reminded" });
    expect(await occurrenceOf(remindedElsewhere.id)).toMatchObject({ state: "claimed" });
    expect(await occurrenceOf(confirmed.id)).toMatchObject({ state: "claimed" });
  });

  it("another wedding's sends to the same address are irrelevant", async () => {
    const weddingA = await dueWedding("Boda A reciente");
    const weddingB = await dueWedding("Boda B reciente");
    const email = address("both");
    await invite(await newParty(weddingA, email));
    const party = await newParty(weddingB, email);
    expect(await claimFor(party)).not.toBeNull();
  });
});

// ============================================================ precedence

describe("precedence: answered → policy_disabled → out_of_window → link_unavailable → link_unrecoverable → no_contact_email → recipient_undeliverable → recently_reminded", () => {
  it("each earlier reason wins over a bad current address; a bad address wins over a recent send", async () => {
    const weddingId = await dueWedding("Boda precedencia");
    const bad = address("bad");
    await knownAddress(weddingId, bad, "bounced");

    const answered = await newParty(weddingId, bad);
    const guests = await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [answered.id]);
    const { error } = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: (await sql<{ token_hash: string }>(
        "select token_hash from public.guest_invitations where id = $1",
        [answered.id],
      ))[0]!.token_hash,
      responses: guests.map((g) => ({ guest_id: g.id, attending: true })),
    });
    if (error) throw new Error(error.message);

    const revoked = await newParty(weddingId, bad);
    await as.ownerA.rpc("revoke_guest_invitation_link", { target_wedding_id: weddingId, target_invitation_id: revoked.id });

    const legacy = await newParty(weddingId, bad);
    await sql("delete from private.guest_invitation_capability_secrets where guest_invitation_id = $1", [legacy.id]);

    const noEmail = await newParty(weddingId, null);

    // Bad AND recently sent to (its own invitation, then bounced).
    const badAndRecent = await newParty(weddingId, address("recent-bad"));
    await report(await invite(badAndRecent), "bounced");

    await claim();
    const expected: Array<[Party, string]> = [
      [answered, "answered"],
      [revoked, "link_unavailable"],
      [legacy, "link_unrecoverable"],
      [noEmail, "no_contact_email"],
      [badAndRecent, "recipient_undeliverable"],
    ];
    for (const [p, reason] of expected) {
      expect(await occurrenceOf(p.id), reason).toMatchObject({ state: "skipped", outcome_reason: reason, attempt_count: 0 });
    }
  });

  it("policy_disabled and out_of_window still win over a bad address (re-checked at prepare)", async () => {
    const weddingId = await dueWedding("Boda política");
    const email = address("policy");
    const party = await newParty(weddingId, email);
    const c = (await claimFor(party))!;
    await knownAddress(weddingId, email, "bounced");
    await as.ownerA.rpc("set_rsvp_reminder_policy", {
      target_wedding_id: weddingId,
      reminders_enabled: false,
      reminder_days_before: 14,
    });
    expect((await prepare(c)).status).toBe("skipped");
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "skipped", outcome_reason: "policy_disabled" });

    const window = await dueWedding("Boda ventana");
    const email2 = address("window");
    const party2 = await newParty(window, email2);
    const c2 = (await claimFor(party2))!;
    await knownAddress(window, email2, "bounced");
    await sql("update public.weddings set wedding_date = current_date + 60 where id = $1", [window]);
    expect((await prepare(c2)).status).toBe("skipped");
    expect(await occurrenceOf(party2.id)).toMatchObject({ state: "skipped", outcome_reason: "out_of_window" });
  });
});

// ================================================== race / re-check safety

describe("re-checked before the provider boundary", () => {
  it("a bounce between claim and prepare: prepare skips it (recipient_undeliverable, attempt 0, lease released)", async () => {
    const weddingId = await dueWedding("Boda carrera prepare");
    const email = address("race-prepare");
    const party = await newParty(weddingId, email);
    const c = (await claimFor(party))!;
    await knownAddress(weddingId, email, "bounced");
    expect((await prepare(c)).status).toBe("skipped");
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    expect(await sideEffects(party.id)).toEqual(NO_REMINDER);
  });

  it("a bounce between prepare and begin: begin skips it; no attempt is consumed", async () => {
    const weddingId = await dueWedding("Boda carrera begin");
    const email = address("race-begin");
    const party = await newParty(weddingId, email);
    const c = (await claimFor(party))!;
    const ready = await prepare(c);
    expect(ready.status).toBe("ready");
    await knownAddress(weddingId, email, "complained");
    expect((await begin(c, ready.current_token_hash!, email)).status).toBe("skipped");
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    expect(await sideEffects(party.id)).toEqual(NO_REMINDER);
  });

  it("the runner: a bounce landing just before begin means no provider call, no record, no activity, no ledger row", async () => {
    const weddingId = await dueWedding("Boda carrera runner");
    const email = address("race-runner");
    const party = await newParty(weddingId, email);
    const base = store();
    let bounced = false;
    const racing = {
      ...base,
      async begin(...args: Parameters<typeof base.begin>) {
        if (!bounced) {
          bounced = true;
          await knownAddress(weddingId, email, "bounced");
        }
        return base.begin(...args);
      },
    };
    const { sender, delivered } = countingSender();
    expect(await runner(sender, { store: racing })).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(delivered).toEqual([]);
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    expect(await sideEffects(party.id)).toEqual(NO_REMINDER);
  });

  it("claimed while clean, then the old address bounces AND is replaced: current truth wins, the send goes to the new one", async () => {
    const weddingId = await dueWedding("Boda carrera cambio");
    const oldEmail = address("race-old");
    const party = await newParty(weddingId, oldEmail);
    const c = (await claimFor(party))!;
    await knownAddress(weddingId, oldEmail, "bounced");
    const newEmail = address("race-new");
    await setContactEmail(party, newEmail);
    const ready = await prepare(c);
    expect(ready).toMatchObject({ status: "ready", current_recipient: newEmail });
    expect(await begin(c, ready.current_token_hash!, newEmail)).toMatchObject({ status: "sending", attempt_number: 1 });
  });
});

// ======================================================= runner behaviour

describe("the runner with a fake sender", () => {
  it("an undeliverable current recipient: zero provider calls, nothing recorded", async () => {
    const weddingId = await dueWedding("Boda runner mala");
    const email = address("runner-bad");
    await knownAddress(weddingId, email, "bounced");
    const party = await newParty(weddingId, email);
    const { sender, delivered } = countingSender();
    const summary = await runner(sender);
    expect(summary).toMatchObject({ claimed: 0, sent: 0 });
    expect(delivered.filter((e) => e.to === email)).toEqual([]);
    expect(await occurrenceOf(party.id)).toMatchObject(SKIPPED_UNDELIVERABLE);
    expect(await sideEffects(party.id)).toEqual(NO_REMINDER);
  });

  it.each(["delayed", "failed"] as const)("a %s delivery to the current address is still sendable", async (status) => {
    const weddingId = await dueWedding(`Boda runner ${status}`);
    const email = address(`runner-${status}`);
    await knownAddress(weddingId, email, status);
    const party = await newParty(weddingId, email);
    const { sender, delivered } = countingSender();
    await runner(sender);
    expect(delivered.filter((e) => e.to === email)).toHaveLength(1);
    expect(await occurrenceOf(party.id)).toMatchObject({ state: "sent", attempt_count: 1 });
  });

  it("a bounce AFTER the provider boundary never rewrites the occurrence: sent stays sent, nothing is resent", async () => {
    const weddingId = await dueWedding("Boda rebote después");
    const email = address("after");
    const party = await newParty(weddingId, email);
    const { sender, delivered } = countingSender();
    expect(await runner(sender)).toMatchObject({ sent: 1 });
    const [{ provider } = { provider: "" }] = await sql<{ provider: string }>(
      "select rsvp_reminder_email_provider_id as provider from public.guest_invitations where id = $1",
      [party.id],
    );
    const before = await occurrenceOf(party.id);
    await report(provider, "bounced");
    expect(await occurrenceOf(party.id)).toEqual(before);
    expect(before).toMatchObject({ state: "sent", attempt_count: 1 });
    expect(await runner(sender)).toMatchObject({ claimed: 0, sent: 0 });
    expect(delivered).toHaveLength(1);
    // The address is now known bad for FUTURE sends (the members' guard agrees).
    expect(await memberBlock(party, email)).toBe("bounced");
  });
});
