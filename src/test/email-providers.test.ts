import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The Resend SDK is replaced by a stub: no network, no API key, ever.
const resendSend = vi.hoisted(() => vi.fn());
const resendConstructor = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
    constructor(key: string) {
      resendConstructor(key);
    }
  },
}));

const { createResendSender, mapResendError } = await import("@/lib/email/resend");
const { OUTBOX_REJECTING_DOMAIN, createOutboxSender } = await import("@/lib/email/outbox");
const { isStorableMessageId } = await import("@/lib/email/provider");

const email = {
  to: "familia@example.com",
  subject: "Tu invitación a Boda",
  text: "texto",
  html: "<p>html</p>",
};

describe("Resend adapter", () => {
  beforeEach(() => {
    resendSend.mockReset();
    resendConstructor.mockReset();
  });

  it("sends from the configured sender to one recipient, text and HTML; returns only the id", async () => {
    resendSend.mockResolvedValue({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null, headers: {} });
    const sender = createResendSender({ apiKey: "re_test", from: "Lista <inv@example.com>" });
    expect(await sender.send(email)).toEqual({ ok: true, messageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    expect(resendConstructor).toHaveBeenCalledWith("re_test");
    // Without options (every manual flow), the call is exactly the pre-LB-17
    // one: no request options, no abort signal, no idempotency key.
    expect(resendSend).toHaveBeenCalledWith({
      from: "Lista <inv@example.com>",
      to: ["familia@example.com"],
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    expect(resendSend.mock.calls[0]).toHaveLength(1);
  });

  it("normalizes provider errors; raw messages never leave the adapter", async () => {
    const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
    const cases: Array<[string, string]> = [
      ["invalid_api_key", "configuration"],
      ["invalid_from_address", "configuration"],
      ["validation_error", "invalid_recipient"],
      ["rate_limit_exceeded", "provider_failure"],
      ["internal_server_error", "provider_failure"],
      ["something_new", "unknown"],
    ];
    for (const [name, reason] of cases) {
      resendSend.mockResolvedValueOnce({
        data: null,
        error: { name, message: "secret detail re_test", statusCode: 400 },
        headers: {},
      });
      const result = await sender.send(email);
      expect(result).toEqual({ ok: false, reason });
      expect(JSON.stringify(result)).not.toContain("secret detail");
    }
  });

  it("an SDK exception (network down) is a provider failure", async () => {
    resendSend.mockRejectedValue(new Error("ECONNRESET with details"));
    const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
    expect(await sender.send(email)).toEqual({ ok: false, reason: "provider_failure" });
  });

  it("accepted without a usable id is still a success (never 'not sent')", async () => {
    const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
    for (const data of [{ id: "" }, { id: "x".repeat(201) }, { id: "has spaces" }, {}]) {
      resendSend.mockResolvedValueOnce({ data, error: null, headers: {} });
      expect(await sender.send(email)).toEqual({ ok: true, messageId: null });
    }
  });

  it("maps every name it knows", () => {
    expect(mapResendError(undefined)).toBe("unknown");
    expect(mapResendError("missing_api_key")).toBe("configuration");
    expect(mapResendError("daily_quota_exceeded")).toBe("provider_failure");
    // LB-17 (ADR-010 §12): the two idempotency answers are their own categories.
    expect(mapResendError("invalid_idempotent_request")).toBe("idempotency_conflict");
    expect(mapResendError("concurrent_idempotent_requests")).toBe("idempotency_in_progress");
  });

  it("passes an idempotency key through unchanged (LB-17)", async () => {
    resendSend.mockResolvedValue({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null, headers: {} });
    const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
    await sender.send(email, { idempotencyKey: "lb-auto-rsvp-reminder:6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" });
    // A key alone installs no deadline.
    expect(resendSend.mock.calls[0]![1]).toEqual({
      idempotencyKey: "lb-auto-rsvp-reminder:6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    });
  });

  it("without timeoutMs no deadline is installed: a slow provider is simply awaited", async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: unknown) => void = () => {};
      resendSend.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
      let settled = false;
      const pending = sender.send(email).then((r) => ((settled = true), r));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(resendSend.mock.calls[0]).toHaveLength(1);
      answer({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null, headers: {} });
      expect(await pending).toEqual({ ok: true, messageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("with an explicit timeoutMs it gives up then (a timeout proves nothing about delivery) and aborts", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      resendSend.mockImplementation((_payload: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => {});
      });
      const sender = createResendSender({ apiKey: "re_test", from: "inv@example.com" });
      const pending = sender.send(email, { timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, reason: "timeout" });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("message ids we store", () => {
  it("are opaque and bounded", () => {
    expect(isStorableMessageId("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")).toBe(true);
    expect(isStorableMessageId("outbox-1")).toBe(true);
    for (const bad of ["", "a".repeat(201), "https://x/rsvp/abc", "id con espacio", 42, null]) {
      expect(isStorableMessageId(bad)).toBe(false);
    }
  });
});

describe("local outbox (tests / local development)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lb-outbox-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes each message as one file instead of sending it", async () => {
    const result = await createOutboxSender(join(dir, "nested")).send(email);
    expect(result.ok).toBe(true);
    const files = await readdir(join(dir, "nested"));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(dir, "nested", files[0]!), "utf8"));
    expect(stored).toMatchObject(email);
    expect(result.ok && stored.messageId === result.messageId).toBe(true);
  });

  it("honours an idempotency key like the provider: same payload → same id, one file; different → conflict", async () => {
    const outbox = createOutboxSender(dir);
    const key = "lb-auto-rsvp-reminder:6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const first = await outbox.send(email, { idempotencyKey: key });
    const again = await outbox.send(email, { idempotencyKey: key });
    expect(first.ok && again.ok && first.messageId === again.messageId).toBe(true);
    expect(await readdir(dir)).toHaveLength(1);
    expect(await outbox.send({ ...email, text: "otro" }, { idempotencyKey: key })).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("refuses the test failure domain deterministically, writing nothing", async () => {
    const result = await createOutboxSender(dir).send({ ...email, to: `x@${OUTBOX_REJECTING_DOMAIN}` });
    expect(result).toEqual({ ok: false, reason: "provider_failure" });
    expect(await readdir(dir)).toEqual([]);
  });
});
