import { createHash } from "node:crypto";

import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveryRecordResult, DeliveryRecorder, InvitationRecord } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

vi.mock("server-only", () => ({}));

// LB-17: the provider timeout and idempotency key are opt-in per call, owned
// by the automatic scheduler. This manual flow passes no options at all, so
// its provider behavior is exactly what it was before LB-17.
const sendOptions: unknown[][] = [];
beforeEach(() => {
  sendOptions.length = 0;
});
afterEach(() => {
  for (const options of sendOptions) expect(options).toEqual([]);
});

const { rotateLinkAndSendInvitation, sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");

// Application-layer tests of the send orchestration: a real supabase-js
// client (the USER's session) against a fake HTTP backend, a fake email
// sender and a fake privileged recorder (ADR-004), asserting the ORDER of
// operations (authorize → check → send → record), that the provider is never
// reached on a failed check, that the recorder runs only after the provider
// accepted, that the user's session never writes send metadata, and how
// partial failures are reported. The same flows run against the real database in
// tests/db/guest-invitation-email-service.test.ts.

const SUPABASE_URL = "http://supabase.test";
const APP_ORIGIN = "https://bodas.example.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "T".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const SENT_AT = "2026-10-03T12:00:00+00:00";
/** LB-13: the server's (fake, test-only) link-encryption key. */
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const ROTATE_RPC = "POST /rest/v1/rpc/rotate_guest_invitation_link";
const BLOCK_RPC = "POST /rest/v1/rpc/get_guest_invitation_email_block";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  noSession?: boolean;
  replies?: Record<string, Reply>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStorage(): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>([
    [
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    ],
  ]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const PARTY_ROW = { id: PARTY_ID, label: "Familia Pérez", contact_email: "familia@example.com" };

/** Replies for a send that should go through end to end. */
function happyReplies(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    "GET /rest/v1/guest_invitations": { status: 200, body: [PARTY_ROW] },
    // LB-18.3: the same-address delivery guard; "none" = sendable.
    [BLOCK_RPC]: { status: 200, body: "none" },
    "POST /rest/v1/rpc/guest_invitation_link_is_current": { status: 200, body: true },
    "GET /rest/v1/weddings": {
      status: 200,
      body: [{ id: WEDDING_ID, name: "Boda Prueba", wedding_date: null, city: null, time_zone: null }],
    },
    "GET /rest/v1/wedding_publications": { status: 200, body: [] },
    [ROTATE_RPC]: { status: 200, body: true },
    // The user's session can't execute record_guest_invitation_email (only
    // service_role can); any attempt would hit "unexpected request" here.
    ...overrides,
  };
}

function clientFor(backend: Backend) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    if (url.pathname === "/auth/v1/user") {
      if (backend.noSession) return json({ message: "invalid JWT" }, 401);
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (method === "GET" && url.pathname === "/rest/v1/wedding_memberships") {
      return json(backend.role ? [{ id: MY_MEMBERSHIP, role: backend.role }] : []);
    }
    const reply = backend.replies?.[`${method} ${url.pathname}`];
    if (reply) return json(reply.body, reply.status);
    return json({ message: "unexpected request" }, 500);
  };
  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}

/** "METHOD /path" of every Data API request, in order. */
const dataCalls = (requests: Recorded[]) =>
  requests
    .filter((r) => r.url.pathname.startsWith("/rest/v1/") && r.url.pathname !== "/rest/v1/wedding_memberships")
    .map((r) => `${r.method} ${r.url.pathname}`);

const RECORD_RPC = "POST /rest/v1/rpc/record_guest_invitation_email";

/** A fake sender and a fake privileged recorder sharing one call log. */
function fakeSender(
  result: EmailSendResult = { ok: true, messageId: "msg_1" },
  recordResult: DeliveryRecordResult | "throw" = { ok: true, sentAt: SENT_AT },
) {
  const sent: OutgoingEmail[] = [];
  const records: InvitationRecord[] = [];
  const order: string[] = [];
  const sender: EmailSender = {
    async send(email, ...options: unknown[]) {
      sendOptions.push(options);
      sent.push(email);
      order.push("SEND");
      return result;
    },
  };
  const notInvitation = async () => {
    order.push("WRONG_OPERATION");
    return { ok: false } as const;
  };
  const recorder: DeliveryRecorder = {
    async recordInvitation(entry: InvitationRecord) {
      records.push(entry);
      order.push("RECORD");
      if (recordResult === "throw") throw new Error("network down");
      return recordResult;
    },
    readRsvpConfirmationContext: notInvitation,
    recordRsvpConfirmation: notInvitation,
    recordRsvpReminder: notInvitation,
  };
  return { sender, sent, records, order, delivery: { sender, appOrigin: APP_ORIGIN, recorder } };
}

