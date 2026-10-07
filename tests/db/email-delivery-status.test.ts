import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  ctx,
  serviceRole,
  sql,
  users,
} from "./support";

vi.mock("server-only", () => ({}));

const { createGuestParty, listGuestParties, updateGuestPartyContactEmail } = await import("@/lib/guests/service");
const { rotateLinkAndSendInvitation, sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");
const { prepareRsvpReminderMessage, sendRsvpReminderEmail } = await import("@/lib/guests/rsvp-reminder");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");
const { requireWeddingMembership } = await import("@/lib/authz/wedding");

// LB-18.3 (ADR-011 §9): member-visible delivery status and the same-address
// guard, against the real local stack. Sends are recorded by the REAL
// service_role recorder after a FAKE provider accepted them; statuses advance
// only through the real ingest function (the webhook's one writer). The
// superuser connection arranges nothing here: it only reads ground truth.

type EventType = Database["public"]["Enums"]["email_delivery_event_type"];

const APP_ORIGIN = "http://localhost:3100";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const LINK_CONFIG = { appOrigin: APP_ORIGIN, encryption: ENCRYPTION };

const createdWeddings: string[] = [];
afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** A fresh client per call, like a fresh request. */
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

function anonClient() {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type FakeSender = EmailSender & { sent: OutgoingEmail[]; ids: string[] };

function fakeSender(): FakeSender {
  const sent: OutgoingEmail[] = [];
  const ids: string[] = [];
  return {
    sent,
    ids,
    async send(email) {
      sent.push(email);
      const id = `fake-${randomUUID()}`;
      ids.push(id);
      return { ok: true, messageId: id };
    },
  };
}

function delivery(sender: EmailSender) {
  const recorder: DeliveryRecorder = createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
  return { sender, appOrigin: APP_ORIGIN, recorder };
}

let counter = 0;
const address = (tag: string) => `lb183-${tag}-${++counter}-${randomUUID().slice(0, 8)}@example.com`;

type Party = { id: string; token: string; weddingId: string; guestIds: string[] };

async function newParty(weddingId: string, contactEmail: string | null, owner: TestUserKey = "ownerA"): Promise<Party> {
  const result = await createGuestParty(
    await sessionClient(owner),
    weddingId,
    { label: `Familia ${++counter}`, guestNames: ["Ana Prueba", "Carlos Prueba"], contactEmail },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  const guestIds = (
    await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1 order by created_at", [
      result.guestInvitationId,
    ])
  ).map((g) => g.id);
  return { id: result.guestInvitationId, token: result.token, weddingId, guestIds };
}

/** Sends the invitation through the real service (fake provider); returns the recorded provider id. */
async function invite(party: Party, owner: TestUserKey = "ownerA"): Promise<string> {
  const sender = fakeSender();
  const outcome = await sendGuestInvitationEmail(
    await sessionClient(owner),
    party.weddingId,
    party.id,
    party.token,
    delivery(sender),
  );
  if (outcome.outcome !== "sent") throw new Error(`invitation not sent: ${JSON.stringify(outcome)}`);
  return sender.ids[0]!;
}

/** The provider reports an outcome, through the webhook's one writer. */
async function report(providerMessageId: string, eventType: EventType) {
  const { data, error } = await serviceRole.rpc("ingest_email_delivery_event", {
    provider_event_id: `msg_lb183${randomUUID().replace(/-/g, "")}`,
    provider_message_id: providerMessageId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    ...(eventType === "bounced" ? { bounce_type: "permanent" as const } : {}),
  });
  if (error || data !== "applied") throw new Error(`ingest failed: ${error?.message ?? data}`);
}

async function block(party: Party, recipient: string, user: keyof typeof as = "ownerA") {
  return as[user].rpc("get_guest_invitation_email_block", {
    target_wedding_id: party.weddingId,
    target_invitation_id: party.id,
    target_recipient: recipient,
  });
}

/** Everything a blocked send must leave untouched (ground truth). */
async function sideEffects(partyId: string) {
  const [row] = await sql<Record<string, unknown>>(
    `select i.token_hash, i.token_issued_at,
            i.invitation_email_sent_at, i.invitation_email_sent_to, i.invitation_email_provider_id,
            i.rsvp_confirmation_email_sent_at, i.rsvp_confirmation_email_sent_to,
            i.rsvp_reminder_email_sent_at, i.rsvp_reminder_email_sent_to, i.rsvp_reminder_email_provider_id,
            (select count(*)::int from public.wedding_activity a where a.guest_invitation_id = i.id) as activity,
            (select count(*)::int from public.email_deliveries d where d.guest_invitation_id = i.id) as deliveries
     from public.guest_invitations i where i.id = $1`,
    [partyId],
  );
  return row!;
}

async function deliveryRows(partyId: string) {
  return sql<{ recipient: string; status: string; kind: string }>(
    "select recipient, status::text as status, kind::text as kind from public.email_deliveries where guest_invitation_id = $1 order by accepted_at, id",
    [partyId],
  );
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Estado Entrega A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Estado Entrega B");
  for (const id of [weddingA, weddingB]) {
    await sql("update public.weddings set wedding_date = '2090-06-01' where id = $1", [id]);
  }
});

