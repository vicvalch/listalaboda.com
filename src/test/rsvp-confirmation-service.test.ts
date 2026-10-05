import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { EmailDelivery } from "@/lib/email/delivery";
import type {
  DeliveryRecordResult,
  RsvpConfirmationContextResult,
  RsvpConfirmationRecord,
} from "@/lib/email/delivery-recorder";
import type { EmailSendResult, OutgoingEmail } from "@/lib/email/provider";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");

// Application-layer tests of the RSVP → confirmation orchestration: a real
// supabase-js client WITHOUT a session (exactly the guest: anon + the
// capability) against a fake HTTP backend, a fake email sender and a fake
// privileged recorder (ADR-005). They pin the causal order (save → read
// context → send → record), the failure matrix, and that the RSVP result
// never depends on the email. The same flows run against the real database
// in tests/db/rsvp-confirmation-service.test.ts.

const SUPABASE_URL = "http://supabase.test";
const APP_ORIGIN = "https://bodas.example.com";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const GUEST_A = "55555555-5555-4555-8555-555555555555";
const GUEST_B = "66666666-6666-4666-8666-666666666666";
const TOKEN = "T".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const SENT_AT = "2026-10-04T12:00:00+00:00";
const RECIPIENT = "familia@example.com";

type Row = { party_label: string; guest_id: string; guest_name: string; attending: boolean; dietary_note: string | null };

/** What the database returns after the save: ITS normalized state. */
function savedRows(a: boolean, b: boolean): Row[] {
  return [
    { party_label: "Familia Pérez", guest_id: GUEST_A, guest_name: "Ana Pérez", attending: a, dietary_note: "sin gluten" },
    { party_label: "Familia Pérez", guest_id: GUEST_B, guest_name: "Carlos Pérez", attending: b, dietary_note: null },
  ];
}

type Backend = {
  submit?: { status: number; body: unknown };
  slug?: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The guest's client and a shared log of everything, in order. */
function guestClient(backend: Backend, log: string[], state: { saved: boolean }) {
  const requests: Array<{ path: string; body: unknown; auth: string | null }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, body, auth: headers.get("authorization") });
    if (url.pathname === "/rest/v1/rpc/submit_guest_rsvp") {
      log.push("SAVE");
      const reply = backend.submit ?? { status: 200, body: savedRows(true, false) };
      if (reply.status === 200) state.saved = true;
      return json(reply.body, reply.status);
    }
    if (url.pathname === "/rest/v1/rpc/get_guest_invitation_site_slug") {
      log.push("SLUG");
      return json(backend.slug ?? null);
    }
    log.push(`UNEXPECTED ${url.pathname}`);
    return json({ message: "unexpected request" }, 500);
  };
  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  return { supabase, requests };
}

type Fakes = {
  context?: RsvpConfirmationContextResult | "throw";
  send?: EmailSendResult | "throw";
  record?: DeliveryRecordResult | "throw";
};

function fakeDelivery(fakes: Fakes, log: string[], state: { saved: boolean }) {
  const sent: OutgoingEmail[] = [];
  const records: RsvpConfirmationRecord[] = [];
  const contextReads: string[] = [];
  const savedWhenSent: boolean[] = [];
  const notAllowed = async () => {
    log.push("FORBIDDEN");
    return { ok: false } as const;
  };
  const delivery: EmailDelivery = {
    appOrigin: APP_ORIGIN,
    sender: {
      async send(email) {
        log.push("SEND");
        // The RSVP must already be persisted when the provider is reached.
        savedWhenSent.push(state.saved);
        sent.push(email);
        if (fakes.send === "throw") throw new Error("network down");
        return fakes.send ?? { ok: true, messageId: "msg_1" };
      },
    },
    recorder: {
      recordInvitation: notAllowed,
      recordRsvpReminder: notAllowed,
      async readRsvpConfirmationContext(tokenHash) {
        log.push("CONTEXT");
        contextReads.push(tokenHash);
        if (fakes.context === "throw") throw new Error("down");
        return (
          fakes.context ?? {
            ok: true,
            context: {
              weddingId: WEDDING_ID,
              guestInvitationId: PARTY_ID,
              recipient: RECIPIENT,
              weddingName: "Boda de Ana y Luis",
              weddingDate: "2027-10-16",
              weddingCity: "Ciudad Ejemplo",
            },
          }
        );
      },
      async recordRsvpConfirmation(entry) {
        log.push("RECORD");
        records.push(entry);
        if (fakes.record === "throw") throw new Error("down");
        return fakes.record ?? { ok: true, sentAt: SENT_AT };
      },
    },
  };
  return { delivery, sent, records, contextReads, savedWhenSent };
}

