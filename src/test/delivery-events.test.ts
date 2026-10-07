import { describe, expect, it } from "vitest";

import { normalizeBounceType, parseResendDeliveryEvent } from "@/lib/email/delivery-events";

import { resendEventBody } from "./fixtures/resend-webhook";

// LB-18.2 (ADR-011 §7): normalization of a verified Resend webhook body into
// the few safe fields ingestion may use.

const EMAIL_ID = "56761188-7520-42d8-8898-ff6fc54ce618";
const AT = "2026-10-06T12:00:00.000Z";

describe("supported delivery events", () => {
  it.each([
    ["email.delivered", "delivered"],
    ["email.delivery_delayed", "delivery_delayed"],
    ["email.failed", "failed"],
    ["email.suppressed", "suppressed"],
    ["email.complained", "complained"],
  ] as const)("%s → %s, no bounce type", (type, eventType) => {
    expect(parseResendDeliveryEvent(resendEventBody(type, EMAIL_ID, { createdAt: AT }))).toEqual({
      status: "event",
      event: { providerMessageId: EMAIL_ID, eventType, occurredAt: AT, bounceType: null },
    });
  });

  it.each([
    ["Permanent", "permanent"],
    ["Transient", "transient"],
    ["Temporary", "transient"],
    ["Undetermined", "undetermined"],
    ["permanent", "permanent"],
    ["SomethingNew", "undetermined"],
  ] as const)("email.bounced with bounce.type %s → %s", (raw, bounceType) => {
    const body = resendEventBody("email.bounced", EMAIL_ID, {
      createdAt: AT,
      data: { bounce: { type: raw, subType: "General", message: "decoy bounce text" } },
    });
    expect(parseResendDeliveryEvent(body)).toEqual({
      status: "event",
      event: { providerMessageId: EMAIL_ID, eventType: "bounced", occurredAt: AT, bounceType },
    });
  });

  it("a bounce without a bounce object is undetermined", () => {
    const parsed = parseResendDeliveryEvent(resendEventBody("email.bounced", EMAIL_ID));
    expect(parsed).toMatchObject({ status: "event", event: { bounceType: "undetermined" } });
    expect(normalizeBounceType(undefined)).toBe("undetermined");
    expect(normalizeBounceType(42)).toBe("undetermined");
  });

  it("correlates by data.email_id only, never data.message_id, tags or recipients", () => {
    const parsed = parseResendDeliveryEvent(resendEventBody("email.delivered", EMAIL_ID));
    expect(parsed.status).toBe("event");
    const serialized = JSON.stringify(parsed);
    for (const decoy of ["decoy-smtp-message-id", "decoy-recipient", "Decoy subject", "00000000-0000-4000-8000", "invitaciones@"]) {
      expect(serialized).not.toContain(decoy);
    }
  });

  it("normalizes created_at offsets to UTC", () => {
    const parsed = parseResendDeliveryEvent(resendEventBody("email.delivered", EMAIL_ID, { createdAt: "2026-10-06T14:00:00+02:00" }));
    expect(parsed).toMatchObject({ event: { occurredAt: "2026-10-06T12:00:00.000Z" } });
  });
});

describe("ignored events", () => {
  it.each([
    "email.sent",
    "email.scheduled",
    "email.opened",
    "email.received",
    "contact.created",
    "domain.updated",
    "suppression.added",
    "topic.deleted",
    "email.something_new",
    "toString",
    "__proto__",
  ])("%s is unsupported", (type) => {
    expect(parseResendDeliveryEvent(resendEventBody(type, EMAIL_ID))).toEqual({ status: "ignored", reason: "unsupported" });
  });

  it("email.clicked is ignored without its link, IP or user agent reaching the result", () => {
    const body = resendEventBody("email.clicked", EMAIL_ID, {
      data: {
        click: {
          link: "http://localhost:3100/rsvp/decoyCapabilityTokenValue",
          ipAddress: "203.0.113.7",
          userAgent: "decoy-agent",
          timestamp: AT,
        },
      },
    });
    const parsed = parseResendDeliveryEvent(body);
    expect(parsed).toEqual({ status: "ignored", reason: "unsupported" });
    expect(JSON.stringify(parsed)).not.toMatch(/rsvp|203\.0\.113|decoy-agent/);
  });
});

describe("malformed bodies (signed, so ignored and never ingested)", () => {
  it.each([
    ["not JSON", "{not json"],
    ["empty", ""],
    ["JSON array", "[]"],
    ["JSON null", "null"],
    ["no type", JSON.stringify({ created_at: AT, data: { email_id: EMAIL_ID } })],
    ["numeric type", JSON.stringify({ type: 5, created_at: AT, data: { email_id: EMAIL_ID } })],
  ])("%s", (_label, body) => {
    expect(parseResendDeliveryEvent(body)).toEqual({ status: "ignored", reason: "malformed" });
  });

  it.each([
    ["missing email_id", { data: { email_id: undefined } }],
    ["email_id with spaces", { data: { email_id: "not an id" } }],
    ["email_id as a URL", { data: { email_id: "https://x/rsvp/abc" } }],
    ["email_id too long", { data: { email_id: "a".repeat(201) } }],
    ["numeric email_id", { data: { email_id: 12 } }],
  ])("%s", (_label, options) => {
    const body = JSON.parse(resendEventBody("email.delivered", EMAIL_ID)) as { data: Record<string, unknown> };
    Object.assign(body.data, options.data);
    expect(parseResendDeliveryEvent(JSON.stringify(body))).toEqual({ status: "ignored", reason: "malformed" });
  });

  it("missing data", () => {
    expect(parseResendDeliveryEvent(JSON.stringify({ type: "email.delivered", created_at: AT }))).toEqual({
      status: "ignored",
      reason: "malformed",
    });
  });

  it.each(["", "yesterday", "2026-10-06", "2026-10-06 12:00:00", "2026-13-45T99:99:99Z", "1696593600"])(
    "invalid created_at %j",
    (createdAt) => {
      expect(parseResendDeliveryEvent(resendEventBody("email.delivered", EMAIL_ID, { createdAt }))).toEqual({
        status: "ignored",
        reason: "malformed",
      });
    },
  );

  it("missing created_at (data.created_at is not a substitute)", () => {
    const body = JSON.parse(resendEventBody("email.delivered", EMAIL_ID)) as Record<string, unknown>;
    delete body.created_at;
    expect(parseResendDeliveryEvent(JSON.stringify(body))).toEqual({ status: "ignored", reason: "malformed" });
  });
});
