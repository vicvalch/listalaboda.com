import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliveryRecordResult, DeliveryRecorder, RsvpReminderRecord } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

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

// Every way a link could be minted or replaced, spied: a reminder must
// never reach any of them (ADR-007 §1).
const tokenSpies = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/security/capability-token", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/security/capability-token")>();
  return {
    ...real,
    generateCapabilityToken: (...args: Parameters<typeof real.generateCapabilityToken>) => {
      tokenSpies.generate();
      return real.generateCapabilityToken(...args);
    },
  };
});
const encryptSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security/rsvp-capability-encryption", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/security/rsvp-capability-encryption")>();
  return {
    ...real,
    encryptRsvpCapability: (...args: Parameters<typeof real.encryptRsvpCapability>) => {
      encryptSpy();
      return real.encryptRsvpCapability(...args);
    },
  };
});
const serviceSpies = vi.hoisted(() => ({ rotate: vi.fn(), replace: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/guests/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/guests/service")>();
  return {
    ...real,
    rotateGuestPartyLink: serviceSpies.rotate,
    replaceGuestPartyLink: serviceSpies.replace,
    revokeGuestPartyLink: serviceSpies.revoke,
  };
});

const { prepareRsvpReminderMessage, sendRsvpReminderEmail } = await import("@/lib/guests/rsvp-reminder");
const { encryptRsvpCapability } = await import("@/lib/security/rsvp-capability-encryption");
const { generateCapabilityToken } = await import("@/lib/security/capability-token");

// LB-14 (ADR-007): the reminder orchestration against a fake HTTP backend
// (the USER's session), a fake email sender and a fake privileged recorder.
// It asserts the order (authorize → party → recover → send → record), that
// the reminder carries the SAME current link, that nothing is ever rotated
// or minted, and how every failure is reported. The same flows run against
// the real database in tests/db/rsvp-reminder-service.test.ts.

const SUPABASE_URL = "http://supabase.test";
const APP_ORIGIN = "https://bodas.example.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const SENT_AT = "2026-10-04T12:00:00+00:00";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const LINK_CONFIG = { appOrigin: APP_ORIGIN, encryption: ENCRYPTION };

const RECOVERY_RPC = "POST /rest/v1/rpc/get_guest_invitation_recovery_envelope";
const ROTATE_RPC = "POST /rest/v1/rpc/rotate_guest_invitation_link";
const RECORD_RPC = "POST /rest/v1/rpc/record_rsvp_reminder_email";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };
type Backend = { role?: "owner" | "collaborator" | null; noSession?: boolean; replies?: Record<string, Reply> };

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

/** A party whose link was created (and stored recoverably) in an earlier request. */
function storedLink(key = TEST_RSVP_CAPABILITY_KEY) {
  const { token, tokenHash } = generateCapabilityToken();
  const envelope = encryptRsvpCapability({ token, tokenHash, key });
  // That was the fixture's own (earlier) creation, not the code under test.
  tokenSpies.generate.mockClear();
  encryptSpy.mockClear();
  return { token, tokenHash, envelope };
}

const recoverable = (link: ReturnType<typeof storedLink>): Reply => ({
  status: 200,
  body: [{ link_state: "recoverable", token_hash: link.tokenHash, token_ciphertext: link.envelope }],
});

const PARTY_ROW = { id: PARTY_ID, label: "Familia Pérez", contact_email: "familia@example.com" };