describe("sendGuestInvitationEmail", () => {
  it("authorizes, checks the link, sends once, then records — with the hash, never the token", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator", replies: happyReplies() });
    const fake = fakeSender();

    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "sent",
      recipient: "familia@example.com",
      sentAt: SENT_AT,
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe("familia@example.com");
    expect(fake.sent[0]!.text).toContain(`${APP_ORIGIN}/rsvp/${TOKEN}`);

    const calls = dataCalls(requests);
    // Never a rotation from this path, and the user's session never writes
    // send metadata: the privileged recorder does, once, after the send.
    expect(calls).not.toContain(ROTATE_RPC);
    expect(calls).not.toContain("PATCH /rest/v1/guest_invitations");
    expect(calls).not.toContain(RECORD_RPC);
    expect(fake.order).toEqual(["SEND", "RECORD"]);

    const check = requests.find((r) => r.url.pathname.endsWith("/guest_invitation_link_is_current"));
    expect(check?.body).toEqual({
      target_wedding_id: WEDDING_ID,
      target_invitation_id: PARTY_ID,
      invitation_token_hash: TOKEN_HASH,
    });
    // The provider's id (from its response), the authorized wedding, the
    // party, the hash — never the plaintext token — and (LB-15) the member
    // from the server's own session check, for the activity history.
    expect(fake.records).toEqual([
      {
        weddingId: WEDDING_ID,
        guestInvitationId: PARTY_ID,
        tokenHash: TOKEN_HASH,
        recipient: "familia@example.com",
        providerMessageId: "msg_1",
        actingUserId: USER_ID,
      },
    ]);
    // The plaintext token never reaches the database.
    expect(JSON.stringify(requests.map((r) => [r.url.toString(), r.body]))).not.toContain(TOKEN);
  });

  it("the party is looked up inside the authorized wedding only", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fakeSender().delivery);
    const lookup = requests.find((r) => r.method === "GET" && r.url.pathname === "/rest/v1/guest_invitations");
    expect(lookup?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(lookup?.url.searchParams.get("id")).toBe(`eq.${PARTY_ID}`);
  });

  it.each<[string, Backend, string, string]>([
    ["no session", { noSession: true, role: "owner", replies: happyReplies() }, TOKEN, "unauthenticated"],
    ["not a member", { role: null, replies: happyReplies() }, TOKEN, "not_found"],
    ["malformed token", { role: "owner", replies: happyReplies() }, "not-a-token", "invalid_token"],
    [
      "party not in this wedding",
      { role: "owner", replies: happyReplies({ "GET /rest/v1/guest_invitations": { status: 200, body: [] } }) },
      TOKEN,
      "invalid_target",
    ],
    [
      "no contact email",
      {
        role: "owner",
        replies: happyReplies({
          "GET /rest/v1/guest_invitations": { status: 200, body: [{ ...PARTY_ROW, contact_email: null }] },
        }),
      },
      TOKEN,
      "missing_email",
    ],
    [
      "stored email not in stored form",
      {
        role: "owner",
        replies: happyReplies({
          "GET /rest/v1/guest_invitations": {
            status: 200,
            body: [{ ...PARTY_ROW, contact_email: "ana@example.com\r\nBcc: x@example.com" }],
          },
        }),
      },
      TOKEN,
      "invalid_email",
    ],
    [
      "not the current link",
      {
        role: "owner",
        replies: happyReplies({
          "POST /rest/v1/rpc/guest_invitation_link_is_current": { status: 200, body: false },
        }),
      },
      TOKEN,
      "invalid_token",
    ],
  ])("never calls the provider when the check fails: %s", async (_case, backend, token, reason) => {
    const { supabase, requests } = clientFor(backend);
    const fake = fakeSender();
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, token, fake.delivery)).toEqual({
      outcome: "failed",
      reason,
    });
    expect(fake.sent).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
    expect(dataCalls(requests)).not.toContain(RECORD_RPC);
  });

  it("missing configuration fails before loading anything", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, null)).toEqual({
      outcome: "failed",
      reason: "configuration_error",
    });
    expect(dataCalls(requests)).toEqual([]);
  });

  it.each<[EmailSendResult, string]>([
    [{ ok: false, reason: "provider_failure" }, "provider_failed"],
    [{ ok: false, reason: "unknown" }, "provider_failed"],
    [{ ok: false, reason: "configuration" }, "configuration_error"],
    [{ ok: false, reason: "invalid_recipient" }, "recipient_rejected"],
  ])("provider failure %j → %s, nothing recorded", async (result, reason) => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender(result);
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "failed",
      reason,
    });
    expect(fake.sent).toHaveLength(1);
    // The privileged recorder is never reached when the provider failed.
    expect(fake.records).toHaveLength(0);
    expect(dataCalls(requests)).not.toContain(RECORD_RPC);
  });

  it.each<[string, DeliveryRecordResult | "throw"]>([
    ["refused", { ok: false }],
    ["throws", "throw"],
  ])("sent but the recorder %s → sent_but_unrecorded, one send, one record attempt", async (_case, recordResult) => {
    const { supabase } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender({ ok: true, messageId: "msg_1" }, recordResult);
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "sent_but_unrecorded",
      recipient: "familia@example.com",
    });
    // No automatic resend, no retried record.
    expect(fake.order).toEqual(["SEND", "RECORD"]);
  });

  it("accepted without a storable id → sent_but_unrecorded, no record attempt", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender({ ok: true, messageId: null });
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "sent_but_unrecorded",
      recipient: "familia@example.com",
    });
    expect(dataCalls(requests)).not.toContain(RECORD_RPC);
    expect(fake.records).toHaveLength(0);
  });

  it("includes the website link only when the wedding's site is published", async () => {
    const published = clientFor({
      role: "owner",
      replies: happyReplies({
        "GET /rest/v1/wedding_publications": {
          status: 200,
          body: [{ slug: "ana-y-luis", published_at: "2026-10-01T00:00:00Z" }],
        },
      }),
    });
    const withSite = fakeSender();
    await sendGuestInvitationEmail(published.supabase, WEDDING_ID, PARTY_ID, TOKEN, withSite.delivery);
    expect(withSite.sent[0]!.text).toContain(`${APP_ORIGIN}/boda/ana-y-luis`);

    const unpublished = clientFor({
      role: "owner",
      replies: happyReplies({
        "GET /rest/v1/wedding_publications": { status: 200, body: [{ slug: "ana-y-luis", published_at: null }] },
      }),
    });
    const withoutSite = fakeSender();
    await sendGuestInvitationEmail(unpublished.supabase, WEDDING_ID, PARTY_ID, TOKEN, withoutSite.delivery);
    expect(withoutSite.sent[0]!.text).not.toContain("/boda/");
  });
});

