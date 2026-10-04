import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The privileged client is replaced by a stub that records exactly what the
// recorder does with it: no network, no real key.
const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn(() => ({ rpc, from })));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { createDeliveryRecorder, getDeliveryRecorder, parseRecorderSettings } = await import(
  "@/lib/email/delivery-recorder"
);

const URL_VALUE = "http://127.0.0.1:54321";
const SECRET = "sb_secret_do_not_print_me";

function fakeJwt(role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signature`;
}

const entry = {
  weddingId: "22222222-2222-4222-8222-222222222222",
  guestInvitationId: "44444444-4444-4444-8444-444444444444",
  tokenHash: "a".repeat(64),
  recipient: "familia@example.com",
  providerMessageId: "msg_1",
};

describe("delivery recorder settings (ADR-004)", () => {
  it("accepts only a secret / service_role key", () => {
    expect(parseRecorderSettings({ NEXT_PUBLIC_SUPABASE_URL: URL_VALUE, SUPABASE_SERVICE_ROLE_KEY: SECRET })).toEqual({
      supabaseUrl: URL_VALUE,
      serviceRoleKey: SECRET,
    });
    const legacy = fakeJwt("service_role");
    expect(parseRecorderSettings({ NEXT_PUBLIC_SUPABASE_URL: URL_VALUE, SUPABASE_SERVICE_ROLE_KEY: legacy })).toEqual({
      supabaseUrl: URL_VALUE,
      serviceRoleKey: legacy,
    });
  });

  it.each([
    ["missing", undefined],
    ["blank", "  "],
    ["publishable key", "sb_publishable_abc"],
    ["anon JWT", fakeJwt("anon")],
    ["authenticated JWT", fakeJwt("authenticated")],
    ["whitespace inside", "sb_secret_ abc"],
  ])("refuses a %s key (fails closed)", (_case, key) => {
    expect(parseRecorderSettings({ NEXT_PUBLIC_SUPABASE_URL: URL_VALUE, SUPABASE_SERVICE_ROLE_KEY: key })).toBeNull();
  });

  it("refuses a missing or malformed Supabase URL", () => {
    expect(parseRecorderSettings({ SUPABASE_SERVICE_ROLE_KEY: SECRET })).toBeNull();
    expect(parseRecorderSettings({ NEXT_PUBLIC_SUPABASE_URL: "nope", SUPABASE_SERVICE_ROLE_KEY: SECRET })).toBeNull();
  });
});

describe("getDeliveryRecorder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null without the key, and never exposes the key or a client", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_VALUE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getDeliveryRecorder()).toBeNull();

    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SECRET);
    const recorder = getDeliveryRecorder();
    expect(recorder).not.toBeNull();
    // The only thing handed out is `record`.
    expect(Object.keys(recorder ?? {})).toEqual(["record"]);
    expect(JSON.stringify(recorder)).not.toContain(SECRET);
  });
});

describe("createDeliveryRecorder", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
    createClient.mockClear();
  });

  it("calls exactly one RPC, record_guest_invitation_email, with the scoped arguments", async () => {
    rpc.mockResolvedValue({ data: "2026-10-03T12:00:00+00:00", error: null });
    const recorder = createDeliveryRecorder({ supabaseUrl: URL_VALUE, serviceRoleKey: SECRET });
    expect(await recorder.record(entry)).toEqual({ ok: true, sentAt: "2026-10-03T12:00:00+00:00" });
    expect(createClient).toHaveBeenCalledWith(URL_VALUE, SECRET, expect.objectContaining({ auth: expect.any(Object) }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_guest_invitation_email", {
      target_wedding_id: entry.weddingId,
      target_invitation_id: entry.guestInvitationId,
      invitation_token_hash: entry.tokenHash,
      recipient: entry.recipient,
      provider_message_id: entry.providerMessageId,
    });
    // No table access through the privileged client, ever.
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses an unstorable provider id without calling the database", async () => {
    const recorder = createDeliveryRecorder({ supabaseUrl: URL_VALUE, serviceRoleKey: SECRET });
    for (const providerMessageId of ["", "a".repeat(201), "https://x/rsvp/abc"]) {
      expect(await recorder.record({ ...entry, providerMessageId })).toEqual({ ok: false });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a database refusal or an exception is a plain failure, nothing echoed", async () => {
    const recorder = createDeliveryRecorder({ supabaseUrl: URL_VALUE, serviceRoleKey: SECRET });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "guest_invitation_email_not_recorded" } });
    expect(await recorder.record(entry)).toEqual({ ok: false });
    rpc.mockRejectedValueOnce(new Error(`network down ${SECRET}`));
    const failed = await recorder.record(entry);
    expect(failed).toEqual({ ok: false });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });
});