const ANSWERS = [
  { guestId: GUEST_A, attending: true, dietaryNote: "sin gluten" },
  { guestId: GUEST_B, attending: false, dietaryNote: null },
];

async function run(backend: Backend = {}, fakes: Fakes = {}, configured = true) {
  const log: string[] = [];
  const state = { saved: false };
  const { supabase, requests } = guestClient(backend, log, state);
  const fake = fakeDelivery(fakes, log, state);
  const getDelivery = vi.fn(() => {
    log.push("CONFIG");
    return configured ? fake.delivery : null;
  });
  const result = await submitRsvpWithConfirmation(supabase, TOKEN, ANSWERS, getDelivery);
  return { result, log, requests, getDelivery, state, ...fake };
}

describe("submitRsvpWithConfirmation: RSVP first, email second", () => {
  it("saves, reads the private context, sends once, then records", async () => {
    const { result, log, sent, records, contextReads, savedWhenSent } = await run();
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(log).toEqual(["SAVE", "CONFIG", "CONTEXT", "SLUG", "SEND", "RECORD"]);
    expect(savedWhenSent).toEqual([true]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(RECIPIENT);
    expect(contextReads).toEqual([TOKEN_HASH]);
    expect(records).toEqual([
      {
        weddingId: WEDDING_ID,
        guestInvitationId: PARTY_ID,
        tokenHash: TOKEN_HASH,
        recipient: RECIPIENT,
        providerMessageId: "msg_1",
      },
    ]);
  });

  it("the guest request stays anon + capability: no session, no service role, the hash only", async () => {
    const { requests } = await run();
    for (const request of requests) {
      expect(request.auth ?? "").not.toMatch(/service_role|sb_secret/);
    }
    expect(JSON.stringify(requests)).not.toContain(TOKEN);
    expect(requests.map((r) => r.path)).toEqual([
      "/rest/v1/rpc/submit_guest_rsvp",
      "/rest/v1/rpc/get_guest_invitation_site_slug",
    ]);
  });

  it("renders the DATABASE's saved state, not the browser's form", async () => {
    // The form said A yes / B no; the database's post-save result says
    // A no / B yes (and has its own names): the email follows the database.
    const { sent } = await run({ submit: { status: 200, body: savedRows(false, true) } });
    const { text } = sent[0]!;
    expect(text).toContain(`- Ana Pérez: ${es.rsvp.status.not_attending}`);
    expect(text).toContain(`- Carlos Pérez: ${es.rsvp.status.attending}`);
  });

  it("the confirmation never carries the RSVP link, the token, notes or the recipient in the body", async () => {
    const { sent } = await run({ slug: "ana-y-luis" });
    for (const part of [sent[0]!.subject, sent[0]!.text, sent[0]!.html]) {
      expect(part).not.toContain("/rsvp/");
      expect(part).not.toContain(TOKEN);
      expect(part).not.toContain(TOKEN_HASH);
      expect(part).not.toContain("sin gluten");
      expect(part).not.toContain(RECIPIENT);
      expect(part).not.toContain(PARTY_ID);
      expect(part).not.toContain(WEDDING_ID);
      expect(part).not.toContain("msg_1");
    }
  });

  it("links the published website (from the trusted origin), and omits it when unpublished", async () => {
    const published = await run({ slug: "ana-y-luis" });
    expect(published.sent[0]!.text).toContain(`${APP_ORIGIN}/boda/ana-y-luis`);
    const unpublished = await run({ slug: null });
    expect(unpublished.sent[0]!.text).not.toContain("/boda/");
    expect(unpublished.sent[0]!.html).not.toContain("/boda/");
  });

  it("a second submission sends a second, fresh confirmation", async () => {
    const first = await run({ submit: { status: 200, body: savedRows(true, true) } });
    const second = await run({ submit: { status: 200, body: savedRows(true, false) } });
    expect(first.sent[0]!.text).toContain(`- Carlos Pérez: ${es.rsvp.status.attending}`);
    expect(second.sent[0]!.text).toContain(`- Carlos Pérez: ${es.rsvp.status.not_attending}`);
    expect(second.result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
  });
});

describe("failure matrix (RSVP | email | provider | recorder → result)", () => {
  it.each([
    ["unavailable link", { status: 400, body: { code: "P0001", message: "guest_invitation_unavailable" } }, "unavailable"],
    ["stale party", { status: 400, body: { code: "P0001", message: "guest_rsvp_mismatch" } }, "stale"],
    ["invalid answers", { status: 400, body: { code: "22023", message: "guest_rsvp_invalid" } }, "invalid"],
    ["database error", { status: 500, body: { code: "XX000", message: "boom" } }, "error"],
  ] as const)("RSVP fails (%s) → provider 0, recorder 0, RSVP failure", async (_case, submit, reason) => {
    const { result, log, sent, records, getDelivery } = await run({ submit });
    expect(result).toEqual({ rsvp: "failed", reason });
    expect(getDelivery).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(log).toEqual(["SAVE"]);
  });

  it("malformed token → nothing reaches the database, provider or recorder", async () => {
    const log: string[] = [];
    const state = { saved: false };
    const { supabase, requests } = guestClient({}, log, state);
    const fake = fakeDelivery({}, log, state);
    const getDelivery = vi.fn(() => fake.delivery);
    const result = await submitRsvpWithConfirmation(supabase, "not-a-token", ANSWERS, getDelivery);
    expect(result).toEqual({ rsvp: "failed", reason: "unavailable" });
    expect(requests).toHaveLength(0);
    expect(getDelivery).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
  });

  it("saved | no email → provider 0, recorder 0, saved + skipped_no_email", async () => {
    const { result, sent, records } = await run(
      {},
      {
        context: {
          ok: true,
          context: {
            weddingId: WEDDING_ID,
            guestInvitationId: PARTY_ID,
            recipient: null,
            weddingName: "Boda",
            weddingDate: null,
            weddingCity: null,
          },
        },
      },
    );
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "skipped_no_email" });
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("saved | email | unconfigured → provider 0, recorder 0, saved + not_configured", async () => {
    const { result, log } = await run({}, {}, false);
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "not_configured" });
    // Configuration is read only after the save; nothing privileged runs.
    expect(log).toEqual(["SAVE", "CONFIG"]);
  });

  it("saved | email | provider failed → recorder 0, saved + provider_failed", async () => {
    for (const send of [{ ok: false, reason: "provider_failure" } as const, { ok: false, reason: "configuration" } as const, "throw" as const]) {
      const { result, sent, records, state } = await run({}, { send });
      expect(result).toMatchObject({ rsvp: "saved", confirmation: "provider_failed" });
      expect(state.saved).toBe(true);
      expect(sent).toHaveLength(1);
      expect(records).toHaveLength(0);
    }
  });

  it("saved | email | accepted | recorder failed → ONE send, saved + sent_but_unrecorded", async () => {
    for (const record of [{ ok: false } as const, "throw" as const]) {
      const { result, sent, records } = await run({}, { record });
      expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent_but_unrecorded" });
      expect(sent).toHaveLength(1);
      expect(records).toHaveLength(1);
    }
  });

  it("saved | email | accepted without a storable id → not recorded, never resent: sent_but_unrecorded", async () => {
    const { result, sent, records } = await run({}, { send: { ok: true, messageId: null } });
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent_but_unrecorded" });
    expect(sent).toHaveLength(1);
    expect(records).toHaveLength(0);
  });

  it("saved | email | accepted | recorded → saved + sent", async () => {
    const { result, sent, records } = await run();
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(sent).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it("the private context can't be read (or the link died meanwhile) → provider 0, saved + not_sent", async () => {
    for (const context of [{ ok: false } as const, "throw" as const]) {
      const { result, sent, records } = await run({}, { context });
      expect(result).toMatchObject({ rsvp: "saved", confirmation: "not_sent" });
      expect(sent).toHaveLength(0);
      expect(records).toHaveLength(0);
    }
  });

  it("a stored recipient that isn't in stored form is never handed to the provider", async () => {
    const { result, sent } = await run(
      {},
      {
        context: {
          ok: true,
          context: {
            weddingId: WEDDING_ID,
            guestInvitationId: PARTY_ID,
            recipient: "x@example.com\r\nBcc: y@example.com",
            weddingName: "Boda",
            weddingDate: null,
            weddingCity: null,
          },
        },
      },
    );
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "not_sent" });
    expect(sent).toHaveLength(0);
  });

  it("a broken configuration factory can't undo the saved RSVP", async () => {
    const log: string[] = [];
    const state = { saved: false };
    const { supabase } = guestClient({}, log, state);
    const result = await submitRsvpWithConfirmation(supabase, TOKEN, ANSWERS, () => {
      throw new Error("bad config");
    });
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "not_sent" });
  });
});