describe("rotateLinkAndSendInvitation", () => {
  it("owner: rotates, then sends the NEW link, then records; returns the new link", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender();
    const outcome = await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION);

    expect(outcome).toMatchObject({ outcome: "sent", recipient: "familia@example.com" });
    const fresh = outcome.link;
    if (!fresh) throw new Error("expected the new link");
    expect(fresh.link).toBe(`${APP_ORIGIN}/rsvp/${fresh.token}`);
    expect(fake.sent[0]!.text).toContain(fresh.link);

    // Rotation (user's session) → send → record (privileged), in that order.
    expect(dataCalls(requests).at(-1)).toBe(ROTATE_RPC);
    expect(fake.order).toEqual(["SEND", "RECORD"]);
    // The rotation sends the new hash and its envelope (never the token);
    // the record names that same link.
    const rotation = requests.find((r) => `${r.method} ${r.url.pathname}` === ROTATE_RPC);
    const newHash = createHash("sha256").update(fresh.token).digest("hex");
    expect(rotation?.body).toMatchObject({ invitation_token_hash: newHash });
    expect(JSON.stringify(rotation?.body)).not.toContain(fresh.token);
    expect(fake.records).toEqual([expect.objectContaining({ tokenHash: newHash, providerMessageId: "msg_1" })]);
  });

  it("collaborator: forbidden before any read, rotation or send", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator", replies: happyReplies() });
    const fake = fakeSender();
    expect(await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({
      outcome: "failed",
      reason: "forbidden",
    });
    expect(dataCalls(requests)).toEqual([]);
    expect(fake.sent).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
  });

  it.each<[string, Record<string, Reply>, boolean, string]>([
    ["no contact email", { "GET /rest/v1/guest_invitations": { status: 200, body: [{ ...PARTY_ROW, contact_email: null }] } }, true, "missing_email"],
    ["party not in this wedding", { "GET /rest/v1/guest_invitations": { status: 200, body: [] } }, true, "invalid_target"],
    ["wedding can't be loaded", { "GET /rest/v1/weddings": { status: 500, body: { message: "x" } } }, true, "error"],
    ["email not configured", {}, false, "configuration_error"],
  ])("never rotates when the email can't go out: %s", async (_case, overrides, configured, reason) => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(overrides) });
    const fake = fakeSender();
    const outcome = await rotateLinkAndSendInvitation(
      supabase,
      WEDDING_ID,
      PARTY_ID,
      configured ? fake.delivery : null,
      ENCRYPTION,
    );
    expect(outcome).toEqual({ outcome: "failed", reason });
    expect(dataCalls(requests)).not.toContain(ROTATE_RPC);
    expect(fake.sent).toHaveLength(0);
  });

  it("never rotates without the link-encryption key (LB-13): the old link stays", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender();
    expect(await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, null)).toEqual({
      outcome: "failed",
      reason: "link_configuration_error",
    });
    expect(dataCalls(requests)).not.toContain(ROTATE_RPC);
    expect(fake.sent).toHaveLength(0);
  });

  it("provider failure after rotating: the rotation stands and the new link is returned", async () => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies() });
    const fake = fakeSender({ ok: false, reason: "provider_failure" });
    const outcome = await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "provider_failed" });
    expect(outcome.link?.link).toMatch(/^https:\/\/bodas\.example\.com\/rsvp\/[A-Za-z0-9_-]{43}$/);
    // No rollback attempt: exactly one PATCH (the rotation), no record.
    const calls = dataCalls(requests);
    expect(calls.filter((c) => c === ROTATE_RPC)).toHaveLength(1);
    expect(calls).not.toContain(RECORD_RPC);
    expect(fake.records).toHaveLength(0);
  });

  it("the database refusing the rotation (role changed) stops before sending", async () => {
    const { supabase } = clientFor({
      role: "owner",
      replies: happyReplies({
        [ROTATE_RPC]: {
          status: 403,
          body: { code: "42501", message: "guest_link_owner_only" },
        },
      }),
    });
    const fake = fakeSender();
    expect(await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({
      outcome: "failed",
      reason: "forbidden",
    });
    expect(fake.sent).toHaveLength(0);
  });
});