function happyReplies(link: ReturnType<typeof storedLink>, overrides: Record<string, Reply> = {}) {
  return {
    "GET /rest/v1/guest_invitations": { status: 200, body: [PARTY_ROW] },
    [RECOVERY_RPC]: recoverable(link),
    "GET /rest/v1/weddings": {
      status: 200,
      body: [{ id: WEDDING_ID, name: "Boda Prueba", wedding_date: "2027-10-16", city: "Ciudad Ejemplo", time_zone: null }],
    },
    "GET /rest/v1/wedding_publications": { status: 200, body: [] },
    // The user's session can't execute record_rsvp_reminder_email, rotate or
    // write anything here: those would hit "unexpected request".
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

/** "METHOD /path" of every Data API request but membership reads, in order. */
const dataCalls = (requests: Recorded[]) =>
  requests
    .filter((r) => r.url.pathname.startsWith("/rest/v1/") && r.url.pathname !== "/rest/v1/wedding_memberships")
    .map((r) => `${r.method} ${r.url.pathname}`);

/** A fake sender and a fake privileged recorder sharing one call log. */
function fakeDelivery(
  result: EmailSendResult | "throw" = { ok: true, messageId: "msg_1" },
  recordResult: DeliveryRecordResult | "throw" = { ok: true, sentAt: SENT_AT },
) {
  const sent: OutgoingEmail[] = [];
  const records: RsvpReminderRecord[] = [];
  const order: string[] = [];
  const sender: EmailSender = {
    async send(email, ...options: unknown[]) {
      sendOptions.push(options);
      sent.push(email);
      order.push("SEND");
      if (result === "throw") throw new Error("network down");
      return result;
    },
  };
  const wrong = async () => {
    order.push("WRONG_OPERATION");
    return { ok: false } as const;
  };
  const recorder: DeliveryRecorder = {
    async recordRsvpReminder(entry) {
      records.push(entry);
      order.push("RECORD");
      if (recordResult === "throw") throw new Error("network down");
      return recordResult;
    },
    recordInvitation: wrong,
    readRsvpConfirmationContext: wrong,
    recordRsvpConfirmation: wrong,
  };
  return { sent, records, order, delivery: { sender, appOrigin: APP_ORIGIN, recorder } };
}

/** The token inside an email's text, compared, never printed. */
function emailedToken(email: OutgoingEmail | undefined): string | undefined {
  return /^Confirmar asistencia: https:\/\/bodas\.example\.com\/rsvp\/([A-Za-z0-9_-]{43})$/m.exec(email?.text ?? "")?.[1];
}

beforeEach(() => {
  tokenSpies.generate.mockClear();
  encryptSpy.mockClear();
  serviceSpies.rotate.mockClear();
  serviceSpies.replace.mockClear();
  serviceSpies.revoke.mockClear();
});

/** Nothing anywhere minted, encrypted, rotated or revoked a link. */
function expectNoLinkChange(requests: Recorded[]) {
  expect(tokenSpies.generate).not.toHaveBeenCalled();
  expect(encryptSpy).not.toHaveBeenCalled();
  expect(serviceSpies.rotate).not.toHaveBeenCalled();
  expect(serviceSpies.replace).not.toHaveBeenCalled();
  expect(serviceSpies.revoke).not.toHaveBeenCalled();
  const calls = dataCalls(requests);
  expect(calls).not.toContain(ROTATE_RPC);
  expect(calls.filter((c) => c.startsWith("PATCH ") || c.startsWith("DELETE ") || c.startsWith("POST /rest/v1/guest"))).toEqual([]);
}

describe("sendRsvpReminderEmail", () => {
  it.each(["owner", "collaborator"] as const)(
    "%s: authorizes, reads the party, recovers the SAME link, sends once, then records",
    async (role) => {
      const link = storedLink();
      const { supabase, requests } = clientFor({ role, replies: happyReplies(link) });
      const fake = fakeDelivery();

      expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({
        outcome: "sent",
        recipient: "familia@example.com",
        sentAt: SENT_AT,
      });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]!.to).toBe("familia@example.com");
      expect(fake.sent[0]!.subject).toBe("Recordatorio de confirmación — Boda Prueba");

      // SAME LINK: the reminder carries exactly the stored capability.
      const sameToken = emailedToken(fake.sent[0]) === link.token;
      expect(sameToken, "reminder token equals the currently recoverable token (value redacted)").toBe(true);
      expect(fake.sent[0]!.html.includes(`${APP_ORIGIN}/rsvp/${link.token}`)).toBe(true);

      // Order: party → recovery → (wedding, site) → send → record.
      const calls = dataCalls(requests);
      expect(calls.slice(0, 2)).toEqual(["GET /rest/v1/guest_invitations", RECOVERY_RPC]);
      expect(fake.order).toEqual(["SEND", "RECORD"]);
      expect(calls).not.toContain(RECORD_RPC);
      expectNoLinkChange(requests);

      // The provider's id, the authorized wedding, the party, the hash —
      // never the plaintext token — and (LB-15) the member from the
      // server's own session check, for the activity history.
      expect(fake.records).toEqual([
        {
          weddingId: WEDDING_ID,
          guestInvitationId: PARTY_ID,
          tokenHash: link.tokenHash,
          recipient: "familia@example.com",
          providerMessageId: "msg_1",
          actingUserId: USER_ID,
        },
      ]);
      expect(JSON.stringify(requests.map((r) => [r.url.toString(), r.body])).includes(link.token)).toBe(false);
    },
  );

  it("the party is read inside the authorized wedding, by ids only", async () => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link) });
    await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fakeDelivery().delivery, ENCRYPTION);
    const lookup = requests.find((r) => r.method === "GET" && r.url.pathname === "/rest/v1/guest_invitations");
    expect(lookup?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(lookup?.url.searchParams.get("id")).toBe(`eq.${PARTY_ID}`);
    const recovery = requests.find((r) => `${r.method} ${r.url.pathname}` === RECOVERY_RPC);
    expect(recovery?.body).toEqual({ target_wedding_id: WEDDING_ID, target_invitation_id: PARTY_ID });
  });

  it("race: the CURRENT contact email (as stored now) is the recipient and the recorded recipient", async () => {
    const link = storedLink();
    const { supabase } = clientFor({
      role: "owner",
      replies: happyReplies(link, {
        "GET /rest/v1/guest_invitations": { status: 200, body: [{ ...PARTY_ROW, contact_email: "nuevo@example.com" }] },
      }),
    });
    const fake = fakeDelivery();
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toMatchObject({
      outcome: "sent",
      recipient: "nuevo@example.com",
    });
    expect(fake.sent.map((m) => m.to)).toEqual(["nuevo@example.com"]);
    expect(fake.records.map((r) => r.recipient)).toEqual(["nuevo@example.com"]);
  });

  it("race: a link rotated after the page loaded — the reminder carries the NEW current link", async () => {
    const old = storedLink();
    const rotated = storedLink();
    const { supabase } = clientFor({ role: "owner", replies: happyReplies(rotated) });
    const fake = fakeDelivery();
    await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION);
    const token = emailedToken(fake.sent[0]);
    expect(token === rotated.token, "the current (rotated) link (value redacted)").toBe(true);
    expect(token === old.token, "never the old link (value redacted)").toBe(false);
    expect(fake.records[0]!.tokenHash).toBe(rotated.tokenHash);
  });

  it.each<[string, Backend, string, Readonly<Record<string, unknown>>]>([
    ["no session", { noSession: true, role: "owner" }, PARTY_ID, { outcome: "failed", reason: "unauthenticated" }],
    ["outsider (not a member)", { role: null }, PARTY_ID, { outcome: "failed", reason: "not_found" }],
    ["malformed party id", { role: "owner" }, "not-a-uuid", { outcome: "failed", reason: "invalid_target" }],
  ])("refused before reading anything: %s", async (_case, backend, partyId, expected) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ ...backend, replies: happyReplies(link) });
    const fake = fakeDelivery();
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, partyId, fake.delivery, ENCRYPTION)).toEqual(expected);
    expect(dataCalls(requests)).toEqual([]);
    expect(fake.sent).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
  });

  it("missing email configuration / link key: refused before reading anything", async () => {
    const link = storedLink();
    for (const [delivery, encryption, outcome] of [
      [null, ENCRYPTION, "email_not_configured"],
      [fakeDelivery().delivery, null, "link_not_configured"],
    ] as const) {
      const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link) });
      expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, delivery, encryption)).toEqual({ outcome });
      expect(dataCalls(requests)).toEqual([]);
    }
  });

  it.each<[string, Record<string, Reply>, Readonly<Record<string, unknown>>]>([
    ["party not in this wedding", { "GET /rest/v1/guest_invitations": { status: 200, body: [] } }, { outcome: "failed", reason: "invalid_target" }],
    [
      "no contact email",
      { "GET /rest/v1/guest_invitations": { status: 200, body: [{ ...PARTY_ROW, contact_email: null }] } },
      { outcome: "no_email" },
    ],
    [
      "stored email not in stored form",
      {
        "GET /rest/v1/guest_invitations": {
          status: 200,
          body: [{ ...PARTY_ROW, contact_email: "ana@example.com\r\nBcc: x@example.com" }],
        },
      },
      { outcome: "recipient_rejected" },
    ],
    [
      "legacy (pre-LB-13) hash-only link",
      { [RECOVERY_RPC]: { status: 200, body: [{ link_state: "legacy", token_hash: null, token_ciphertext: null }] } },
      { outcome: "link_unrecoverable" },
    ],
    [
      "revoked or expired link",
      { [RECOVERY_RPC]: { status: 200, body: [{ link_state: "unavailable", token_hash: null, token_ciphertext: null }] } },
      { outcome: "link_unavailable" },
    ],
    ["recovery read fails", { [RECOVERY_RPC]: { status: 500, body: { message: "boom" } } }, { outcome: "failed", reason: "error" }],
    ["wedding can't be loaded", { "GET /rest/v1/weddings": { status: 500, body: { message: "x" } } }, { outcome: "failed", reason: "error" }],
  ])("never calls the provider when a check fails: %s", async (_case, overrides, expected) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link, overrides) });
    const fake = fakeDelivery();
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual(expected);
    expect(fake.sent).toHaveLength(0);
    expect(fake.records).toHaveLength(0);
    // A failure never "repairs" the link by rotating it.
    expectNoLinkChange(requests);
  });

  it("an undecryptable envelope (another key) is link_unrecoverable: provider 0, recorder 0, nothing rotated", async () => {
    const link = storedLink(WRONG_TEST_RSVP_CAPABILITY_KEY);
    const { supabase, requests } = clientFor({ role: "collaborator", replies: happyReplies(link) });
    const fake = fakeDelivery();
    const outcome = await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION);
    expect(outcome).toEqual({ outcome: "link_unrecoverable" });
    expect(fake.order).toEqual([]);
    expectNoLinkChange(requests);
    expect(JSON.stringify(outcome)).not.toMatch(/decrypt|cipher|tag|key/i);
  });

  it.each<[EmailSendResult | "throw", string]>([
    [{ ok: false, reason: "provider_failure" }, "provider_failed"],
    [{ ok: false, reason: "unknown" }, "provider_failed"],
    ["throw", "provider_failed"],
    [{ ok: false, reason: "configuration" }, "email_not_configured"],
    [{ ok: false, reason: "invalid_recipient" }, "recipient_rejected"],
  ])("provider failure %j → %s: one attempt, nothing recorded, link untouched", async (result, outcome) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link) });
    const fake = fakeDelivery(result);
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({ outcome });
    // No automatic retry.
    expect(fake.order).toEqual(["SEND"]);
    expect(fake.records).toHaveLength(0);
    expectNoLinkChange(requests);
  });

  it.each<[string, DeliveryRecordResult | "throw"]>([
    ["refused", { ok: false }],
    ["throws", "throw"],
  ])("provider accepted but the recorder %s → sent_but_unrecorded; never resent", async (_case, recordResult) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link) });
    const fake = fakeDelivery({ ok: true, messageId: "msg_1" }, recordResult);
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({
      outcome: "sent_but_unrecorded",
      recipient: "familia@example.com",
    });
    expect(fake.order).toEqual(["SEND", "RECORD"]);
    expectNoLinkChange(requests);
  });

  it("accepted without a storable id → sent_but_unrecorded, no record attempt", async () => {
    const link = storedLink();
    const { supabase } = clientFor({ role: "owner", replies: happyReplies(link) });
    const fake = fakeDelivery({ ok: true, messageId: null });
    expect(await sendRsvpReminderEmail(supabase, WEDDING_ID, PARTY_ID, fake.delivery, ENCRYPTION)).toEqual({
      outcome: "sent_but_unrecorded",
      recipient: "familia@example.com",
    });
    expect(fake.order).toEqual(["SEND"]);
  });

  it("includes the website link only while it is published; never answers or notes", async () => {
    const link = storedLink();
    const published = clientFor({
      role: "owner",
      replies: happyReplies(link, {
        "GET /rest/v1/wedding_publications": {
          status: 200,
          body: [{ slug: "ana-y-luis", published_at: "2026-10-01T00:00:00Z" }],
        },
      }),
    });
    const withSite = fakeDelivery();
    await sendRsvpReminderEmail(published.supabase, WEDDING_ID, PARTY_ID, withSite.delivery, ENCRYPTION);
    expect(withSite.sent[0]!.text).toContain(`${APP_ORIGIN}/boda/ana-y-luis`);

    const unpublished = clientFor({ role: "owner", replies: happyReplies(link) });
    const withoutSite = fakeDelivery();
    await sendRsvpReminderEmail(unpublished.supabase, WEDDING_ID, PARTY_ID, withoutSite.delivery, ENCRYPTION);
    expect(withoutSite.sent[0]!.text).not.toContain("/boda/");
    // The orchestration never even reads guests, RSVPs or notes.
    const select = unpublished.requests.find((r) => r.url.pathname === "/rest/v1/guest_invitations")?.url.searchParams.get("select");
    expect(select).toBe("id,label,contact_email");
  });
});

