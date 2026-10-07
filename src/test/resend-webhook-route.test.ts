import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The store is replaced: these tests are about the route's boundary (method,
// configuration, size, signature, normalization, status mapping, output).
// Signature verification is REAL (webhook-auth, standardwebhooks, a fake
// test-only secret).
const ingest = vi.hoisted(() => vi.fn());
const getStore = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/delivery-event-store", () => ({ getDeliveryEventStore: getStore }));

const route = await import("@/app/api/webhooks/resend/route");

import {
  TEST_RESEND_WEBHOOK_SECRET,
  WRONG_TEST_RESEND_WEBHOOK_SECRET,
  resendEventBody,
  signWebhook,
  type SignedWebhook,
} from "./fixtures/resend-webhook";

// LB-18.2 (ADR-011 §7): POST /api/webhooks/resend.

const URL_BASE = "http://localhost:3100/api/webhooks/resend";
const EMAIL_ID = "outbox-6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENT_ID = "msg_2fXk9TestOnlyEventId0002";
const RECIPIENT = "decoy-recipient@example.com";

function post(signed: SignedWebhook | { body: string; headers: Record<string, string> }) {
  return route.POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed.headers },
      body: signed.body,
    }),
  );
}

function delivered(id = EVENT_ID) {
  return signWebhook(resendEventBody("email.delivered", EMAIL_ID), { id });
}

async function expectSafeEmpty(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  const text = await response.text();
  expect(text).toBe("");
}

