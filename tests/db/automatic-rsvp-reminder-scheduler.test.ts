import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailSendOptions, EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));

const { createGuestParty, rotateGuestPartyLink } = await import("@/lib/guests/service");
const { createRsvpReminderStore } = await import("@/lib/scheduler/rsvp-reminder-store");
const { runAutomaticRsvpReminders } = await import("@/lib/scheduler/rsvp-reminder-runner");
const { getAutomaticReminderPolicy, setAutomaticReminderPolicy } = await import("@/lib/scheduler/policy");

// LB-17 (ADR-010) end to end: the real runner and the real service_role
// scheduler store against the local stack, with a FAKE email sender that
// behaves like Resend's idempotency (same key + same payload → the original
// result, no new email; same key + different payload → conflict). Real
// envelopes (test key), real current-truth checks, real activity rows.
// Tokens are compared through their hashes, never printed.

const APP_ORIGIN = "http://localhost:3100";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const RSVP_LINE = /^Confirmar asistencia: http:\/\/localhost:3100\/rsvp\/([A-Za-z0-9_-]{43})$/m;

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

beforeEach(async () => {
  await sql("delete from public.automatic_rsvp_reminders");
  await sql("update public.wedding_rsvp_reminder_policies set enabled = false");
});

const store = () => createRsvpReminderStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });

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
    `update public.weddings set time_zone = 'UTC', city = 'Ciudad Ejemplo',
       wedding_date = ((now() at time zone 'UTC') - interval '10 hours')::date + 14
     where id = $1`,
    [id],
  );
  const { error } = await (await sessionClient("ownerA")).rpc("set_rsvp_reminder_policy", {
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

/** A party with a REAL recoverable link (envelope under the test key). */
async function party(weddingId: string, label: string, contactEmail: string | null = null) {
  const email = contactEmail ?? `${label.toLowerCase().replace(/[^a-z]/g, "")}-${randomUUID().slice(0, 8)}@example.com`;
  const result = await createGuestParty(
    await sessionClient("ownerA"),
    weddingId,
    { label, guestNames: ["Invitada Uno"], contactEmail: email },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  return { id: result.guestInvitationId, email };
}

async function occurrence(partyId: string) {
  const [row] = await sql<{ id: string; state: string; outcome_reason: string | null; attempt_count: number }>(
    "select id, state, outcome_reason, attempt_count from public.automatic_rsvp_reminders where guest_invitation_id = $1",
    [partyId],
  );
  return row;
}

async function currentHash(partyId: string): Promise<string> {
  const [row] = await sql<{ token_hash: string }>("select token_hash from public.guest_invitations where id = $1", [
    partyId,
  ]);
  return row!.token_hash;
}

type Call = { email: OutgoingEmail; key: string | undefined };

/**
 * Behaves like Resend's idempotency for a given key: one real delivery; the
 * same payload again returns the original id without delivering; a
 * different payload is refused. `delivered` counts real deliveries.
 */
function idempotentSender(behaviour?: (call: Call, n: number) => EmailSendResult | "throw" | null) {
  const calls: Call[] = [];
  const delivered: OutgoingEmail[] = [];
  const byKey = new Map<string, { payload: string; id: string }>();
  const sender: EmailSender = {
    async send(email, options?: EmailSendOptions) {
      const call = { email, key: options?.idempotencyKey };
      calls.push(call);
      const forced = behaviour?.(call, calls.length);
      if (forced === "throw") throw new Error("network down (fake)");
      if (forced) return forced;
      const payload = JSON.stringify(email);
      if (call.key) {
        const earlier = byKey.get(call.key);
        if (earlier) {
          return earlier.payload === payload
            ? { ok: true, messageId: earlier.id }
            : { ok: false, reason: "idempotency_conflict" };
        }
      }
      const id = `fake-${randomUUID()}`;
      if (call.key) byKey.set(call.key, { payload, id });
      delivered.push(email);
      return { ok: true, messageId: id };
    },
  };
  return { sender, calls, delivered };
}

function deps(sender: EmailSender, overrides: Partial<Parameters<typeof runAutomaticRsvpReminders>[0]> = {}) {
  return { store: store(), sender, appOrigin: APP_ORIGIN, encryption: ENCRYPTION, sleep: async () => {}, ...overrides };
}

function tokenHashIn(email: OutgoingEmail | undefined): string | undefined {
  const token = RSVP_LINE.exec(email?.text ?? "")?.[1];
  return token ? createHash("sha256").update(token, "utf8").digest("hex") : undefined;
}

describe("the scheduler, end to end", () => {
  it("sends ONE reminder with the party's CURRENT link to its CURRENT email, records it as system, then nothing more", async () => {
    const weddingId = await dueWedding("Boda automática servicio");
    const p = await party(weddingId, "Familia Automática");
    const { sender, calls, delivered } = idempotentSender();

    const summary = await runAutomaticRsvpReminders(deps(sender));
    expect(summary).toMatchObject({ ok: true, claimed: 1, sent: 1, unknown: 0, failed: 0, aborted: false });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toBe(p.email);
    expect(tokenHashIn(delivered[0])).toBe(await currentHash(p.id));
    const row = await occurrence(p.id);
    expect(row).toMatchObject({ state: "sent", attempt_count: 1 });
    expect(calls[0]!.key).toBe(`lb-auto-rsvp-reminder:${row!.id}`);

    const [meta] = await sql<{ to: string; provider: string }>(
      "select rsvp_reminder_email_sent_to as to, rsvp_reminder_email_provider_id as provider from public.guest_invitations where id = $1",
      [p.id],
    );
    expect(meta!.to).toBe(p.email);
    const activity = await sql<{ actor_kind: string; actor_user_id: string | null }>(
      "select actor_kind, actor_user_id from public.wedding_activity where guest_invitation_id = $1 and event_type = 'rsvp_reminder_email_sent'",
      [p.id],
    );
    expect(activity).toEqual([{ actor_kind: "system", actor_user_id: null }]);

    // A second (and third) run sends nothing.
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ claimed: 0, sent: 0 });
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ claimed: 0, sent: 0 });
    expect(calls).toHaveLength(1);
  });

  it("two runners at once: at most one provider send per party", async () => {
    const weddingId = await dueWedding("Boda dos ejecutores");
    const parties = await Promise.all([1, 2, 3, 4, 5].map((i) => party(weddingId, `Familia Paralela ${i}`)));
    const { sender, calls, delivered } = idempotentSender();

    const [a, b] = await Promise.all([runAutomaticRsvpReminders(deps(sender)), runAutomaticRsvpReminders(deps(sender))]);
    expect(a.sent + b.sent).toBe(parties.length);
    expect(calls).toHaveLength(parties.length);
    expect(new Set(delivered.map((e) => e.to)).size).toBe(parties.length);
    for (const p of parties) expect((await occurrence(p.id))?.state).toBe("sent");
  });

  it.each(["claim", "prepare"] as const)(
    "a worker that crashed after %s: the lease expires and the next run sends once, nothing consumed",
    async (step) => {
      const weddingId = await dueWedding(`Boda caída tras ${step}`);
      const p = await party(weddingId, "Familia Caída");
      const s = store();
      const [claimed] = (await s.claim(50, 25))!;
      if (step === "prepare") expect((await s.prepare(claimed!)).status).toBe("ready");
      // ... and the process died. Later, the lease is over:
      await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where state in ('claimed', 'sending')");

      const { sender, delivered } = idempotentSender();
      expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ sent: 1 });
      expect(delivered).toHaveLength(1);
      expect(await occurrence(p.id)).toMatchObject({ state: "sent", attempt_count: 1 });
    },
  );

  it("a worker that crashed after begin (the provider may or may not have been called): the replay uses the SAME key", async () => {
    const weddingId = await dueWedding("Boda caída tras comenzar");
    const p = await party(weddingId, "Familia Comenzada");
    const { sender, calls, delivered } = idempotentSender();

    // First worker: claim, prepare, begin (attempt 1)... and it dies before or during the provider call.
    const s = store();
    const [claimed] = (await s.claim(50, 25))!;
    const prepared = await s.prepare(claimed!);
    if (prepared.status !== "ready") throw new Error("not ready");
    expect((await s.begin(claimed!, { tokenHash: prepared.reminder.tokenHash, recipient: prepared.reminder.recipient })).status).toBe(
      "sending",
    );
    // After its lease: the next run replays as attempt 2 under the same key.
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where state in ('claimed', 'sending')");
    const first = await runAutomaticRsvpReminders(deps(sender));
    expect(first.sent).toBe(1);
    expect(await occurrence(p.id)).toMatchObject({ state: "sent", attempt_count: 2 });
    expect(calls).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it("provider accepted, worker crashed before recording: the replay returns the original send (one email), then records", async () => {
    const weddingId = await dueWedding("Boda aceptado sin registrar");
    const p = await party(weddingId, "Familia Aceptada");
    const { sender, calls, delivered } = idempotentSender();
    let crash = true;
    const crashingStore = {
      ...store(),
      async record(entry: Parameters<ReturnType<typeof store>["record"]>[0]) {
        if (crash) throw new Error("process died (fake)");
        return store().record(entry);
      },
    };
    await expect(runAutomaticRsvpReminders(deps(sender, { store: crashingStore }))).rejects.toThrow();
    expect(await occurrence(p.id)).toMatchObject({ state: "sending", attempt_count: 1 });
    expect(delivered).toHaveLength(1);

    crash = false;
    await sql("update public.automatic_rsvp_reminders set lease_expires_at = now() - interval '1 second' where state in ('claimed', 'sending')");
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBe(calls[1]!.key);
    expect(delivered).toHaveLength(1);
    expect(await occurrence(p.id)).toMatchObject({ state: "sent", attempt_count: 2 });
  });

  it("a provider timeout is retried later with the same key; a changed payload then ends unknown (idempotency_conflict)", async () => {
    const weddingId = await dueWedding("Boda tiempo agotado");
    const p = await party(weddingId, "Familia Tiempo");
    const { sender, calls, delivered } = idempotentSender((_call, n) => (n === 1 ? { ok: false, reason: "timeout" } : null));
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ retry: 1, sent: 0 });
    expect(await occurrence(p.id)).toMatchObject({ state: "retry_wait", attempt_count: 1 });

    // Next hour: unchanged truth → sent, same key.
    await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where state = 'retry_wait'");
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ sent: 1 });
    expect(calls.map((c) => c.key)).toEqual([calls[0]!.key, calls[0]!.key]);
    expect(delivered).toHaveLength(1);

    // Another party whose first attempt may have delivered, then its label changed.
    const q = await party(weddingId, "Familia Cambiada");
    const conflictSender = idempotentSender();
    // First attempt: the provider DID deliver, but the answer timed out.
    let firstCall = true;
    const lossy: EmailSender = {
      async send(email, options) {
        const result = await conflictSender.sender.send(email, options);
        if (firstCall) {
          firstCall = false;
          return { ok: false, reason: "timeout" };
        }
        return result;
      },
    };
    expect(await runAutomaticRsvpReminders(deps(lossy))).toMatchObject({ retry: 1 });
    await sql("update public.guest_invitations set label = 'Familia Renombrada' where id = $1", [q.id]);
    await sql("update public.automatic_rsvp_reminders set next_attempt_at = now() - interval '1 second' where state = 'retry_wait'");
    expect(await runAutomaticRsvpReminders(deps(lossy))).toMatchObject({ unknown: 1, sent: 0 });
    expect(await occurrence(q.id)).toMatchObject({ state: "unknown", outcome_reason: "idempotency_conflict", attempt_count: 2 });
    expect(conflictSender.delivered).toHaveLength(1);
  });

  it("the record fails after the provider accepted: sent_unrecorded, terminal, never sent again", async () => {
    const weddingId = await dueWedding("Boda sin registro");
    const p = await party(weddingId, "Familia SinRegistro");
    const { sender, delivered } = idempotentSender();
    const failing = { ...store(), record: async () => ({ ok: false as const }) };
    expect(await runAutomaticRsvpReminders(deps(sender, { store: failing }))).toMatchObject({ unrecorded: 1 });
    expect(await occurrence(p.id)).toMatchObject({ state: "sent_unrecorded", attempt_count: 1 });
    for (let i = 0; i < 2; i += 1) {
      expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ claimed: 0, sent: 0 });
    }
    expect(delivered).toHaveLength(1);
    // Nothing fabricated: no metadata, no history.
    const history = await sql(
      "select 1 from public.wedding_activity where guest_invitation_id = $1 and event_type = 'rsvp_reminder_email_sent'",
      [p.id],
    );
    expect(history).toEqual([]);
  });

  it("an accepted send without a storable id is sent_unrecorded", async () => {
    const weddingId = await dueWedding("Boda sin id");
    const p = await party(weddingId, "Familia SinId");
    const { sender } = idempotentSender(() => ({ ok: true, messageId: null }));
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ unrecorded: 1 });
    expect((await occurrence(p.id))?.state).toBe("sent_unrecorded");
  });

  it("a rejected recipient → failed; a thrown provider error → retry", async () => {
    const weddingId = await dueWedding("Boda rechazo");
    const rejected = await party(weddingId, "Familia Rechazada");
    const { sender } = idempotentSender(() => ({ ok: false, reason: "invalid_recipient" }));
    expect(await runAutomaticRsvpReminders(deps(sender))).toMatchObject({ failed: 1 });
    expect(await occurrence(rejected.id)).toMatchObject({ state: "failed", outcome_reason: "recipient_rejected" });

    const thrown = await party(weddingId, "Familia Excepción");
    const { sender: throwing } = idempotentSender(() => "throw");
    expect(await runAutomaticRsvpReminders(deps(throwing))).toMatchObject({ retry: 1 });
    expect(await occurrence(thrown.id)).toMatchObject({ state: "retry_wait", attempt_count: 1 });
  });

  it("a provider configuration error aborts the run; the other claims are left for later with nothing consumed", async () => {
    const weddingId = await dueWedding("Boda configuración");
    const parties = await Promise.all([1, 2, 3].map((i) => party(weddingId, `Familia Config ${i}`)));
    const { sender, calls } = idempotentSender(() => ({ ok: false, reason: "configuration" }));
    const summary = await runAutomaticRsvpReminders(deps(sender));
    expect(summary).toMatchObject({ aborted: true, claimed: 3, retry: 1, deferred: 2 });
    expect(calls).toHaveLength(1);
    const states = await Promise.all(parties.map((p) => occurrence(p.id)));
    expect(states.filter((s) => s?.state === "claimed" && s.attempt_count === 0)).toHaveLength(2);
  });

  it("current truth wins: answered, rotated link, changed email, unrecoverable envelope", async () => {
    const weddingId = await dueWedding("Boda verdad actual");
    const rotated = await party(weddingId, "Familia Rotada");
    // An owner replaced the link before the run: the email carries the NEW link.
    const rotation = await rotateGuestPartyLink(await sessionClient("ownerA"), weddingId, rotated.id, APP_ORIGIN, ENCRYPTION);
    expect(rotation.ok).toBe(true);
    const changed = await party(weddingId, "Familia Cambio Correo");
    await sql("update public.guest_invitations set contact_email = 'nuevo-correo@example.com' where id = $1", [changed.id]);

    const { sender, delivered } = idempotentSender();
    await runAutomaticRsvpReminders(deps(sender));
    const toRotated = delivered.find((e) => e.to === rotated.email);
    expect(tokenHashIn(toRotated)).toBe(await currentHash(rotated.id));
    expect(delivered.map((e) => e.to)).toContain("nuevo-correo@example.com");
    expect(delivered.map((e) => e.to)).not.toContain(changed.email);

    // An envelope this server can't decrypt: skipped before any attempt, no email.
    const unreadable = await party(weddingId, "Familia Ilegible");
    const { sender: other, calls } = idempotentSender();
    expect(
      await runAutomaticRsvpReminders(deps(other, { encryption: { key: WRONG_TEST_RSVP_CAPABILITY_KEY } })),
    ).toMatchObject({ skipped: 1, sent: 0 });
    expect(calls).toEqual([]);
    expect(await occurrence(unreadable.id)).toMatchObject({ state: "skipped", outcome_reason: "link_unrecoverable", attempt_count: 0 });
    // With the right key again: reactivated, sent once.
    expect(await runAutomaticRsvpReminders(deps(other))).toMatchObject({ sent: 1 });
  });

  it("the 45 s budget: nothing new starts after it; claims are left with nothing consumed", async () => {
    const weddingId = await dueWedding("Boda presupuesto");
    await Promise.all([1, 2].map((i) => party(weddingId, `Familia Presupuesto ${i}`)));
    let clock = 0;
    const { sender, calls } = idempotentSender();
    const summary = await runAutomaticRsvpReminders(
      deps(sender, {
        now: () => {
          clock += 46_000;
          return clock;
        },
      }),
    );
    expect(summary).toMatchObject({ claimed: 2, sent: 0, deferred: 2 });
    expect(calls).toEqual([]);
    const rows = await sql<{ attempt_count: number }>(
      "select attempt_count from public.automatic_rsvp_reminders where wedding_id = $1",
      [weddingId],
    );
    expect(rows.map((r) => r.attempt_count)).toEqual([0, 0]);
  });
});