describe("prepareRsvpReminderMessage (WhatsApp-ready text)", () => {
  it.each(["owner", "collaborator"] as const)("%s: the text carries the SAME current link; nothing is sent or written", async (role) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role, replies: happyReplies(link) });
    const result = await prepareRsvpReminderMessage(supabase, WEDDING_ID, PARTY_ID, LINK_CONFIG);
    if (!result.ok) throw new Error(`expected a message, got ${result.reason}`);
    const lines = result.message.split("\n");
    expect(lines[0]).toBe("Hola, Familia Pérez:");
    expect(lines.includes(`${APP_ORIGIN}/rsvp/${link.token}`), "same link (value redacted)").toBe(true);
    // Reads only: party, recovery, wedding. No record RPC, no write.
    expect(dataCalls(requests)).toEqual(["GET /rest/v1/guest_invitations", RECOVERY_RPC, "GET /rest/v1/weddings"]);
    expectNoLinkChange(requests);
  });

  it("builds the link from the configured origin only", async () => {
    const link = storedLink();
    const { supabase } = clientFor({ role: "owner", replies: happyReplies(link) });
    const result = await prepareRsvpReminderMessage(supabase, WEDDING_ID, PARTY_ID, {
      ...LINK_CONFIG,
      appOrigin: "https://otra.example.org",
    });
    expect(result.ok && result.message.includes(`https://otra.example.org/rsvp/${link.token}`)).toBe(true);
  });

  it("works without a contact email (no email needed)", async () => {
    const link = storedLink();
    const { supabase } = clientFor({
      role: "owner",
      replies: happyReplies(link, {
        "GET /rest/v1/guest_invitations": { status: 200, body: [{ ...PARTY_ROW, contact_email: null }] },
      }),
    });
    expect((await prepareRsvpReminderMessage(supabase, WEDDING_ID, PARTY_ID, LINK_CONFIG)).ok).toBe(true);
  });

  it.each<[string, Backend, Record<string, Reply>, string]>([
    ["outsider", { role: null }, {}, "not_found"],
    ["no session", { noSession: true, role: "owner" }, {}, "unauthenticated"],
    ["legacy", { role: "owner" }, { [RECOVERY_RPC]: { status: 200, body: [{ link_state: "legacy", token_hash: null, token_ciphertext: null }] } }, "link_unrecoverable"],
    ["revoked/expired", { role: "owner" }, { [RECOVERY_RPC]: { status: 200, body: [{ link_state: "unavailable", token_hash: null, token_ciphertext: null }] } }, "link_unavailable"],
    ["unknown party", { role: "owner" }, { "GET /rest/v1/guest_invitations": { status: 200, body: [] } }, "invalid_target"],
  ])("no message: %s", async (_case, backend, overrides, reason) => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ ...backend, replies: happyReplies(link, overrides) });
    expect(await prepareRsvpReminderMessage(supabase, WEDDING_ID, PARTY_ID, LINK_CONFIG)).toEqual({ ok: false, reason });
    expectNoLinkChange(requests);
  });

  it("without link configuration it refuses before reading anything", async () => {
    const link = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", replies: happyReplies(link) });
    expect(await prepareRsvpReminderMessage(supabase, WEDDING_ID, PARTY_ID, null)).toEqual({
      ok: false,
      reason: "link_not_configured",
    });
    expect(dataCalls(requests)).toEqual([]);
  });
});