describe("the Resend webhook route", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_RESEND_WEBHOOK_SECRET);
    getStore.mockReturnValue({ ingest });
    ingest.mockResolvedValue("applied");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    ingest.mockReset();
    getStore.mockReset();
  });

  it("is dynamic and POST-only (no other method exported → 405)", () => {
    expect(route.dynamic).toBe("force-dynamic");
    const exported = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(exported).toEqual(["POST"]);
  });

  it.each(["applied", "no_change", "duplicate", "unknown_message"] as const)(
    "a verified delivery event → ingest once → %s → 200",
    async (outcome) => {
      ingest.mockResolvedValue(outcome);
      await expectSafeEmpty(await post(delivered()), 200);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledWith({
        providerEventId: EVENT_ID,
        event: {
          providerMessageId: EMAIL_ID,
          eventType: "delivered",
          occurredAt: "2026-10-06T12:00:00.000Z",
          bounceType: null,
        },
      });
    },
  );

  it("passes only normalized fields: no wedding id, recipient, tags or payload", async () => {
    const body = resendEventBody("email.bounced", EMAIL_ID, {
      data: { bounce: { type: "Permanent", message: "decoy bounce text" }, wedding_id: "11111111-1111-4111-8111-111111111111" },
    });
    await post(signWebhook(body, { id: EVENT_ID }));
    const [[arg]] = ingest.mock.calls as [[unknown]];
    expect(arg).toEqual({
      providerEventId: EVENT_ID,
      event: { providerMessageId: EMAIL_ID, eventType: "bounced", occurredAt: "2026-10-06T12:00:00.000Z", bounceType: "permanent" },
    });
    expect(JSON.stringify(arg)).not.toMatch(/decoy|1111|wedding|example\.com/);
  });

  it("unsupported, opened and clicked events → 200, nothing ingested", async () => {
    for (const type of ["email.sent", "email.opened", "email.clicked", "contact.created", "domain.updated", "suppression.added"]) {
      const body = resendEventBody(type, EMAIL_ID, { data: { click: { link: "http://localhost/rsvp/decoy" } } });
      await expectSafeEmpty(await post(signWebhook(body, { id: EVENT_ID })), 200);
    }
    expect(ingest).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("a signed but malformed body → 200, nothing ingested", async () => {
    for (const body of ["{not json", "", JSON.stringify({ type: "email.delivered", created_at: "nope", data: { email_id: EMAIL_ID } })]) {
      await expectSafeEmpty(await post(signWebhook(body, { id: EVENT_ID })), 200);
    }
    expect(ingest).not.toHaveBeenCalled();
  });

  it("an invalid signature → 401 and the body is never parsed or ingested", async () => {
    const forged = signWebhook(resendEventBody("email.complained", EMAIL_ID), { id: EVENT_ID, secret: WRONG_TEST_RESEND_WEBHOOK_SECRET });
    await expectSafeEmpty(await post(forged), 401);
    const tampered = delivered();
    await expectSafeEmpty(await post({ ...tampered, body: tampered.body.replace("delivered", "complained") }), 401);
    expect(getStore).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("missing signature headers → 401", async () => {
    const signed = delivered();
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"] as const) {
      const headers: Record<string, string> = { ...signed.headers };
      delete headers[name];
      await expectSafeEmpty(await post({ body: signed.body, headers }), 401);
    }
    await expectSafeEmpty(await post({ body: signed.body, headers: {} }), 401);
    // Standard Webhooks' unbranded names are not Resend's: not accepted instead.
    const unbranded = {
      "webhook-id": signed.headers["svix-id"],
      "webhook-timestamp": signed.headers["svix-timestamp"],
      "webhook-signature": signed.headers["svix-signature"],
    };
    await expectSafeEmpty(await post({ body: signed.body, headers: unbranded }), 401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("an expired timestamp → 401", async () => {
    const old = signWebhook(resendEventBody("email.delivered", EMAIL_ID), { id: EVENT_ID, at: new Date(Date.now() - 10 * 60 * 1000) });
    await expectSafeEmpty(await post(old), 401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("no or malformed RESEND_WEBHOOK_SECRET → 503, nothing verified or ingested", async () => {
    for (const value of ["", "whsec_", "not-a-whsec-secret", `whsec_${Buffer.from("short").toString("base64")}`]) {
      vi.stubEnv("RESEND_WEBHOOK_SECRET", value);
      await expectSafeEmpty(await post(delivered()), 503);
    }
    expect(getStore).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("no service-role configuration → 503 (after verification), nothing ingested", async () => {
    getStore.mockReturnValue(null);
    await expectSafeEmpty(await post(delivered()), 503);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("a body over 64 KiB → 413 before verification, by length or by streamed bytes", async () => {
    const huge = resendEventBody("email.delivered", EMAIL_ID, { data: { padding: "x".repeat(70 * 1024) } });
    await expectSafeEmpty(await post(signWebhook(huge, { id: EVENT_ID })), 413);

    // A body with no (or a lying) Content-Length is still cut off while streaming.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 80; i += 1) controller.enqueue(new Uint8Array(1024).fill(120));
        controller.close();
      },
    });
    const signed = delivered();
    // Node requires `duplex: "half"` for a stream body; the DOM RequestInit type doesn't know it yet.
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: signed.headers, body: stream, duplex: "half" };
    const streamed = new Request(URL_BASE, init);
    const response = await route.POST(new NextRequest(streamed));
    await expectSafeEmpty(response, 413);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("exactly 64 KiB is accepted", async () => {
    const base = resendEventBody("email.delivered", EMAIL_ID, { data: { padding: "" } });
    const padded = base.replace('"padding":""', `"padding":"${"x".repeat(64 * 1024 - base.length)}"`);
    expect(Buffer.byteLength(padded)).toBe(64 * 1024);
    await expectSafeEmpty(await post(signWebhook(padded, { id: EVENT_ID })), 200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("a store failure → 500 (the provider retries), empty body", async () => {
    ingest.mockResolvedValue("error");
    await expectSafeEmpty(await post(delivered()), 500);
  });

  it("no response ever carries an address, id, payload or signature", async () => {
    const signed = signWebhook(resendEventBody("email.bounced", EMAIL_ID, { data: { to: [RECIPIENT] } }), { id: EVENT_ID });
    for (const outcome of ["applied", "duplicate", "unknown_message", "error"] as const) {
      ingest.mockResolvedValue(outcome);
      const response = await post(signed);
      const text = await response.text();
      for (const secretish of [RECIPIENT, EMAIL_ID, EVENT_ID, signed.headers["svix-signature"], "bounced"]) {
        expect(text).not.toContain(secretish);
        expect(JSON.stringify([...response.headers])).not.toContain(secretish);
      }
    }
  });
});