// ------------------------------------------------------------------ reads

describe("member read of delivery status", () => {
  it("owners and collaborators read kind, recipient, accepted_at and status of their own wedding", async () => {
    const email = address("read");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "delivered");
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await as[actor]
        .from("email_deliveries")
        .select("id, wedding_id, guest_invitation_id, kind, recipient, accepted_at, status")
        .eq("guest_invitation_id", party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toHaveLength(1);
      expect(data![0], actor).toMatchObject({ kind: "guest_invitation", recipient: email, status: "delivered" });
    }
  });

  it("non-members see zero rows; anon has no privilege at all", async () => {
    const party = await newParty(weddingA, address("hidden"));
    await invite(party);
    for (const actor of ["ownerB", "outsider", "invitee"] as const) {
      const { data, error } = await as[actor].from("email_deliveries").select("kind, status").eq("guest_invitation_id", party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([]);
    }
    const anon = await as.anon.from("email_deliveries").select("status").eq("guest_invitation_id", party.id);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
  });

  it("provider_message_id, status_event_at and the event ledger stay unreadable for members", async () => {
    const party = await newParty(weddingA, address("private"));
    await report(await invite(party), "bounced");
    for (const actor of ["ownerA", "collabA"] as const) {
      for (const column of ["provider_message_id", "status_event_at", "*"]) {
        const { error } = await as[actor].from("email_deliveries").select(column).eq("guest_invitation_id", party.id);
        expect(error?.code, `${actor} ${column}`).toBe(PERMISSION_DENIED);
      }
      const events = await as[actor].from("email_delivery_events").select("event_type");
      expect(events.error?.code, actor).toBe(PERMISSION_DENIED);
    }
  });

  it("no client writes: status can't be inserted, updated or deleted by anyone", async () => {
    const party = await newParty(weddingA, address("write"));
    await invite(party);
    const [row] = await sql<{ id: string }>("select id from public.email_deliveries where guest_invitation_id = $1", [party.id]);
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      const client = as[actor];
      const updated = await client.from("email_deliveries").update({ status: "delivered" }).eq("id", row!.id);
      expect(updated.error?.code, `${actor} update`).toBe(PERMISSION_DENIED);
      const deleted = await client.from("email_deliveries").delete().eq("id", row!.id);
      expect(deleted.error?.code, `${actor} delete`).toBe(PERMISSION_DENIED);
      const inserted = await client.from("email_deliveries").insert({
        wedding_id: weddingA,
        guest_invitation_id: party.id,
        kind: "guest_invitation",
        provider_message_id: `forged-${randomUUID()}`,
        recipient: "x@example.com",
        status: "complained",
      });
      expect(inserted.error?.code, `${actor} insert`).toBe(PERMISSION_DENIED);
    }
    expect((await deliveryRows(party.id)).map((r) => r.status)).toEqual(["accepted"]);
  });

  it("column grants: authenticated SELECTs exactly the display columns plus status; no writes; anon nothing", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'email_deliveries' and grantee in ('anon', 'authenticated')
       order by grantee, privilege_type, column_name`,
    );
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(rows.filter((r) => r.privilege_type !== "SELECT")).toEqual([]);
    expect(rows.map((r) => r.column_name)).toEqual([
      "accepted_at",
      "guest_invitation_id",
      "id",
      "kind",
      "recipient",
      "status",
      "wedding_id",
    ]);
    const [events] = await sql<{ anon: boolean; authenticated: boolean }>(
      `select has_table_privilege('anon', 'public.email_delivery_events', 'select') as anon,
              has_table_privilege('authenticated', 'public.email_delivery_events', 'select') as authenticated`,
    );
    expect(events).toEqual({ anon: false, authenticated: false });
  });

  it("the guest list carries each party's deliveries for a collaborator, in one read, never a provider id", async () => {
    const email = address("list");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "delivery_delayed");
    const collab = await sessionClient("collabA");
    const access = await requireWeddingMembership(collab, weddingA);
    if (!access.ok) throw new Error("collaborator has no access");
    const listed = (await listGuestParties(collab, access.access))?.find((p) => p.id === party.id);
    expect(listed?.deliveries).toEqual([
      { kind: "guest_invitation", recipient: email, acceptedAt: expect.any(String), status: "delayed" },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/fake-|provider/);
  });
});

// ---------------------------------------------------------- the block rule

describe("get_guest_invitation_email_block (members, current address, one wedding)", () => {
  it.each([
    ["bounced", "bounced"],
    ["suppressed", "suppressed"],
    ["complained", "complained"],
    ["delivery_delayed", "none"],
    ["failed", "none"],
    ["delivered", "none"],
  ] as const)("same current address, event %s → %s", async (eventType, expected) => {
    const email = address(eventType);
    const party = await newParty(weddingA, email);
    await report(await invite(party), eventType);
    for (const actor of ["ownerA", "collabA"] as const) {
      expect((await block(party, email, actor)).data, actor).toBe(expected);
    }
  });

  it("accepted (no event yet) → none; no history → none", async () => {
    const email = address("accepted");
    const party = await newParty(weddingA, email);
    expect((await block(party, email)).data).toBe("none");
    await invite(party);
    expect((await block(party, email)).data).toBe("none");
  });

  it("the strongest wins: a bounce plus a complaint for the same address reads complained", async () => {
    const email = address("strongest");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "bounced");
    expect((await block(party, email)).data).toBe("bounced");
    // A second party with the same address (the app would no longer email it,
    // so its send is recorded straight through the real record function).
    const sibling = await newParty(weddingA, email);
    const providerId = `fake-${randomUUID()}`;
    const { error } = await serviceRole.rpc("record_guest_invitation_email", {
      target_wedding_id: weddingA,
      target_invitation_id: sibling.id,
      invitation_token_hash: createHash("sha256").update(sibling.token, "utf8").digest("hex"),
      recipient: email,
      provider_message_id: providerId,
      acting_user_id: users.ownerA.id,
    });
    expect(error).toBeNull();
    await report(providerId, "complained");
    expect((await block(party, email)).data).toBe("complained");
    expect((await block(sibling, email)).data).toBe("complained");
  });

  it("an old address's bounce never blocks the new address; the old history stays intact", async () => {
    const oldEmail = address("old");
    const newEmail = address("new");
    const party = await newParty(weddingA, oldEmail);
    await report(await invite(party), "bounced");
    expect((await block(party, oldEmail)).data).toBe("bounced");

    const edited = await updateGuestPartyContactEmail(await sessionClient("collabA"), weddingA, party.id, newEmail);
    expect(edited).toEqual({ ok: true });
    expect((await block(party, newEmail)).data).toBe("none");
    expect(await deliveryRows(party.id)).toEqual([{ recipient: oldEmail, status: "bounced", kind: "guest_invitation" }]);

    // Back to the bad address: blocked again (no override, no forgetting).
    await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, oldEmail);
    expect((await block(party, oldEmail)).data).toBe("bounced");
  });

  it("wedding-scoped: another party of the SAME wedding with that address is blocked too", async () => {
    const email = address("shared");
    const first = await newParty(weddingA, email);
    await report(await invite(first), "bounced");
    const second = await newParty(weddingA, email);
    expect((await block(second, email)).data).toBe("bounced");
  });

  it("cross-wedding: the same address bounced in wedding A never blocks wedding B", async () => {
    const email = address("cross");
    const inA = await newParty(weddingA, email);
    await report(await invite(inA), "complained");
    const inB = await newParty(weddingB, email, "ownerB");
    expect((await block(inB, email, "ownerB")).data).toBe("none");
    expect((await block(inA, email, "ownerA")).data).toBe("complained");
  });

  it("not current, not a member, or a party of another wedding → null; anon can't execute", async () => {
    const email = address("null");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "bounced");
    expect((await block(party, "otra@example.com")).data).toBeNull();
    for (const actor of ["ownerB", "outsider", "invitee"] as const) {
      const { data, error } = await block(party, email, actor);
      expect(error, actor).toBeNull();
      expect(data, actor).toBeNull();
    }
    // The right party under the wrong wedding id.
    const wrong = await as.ownerA.rpc("get_guest_invitation_email_block", {
      target_wedding_id: weddingB,
      target_invitation_id: party.id,
      target_recipient: email,
    });
    expect(wrong.data).toBeNull();
    const anon = await block(party, email, "anon");
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
  });

  it("grants: members' RPC for authenticated (never anon); the private determination has no grant at all", async () => {
    const rows = await sql<{ fn: string; role: string; can: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.fn::regprocedure, 'execute') as can
       from (values ('public.get_guest_invitation_email_block(uuid, uuid, text)'),
                    ('private.email_recipient_block(uuid, text)')) as f (fn)
       cross join (values ('anon'), ('authenticated'), ('service_role')) as r (role)
       order by f.fn, r.role`,
    );
    expect(rows).toEqual([
      { fn: "private.email_recipient_block(uuid, text)", role: "anon", can: false },
      { fn: "private.email_recipient_block(uuid, text)", role: "authenticated", can: false },
      { fn: "private.email_recipient_block(uuid, text)", role: "service_role", can: false },
      { fn: "public.get_guest_invitation_email_block(uuid, uuid, text)", role: "anon", can: false },
      { fn: "public.get_guest_invitation_email_block(uuid, uuid, text)", role: "authenticated", can: true },
      // Like every member RPC here (Supabase's default privileges): without a
      // user there is no membership, so service_role only ever gets null.
      { fn: "public.get_guest_invitation_email_block(uuid, uuid, text)", role: "service_role", can: true },
    ]);
    const party = await newParty(weddingA, address("sr"));
    const asService = await serviceRole.rpc("get_guest_invitation_email_block", {
      target_wedding_id: weddingA,
      target_invitation_id: party.id,
      target_recipient: (await sql<{ e: string }>("select contact_email as e from public.guest_invitations where id = $1", [party.id]))[0]!.e,
    });
    expect(asService.error).toBeNull();
    expect(asService.data).toBeNull();
  });
});