describe("the policy service (owner-only, through the member's own session)", () => {
  it("owners enable and pick the days; collaborators read but are refused; outsiders get not_found", async () => {
    const weddingId = await createFixtureWedding("ownerA", "Boda política servicio");
    createdWeddings.push(weddingId);
    await addMember(weddingId, "collabA", "collaborator");
    const owner = await sessionClient("ownerA");
    const collab = await sessionClient("collabA");

    expect(await setAutomaticReminderPolicy(owner, weddingId, { enabled: true, daysBefore: 21 })).toEqual({
      ok: false,
      reason: "needs_date",
    });
    await sql("update public.weddings set wedding_date = '2090-06-30', time_zone = 'UTC' where id = $1", [weddingId]);
    expect(await setAutomaticReminderPolicy(owner, weddingId, { enabled: true, daysBefore: 7 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await setAutomaticReminderPolicy(collab, weddingId, { enabled: true, daysBefore: 21 })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(
      await setAutomaticReminderPolicy(await sessionClient("outsider"), weddingId, { enabled: true, daysBefore: 21 }),
    ).toEqual({ ok: false, reason: "not_found" });

    const accessOf = (userId: string, role: "owner" | "collaborator") => ({
      weddingId,
      userId,
      membershipId: randomUUID(),
      role,
    });
    expect(await getAutomaticReminderPolicy(collab, accessOf(users.collabA.id, "collaborator"))).toEqual({
      enabled: false,
      daysBefore: 21,
      enabledAt: null,
    });
    expect(await setAutomaticReminderPolicy(owner, weddingId, { enabled: true, daysBefore: 30 })).toEqual({ ok: true });
    const seen = await getAutomaticReminderPolicy(collab, accessOf(users.collabA.id, "collaborator"));
    expect(seen).toMatchObject({ enabled: true, daysBefore: 30 });
    expect(seen?.enabledAt).not.toBeNull();
  });
});
