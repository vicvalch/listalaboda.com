import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  WEBHOOK_TOLERANCE_SECONDS,
  getWebhookSecret,
  parseWebhookSecret,
  verifyWebhook,
  type WebhookSecret,
} from "@/lib/email/webhook-auth";

import {
  TEST_RESEND_WEBHOOK_SECRET,
  WRONG_TEST_RESEND_WEBHOOK_SECRET,
  resendEventBody,
  signWebhook,
} from "./fixtures/resend-webhook";

// LB-18.2 (ADR-011 §7): Standard Webhooks / Svix verification of Resend's
// webhooks, over the real HMAC path (fake, test-only secrets).

const BODY = resendEventBody("email.delivered", "outbox-6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b");
const ID = "msg_2fXk9TestOnlyEventId0001";

function secret(): WebhookSecret {
  const parsed = parseWebhookSecret(TEST_RESEND_WEBHOOK_SECRET);
  if (!parsed) throw new Error("fixture secret must parse");
  return parsed;
}

function headersOf(signed: ReturnType<typeof signWebhook>) {
  return {
    id: signed.headers["svix-id"],
    timestamp: signed.headers["svix-timestamp"],
    signature: signed.headers["svix-signature"],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("webhook secret configuration", () => {
  it("accepts a whsec_ secret of at least 24 bytes", () => {
    expect(parseWebhookSecret(TEST_RESEND_WEBHOOK_SECRET)).not.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["no whsec_ prefix", Buffer.from("TEST-ONLY-resend-webhook-key-000").toString("base64")],
    ["not base64", "whsec_not base64 at all!!"],
    ["too short", `whsec_${Buffer.from("short-key").toString("base64")}`],
    ["trailing whitespace", `${TEST_RESEND_WEBHOOK_SECRET} `],
    ["prefix only", "whsec_"],
  ])("refuses a %s secret", (_label, raw) => {
    expect(parseWebhookSecret(raw)).toBeNull();
  });

  it("reads RESEND_WEBHOOK_SECRET from the environment", () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_RESEND_WEBHOOK_SECRET);
    expect(getWebhookSecret()).not.toBeNull();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_bad");
    expect(getWebhookSecret()).toBeNull();
  });

  it("the parsed secret exposes no key material", () => {
    const parsed = secret();
    expect(Object.keys(parsed)).toEqual([]);
    expect(JSON.stringify(parsed)).toBe("{}");
  });

  it("without a configured secret nothing verifies", () => {
    const signed = signWebhook(BODY, { id: ID });
    expect(verifyWebhook(signed.body, headersOf(signed), null)).toEqual({ status: "not_configured" });
  });
});

describe("signature verification", () => {
  it("a valid signature verifies and yields the svix-id", () => {
    const signed = signWebhook(BODY, { id: ID });
    expect(verifyWebhook(signed.body, headersOf(signed), secret())).toEqual({ status: "verified", eventId: ID });
  });

  it("a tampered body fails (one character)", () => {
    const signed = signWebhook(BODY, { id: ID });
    const tampered = signed.body.replace("email.delivered", "email.bounced!!");
    expect(verifyWebhook(tampered, headersOf(signed), secret())).toEqual({ status: "invalid_signature" });
    expect(verifyWebhook(`${signed.body} `, headersOf(signed), secret())).toEqual({ status: "invalid_signature" });
  });

  it("a re-serialized body fails: verification is over the raw bytes", () => {
    const signed = signWebhook(JSON.stringify(JSON.parse(BODY), null, 2), { id: ID });
    expect(verifyWebhook(JSON.stringify(JSON.parse(signed.body)), headersOf(signed), secret())).toEqual({
      status: "invalid_signature",
    });
  });

  it("a different svix-id fails (the id is signed too)", () => {
    const signed = signWebhook(BODY, { id: ID });
    expect(verifyWebhook(signed.body, { ...headersOf(signed), id: "msg_someOtherEventId" }, secret())).toEqual({
      status: "invalid_signature",
    });
  });

  it("the wrong secret fails", () => {
    const signed = signWebhook(BODY, { id: ID, secret: WRONG_TEST_RESEND_WEBHOOK_SECRET });
    expect(verifyWebhook(signed.body, headersOf(signed), secret())).toEqual({ status: "invalid_signature" });
  });

  it.each(["id", "timestamp", "signature"] as const)("a missing svix-%s is refused", (name) => {
    const signed = signWebhook(BODY, { id: ID });
    expect(verifyWebhook(signed.body, { ...headersOf(signed), [name]: null }, secret())).toEqual({
      status: "missing_headers",
    });
    expect(verifyWebhook(signed.body, { ...headersOf(signed), [name]: "" }, secret())).toEqual({
      status: "missing_headers",
    });
  });

  it("malformed headers are refused before any crypto", () => {
    const signed = signWebhook(BODY, { id: ID });
    for (const headers of [
      { ...headersOf(signed), timestamp: "12abc" },
      { ...headersOf(signed), timestamp: "-5" },
      { ...headersOf(signed), id: "msg with spaces" },
      { ...headersOf(signed), signature: "v1,".padEnd(5000, "a") },
    ]) {
      expect(verifyWebhook(signed.body, headers, secret())).toEqual({ status: "missing_headers" });
    }
  });

  it("a timestamp outside ± 5 minutes is expired; inside it verifies", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    vi.useFakeTimers({ now });
    const tooOld = signWebhook(BODY, { id: ID, at: new Date(now.getTime() - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000) });
    const tooNew = signWebhook(BODY, { id: ID, at: new Date(now.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000) });
    const edge = signWebhook(BODY, { id: ID, at: new Date(now.getTime() - (WEBHOOK_TOLERANCE_SECONDS - 1) * 1000) });
    expect(verifyWebhook(tooOld.body, headersOf(tooOld), secret())).toEqual({ status: "expired" });
    expect(verifyWebhook(tooNew.body, headersOf(tooNew), secret())).toEqual({ status: "expired" });
    expect(verifyWebhook(edge.body, headersOf(edge), secret())).toEqual({ status: "verified", eventId: ID });
  });

  it("several space-separated signatures: any valid v1 one verifies (secret rotation)", () => {
    const signed = signWebhook(BODY, { id: ID });
    const other = signWebhook(BODY, { id: ID, secret: WRONG_TEST_RESEND_WEBHOOK_SECRET });
    const both = `${other.headers["svix-signature"]} ${signed.headers["svix-signature"]}`;
    expect(verifyWebhook(signed.body, { ...headersOf(signed), signature: both }, secret())).toEqual({
      status: "verified",
      eventId: ID,
    });
    const onlyWrong = `${other.headers["svix-signature"]} v2,${signed.headers["svix-signature"].slice(3)}`;
    expect(verifyWebhook(signed.body, { ...headersOf(signed), signature: onlyWrong }, secret())).toEqual({
      status: "invalid_signature",
    });
  });

  it("garbage signatures fail without throwing", () => {
    const signed = signWebhook(BODY, { id: ID });
    for (const signature of ["v1,", "v1,!!!", "nonsense", "v1"]) {
      expect(verifyWebhook(signed.body, { ...headersOf(signed), signature }, secret())).toEqual({
        status: "invalid_signature",
      });
    }
  });
});