// ------------------------------------------------------ manual send guards

describe("manual invitation email: same-address guard", () => {
  it.each(["bounced", "suppressed", "complained"] as const)(
    "%s current address: no provider call, no metadata, activity or ledger change; edit → sendable",
    async (eventType) => {
      const email = address(`inv-${eventType}`);
      const party = await newParty(weddingA, email);
      await report(await invite(party), eventType);
      const before = await sideEffects(party.id);

      const sender = fakeSender();
      const outcome = await sendGuestInvitationEmail(await sessionClient("collabA"), weddingA, party.id, party.token, delivery(sender));
      expect(outcome).toEqual({
        outcome: "failed",
        reason: eventType === "complained" ? "recipient_complained" : "recipient_undeliverable",
      });
      expect(sender.sent).toHaveLength(0);
      expect(await sideEffects(party.id)).toEqual(before);

      // Owner "new link and send": nothing rotated either.
      const rotated = await rotateLinkAndSendInvitation(await sessionClient("ownerA"), weddingA, party.id, delivery(sender), ENCRYPTION);
      expect(rotated.outcome).toBe("failed");
      expect(rotated.link).toBeUndefined();
      expect(sender.sent).toHaveLength(0);
      expect(await sideEffects(party.id)).toEqual(before);

      // Editing the address makes it sendable again.
      const newEmail = address("inv-fixed");
      await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, newEmail);
      const again = await sendGuestInvitationEmail(await sessionClient("collabA"), weddingA, party.id, party.token, delivery(sender));
      expect(again).toMatchObject({ outcome: "sent", recipient: newEmail });
      expect(sender.sent.map((e) => e.to)).toEqual([newEmail]);
      expect((await deliveryRows(party.id)).map((r) => [r.recipient, r.status])).toEqual([
        [email, eventType],
        [newEmail, "accepted"],
      ]);
    },
  );

  it.each(["delivery_delayed", "failed"] as const)("%s: a manual retry to the same address is sent", async (eventType) => {
    const email = address(`inv-retry-${eventType}`);
    const party = await newParty(weddingA, email);
    await report(await invite(party), eventType);
    const sender = fakeSender();
    const outcome = await sendGuestInvitationEmail(await sessionClient("ownerA"), weddingA, party.id, party.token, delivery(sender));
    expect(outcome).toMatchObject({ outcome: "sent", recipient: email });
    expect(sender.sent).toHaveLength(1);
  });
});