// LB-18.3 (ADR-011 §9): the same-address delivery guard. The database answers
// for the party's CURRENT contact email in the authorized wedding; a blocked
// address stops everything before the provider (and before any rotation).
describe("same-address delivery guard (LB-18.3)", () => {
  const blocked = (block: string): Record<string, Reply> => ({ [BLOCK_RPC]: { status: 200, body: block } });

  it("asks about the party's current address, scoped to the authorized wedding, as the member", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator", replies: happyReplies() });
    await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fakeSender().delivery);
    const check = requests.find((r) => `${r.method} ${r.url.pathname}` === BLOCK_RPC);
    expect(check?.body).toEqual({
      target_wedding_id: WEDDING_ID,
      target_invitation_id: PARTY_ID,
      target_recipient: "familia@example.com",
    });
    // Before the link check and the provider.
    const calls = dataCalls(requests);
    expect(calls.indexOf(BLOCK_RPC)).toBeLessThan(calls.indexOf("POST /rest/v1/rpc/guest_invitation_link_is_current"));
  });

  it.each([
    ["bounced", "recipient_undeliverable"],
    ["suppressed", "recipient_undeliverable"],
    ["complained", "recipient_complained"],
  ] as const)("fresh link, current address %s → %s: provider 0, recorder 0", async (block, reason) => {
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(blocked(block)) });
    const fake = fakeSender();
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "failed",
      reason,
    });
    expect(fake.sent).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
    expect(fake.order).toEqual([]);
    const calls = dataCalls(requests);
    expect(calls).not.toContain("POST /rest/v1/rpc/guest_invitation_link_is_current");
    expect(calls).not.toContain(RECORD_RPC);
    expect(calls.filter((c) => !c.startsWith("GET ") && c !== BLOCK_RPC)).toEqual([]);
  });

  it.each(["bounced", "suppressed", "complained"] as const)(
    "rotate and send, current address %s: nothing rotated, nothing sent, no link returned",
    async (block) => {
      const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(blocked(block)) });
      const fake = fakeSender();
      const outcome = await rotateLinkAndSendInvitation(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION);
      expect(outcome.outcome).toBe("failed");
      expect(outcome.link).toBeUndefined();
      expect(dataCalls(requests)).not.toContain(ROTATE_RPC);
      expect(fake.sent).toHaveLength(0);
      expect(fake.records).toHaveLength(0);
    },
  );

  it("none (clean, delayed, failed, delivered or an edited address) → sent and recorded", async () => {
    const { supabase } = clientFor({ role: "owner", replies: happyReplies(blocked("none")) });
    const fake = fakeSender();
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toMatchObject({
      outcome: "sent",
    });
    expect(fake.order).toEqual(["SEND", "RECORD"]);
  });

  it.each([
    ["null (address changed in between, or not visible)", { status: 200, body: null }],
    ["an unknown value", { status: 200, body: "maybe" }],
    ["a database error", { status: 500, body: { code: "XX000", message: "boom" } }],
  ])("fails closed on %s: provider 0", async (_label, reply) => {
    const { supabase } = clientFor({ role: "owner", replies: happyReplies({ [BLOCK_RPC]: reply }) });
    const fake = fakeSender();
    expect(await sendGuestInvitationEmail(supabase, WEDDING_ID, PARTY_ID, TOKEN, fake.delivery)).toEqual({
      outcome: "failed",
      reason: "error",
    });
    expect(fake.sent).toHaveLength(0);
  });
});