describe("manual RSVP reminder: same-address guard", () => {
  it.each(["bounced", "suppressed", "complained"] as const)(
    "%s current address: email blocked with zero side effects; WhatsApp text still works; edit → sendable",
    async (eventType) => {
      const email = address(`rem-${eventType}`);
      const party = await newParty(weddingA, email);
      await report(await invite(party), eventType);
      const before = await sideEffects(party.id);

      const sender = fakeSender();
      for (const actor of ["ownerA", "collabA"] as const) {
        const outcome = await sendRsvpReminderEmail(await sessionClient(actor), weddingA, party.id, delivery(sender), ENCRYPTION);
        expect(outcome, actor).toEqual({
          outcome: eventType === "complained" ? "recipient_complained" : "recipient_undeliverable",
        });
      }
      expect(sender.sent).toHaveLength(0);
      expect(await sideEffects(party.id)).toEqual(before);

      // Manual link sharing is never blocked.
      const text = await prepareRsvpReminderMessage(await sessionClient("collabA"), weddingA, party.id, LINK_CONFIG);
      expect(text.ok).toBe(true);

      const newEmail = address("rem-fixed");
      await updateGuestPartyContactEmail(await sessionClient("collabA"), weddingA, party.id, newEmail);
      const again = await sendRsvpReminderEmail(await sessionClient("collabA"), weddingA, party.id, delivery(sender), ENCRYPTION);
      expect(again).toMatchObject({ outcome: "sent", recipient: newEmail });
      expect(sender.sent.map((e) => e.to)).toEqual([newEmail]);
    },
  );

  it.each(["delivery_delayed", "failed", "delivered"] as const)("%s: the reminder is sent to the same address", async (eventType) => {
    const email = address(`rem-ok-${eventType}`);
    const party = await newParty(weddingA, email);
    await report(await invite(party), eventType);
    const sender = fakeSender();
    const outcome = await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery(sender), ENCRYPTION);
    expect(outcome).toMatchObject({ outcome: "sent", recipient: email });
  });
});

// ------------------------------------------------------ RSVP confirmation

describe("RSVP confirmation: skipped for a blocked address, the RSVP always saved", () => {
  const answers = (ids: string[]) => ids.map((guestId) => ({ guestId, attending: true, dietaryNote: null }));

  it("the service_role context reports the current address's block (and only service_role reads it)", async () => {
    const email = address("ctx");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "complained");
    const hash = createHash("sha256").update(party.token, "utf8").digest("hex");
    const { data } = await serviceRole.rpc("get_rsvp_confirmation_email_context", { invitation_token_hash: hash });
    expect(data?.[0]).toMatchObject({ contact_email: email, contact_email_block: "complained" });
    for (const actor of ["anon", "ownerA"] as const) {
      const denied = await as[actor].rpc("get_rsvp_confirmation_email_context", { invitation_token_hash: hash });
      expect(denied.error?.code, actor).toBe(PERMISSION_DENIED);
    }
  });

  it.each(["bounced", "suppressed", "complained"] as const)(
    "%s: the RSVP is saved; no provider call, no confirmation metadata or ledger row; edit → sent again",
    async (eventType) => {
      const email = address(`conf-${eventType}`);
      const party = await newParty(weddingA, email);
      await report(await invite(party), eventType);
      const before = await sideEffects(party.id);

      const sender = fakeSender();
      const result = await submitRsvpWithConfirmation(anonClient(), party.token, answers(party.guestIds), () => delivery(sender));
      expect(result).toMatchObject({ rsvp: "saved", confirmation: "skipped_undeliverable" });
      expect(sender.sent).toHaveLength(0);
      const saved = await sql<{ saved: number }>(
        "select count(*)::int as saved from public.rsvps r join public.guests g on g.id = r.guest_id where g.guest_invitation_id = $1",
        [party.id],
      );
      expect(saved).toEqual([{ saved: 2 }]);
      const after = await sideEffects(party.id);
      expect(after.rsvp_confirmation_email_sent_at).toBeNull();
      expect(after.deliveries).toBe(before.deliveries);
      expect((await deliveryRows(party.id)).filter((r) => r.kind === "rsvp_confirmation")).toEqual([]);

      const newEmail = address("conf-fixed");
      await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, newEmail);
      const again = await submitRsvpWithConfirmation(anonClient(), party.token, answers(party.guestIds), () => delivery(sender));
      expect(again).toMatchObject({ rsvp: "saved", confirmation: "sent" });
      expect(sender.sent.map((e) => e.to)).toEqual([newEmail]);
    },
  );

  it("a clean address gets its confirmation as before", async () => {
    const email = address("conf-clean");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "delivered");
    const sender = fakeSender();
    const result = await submitRsvpWithConfirmation(anonClient(), party.token, answers(party.guestIds), () => delivery(sender));
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(sender.sent.map((e) => e.to)).toEqual([email]);
  });
});

// ------------------------------------------- case-insensitive comparison

// Addresses are compared trimmed + lowercased (private.email_comparison_form,
// mirrored by normalizeEmailForComparison). Stored values keep their casing;
// nothing provider-specific (dots, +tags) is applied. The ledger's recipient
// CHECK only allows a lowercase domain, so case variants live in the local part.
describe("case-insensitive address comparison (comparison only)", () => {
  const upperLocal = (email: string) => email.replace(/^[^@]+/, (local) => local.toUpperCase());
  const titleLocal = (email: string) => email.charAt(0).toUpperCase() + email.slice(1);

  it.each(["bounced", "suppressed", "complained"] as const)(
    "A: bad lowercase address, case-only edit (%s) → still blocked for warning, invitation, reminder and confirmation",
    async (eventType) => {
      const email = address(`case-${eventType}`);
      const party = await newParty(weddingA, email);
      await report(await invite(party), eventType);

      const caseOnly = titleLocal(email);
      expect(caseOnly).not.toBe(email);
      expect(await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, caseOnly)).toEqual({ ok: true });
      // Stored and displayed casing is kept; the ledger row is untouched.
      const [stored] = await sql<{ contact_email: string }>("select contact_email from public.guest_invitations where id = $1", [party.id]);
      expect(stored!.contact_email).toBe(caseOnly);
      expect(await deliveryRows(party.id)).toEqual([{ recipient: email, status: eventType, kind: "guest_invitation" }]);

      expect((await block(party, caseOnly)).data).toBe(eventType);
      const reason = eventType === "complained" ? "recipient_complained" : "recipient_undeliverable";
      const sender = fakeSender();
      expect(
        await sendGuestInvitationEmail(await sessionClient("collabA"), weddingA, party.id, party.token, delivery(sender)),
      ).toEqual({ outcome: "failed", reason });
      expect(await sendRsvpReminderEmail(await sessionClient("collabA"), weddingA, party.id, delivery(sender), ENCRYPTION)).toEqual({
        outcome: reason,
      });
      const rsvp = await submitRsvpWithConfirmation(
        anonClient(),
        party.token,
        party.guestIds.map((guestId) => ({ guestId, attending: true, dietaryNote: null })),
        () => delivery(sender),
      );
      expect(rsvp).toMatchObject({ rsvp: "saved", confirmation: "skipped_undeliverable" });
      expect(sender.sent).toHaveLength(0);
    },
  );

  it("B: bad UPPERCASE address, current lowercase → blocked (and the context agrees)", async () => {
    const lower = address("upper");
    const upper = upperLocal(lower);
    const party = await newParty(weddingA, upper);
    await report(await invite(party), "bounced");
    await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, lower);
    expect((await block(party, lower)).data).toBe("bounced");
    const hash = createHash("sha256").update(party.token, "utf8").digest("hex");
    const { data } = await serviceRole.rpc("get_rsvp_confirmation_email_context", { invitation_token_hash: hash });
    expect(data?.[0]).toMatchObject({ contact_email: lower, contact_email_block: "bounced" });
  });

  it("C: a genuinely different address (victor2@) clears the block", async () => {
    const email = address("victor");
    const party = await newParty(weddingA, email);
    await report(await invite(party), "complained");
    const different = email.replace("@", "2@");
    await updateGuestPartyContactEmail(await sessionClient("ownerA"), weddingA, party.id, different);
    expect((await block(party, different)).data).toBe("none");
    const sender = fakeSender();
    expect(
      await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery(sender), ENCRYPTION),
    ).toMatchObject({ outcome: "sent", recipient: different });
  });

  it("D/E: no Gmail dot rules and no +tag collapsing", async () => {
    const tag = randomUUID().slice(0, 8);
    const dotted = await newParty(weddingA, `victor.test${tag}@gmail.com`);
    await report(await invite(dotted), "bounced");
    const plus = await newParty(weddingA, `victor${tag}+one@example.com`);
    await report(await invite(plus), "bounced");

    const dotless = await newParty(weddingA, `victortest${tag}@gmail.com`);
    expect((await block(dotless, `victortest${tag}@gmail.com`)).data).toBe("none");
    const otherTag = await newParty(weddingA, `victor${tag}+two@example.com`);
    expect((await block(otherTag, `victor${tag}+two@example.com`)).data).toBe("none");
    const untagged = await newParty(weddingA, `victor${tag}@example.com`);
    expect((await block(untagged, `victor${tag}@example.com`)).data).toBe("none");
  });

  it("F: cross-wedding isolation still holds for case variants", async () => {
    const email = address("cross-case");
    const inA = await newParty(weddingA, email);
    await report(await invite(inA), "complained");
    const inB = await newParty(weddingB, titleLocal(email), "ownerB");
    expect((await block(inB, titleLocal(email), "ownerB")).data).toBe("none");
  });
});
