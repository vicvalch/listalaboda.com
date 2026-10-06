import { createHash, randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EmailSendOptions, EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

vi.mock("server-only", () => ({}));

const { encryptRsvpCapability } = await import("@/lib/security/rsvp-capability-encryption");
const { finishOutcomeFor, runAutomaticRsvpReminders } = await import("@/lib/scheduler/rsvp-reminder-runner");
type Store = import("@/lib/scheduler/rsvp-reminder-store").RsvpReminderStore;
type FinishOutcome = import("@/lib/scheduler/rsvp-reminder-store").FinishOutcome;
type RunSummary = import("@/lib/scheduler/rsvp-reminder-runner").RunSummary;

// LB-17 (ADR-010): the runner's orchestration with a fake store and a fake
// sender. No database, no provider.

const APP_ORIGIN = "http://localhost:3100";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };

function capability() {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  return { token, tokenHash, envelope: encryptRsvpCapability({ token, tokenHash, key: TEST_RSVP_CAPABILITY_KEY }) };
}

type FakeOptions = {
  occurrences?: number;
  prepare?: "ready" | "skipped" | "unknown" | "stale";
  begin?: "sending" | "skipped" | "unknown" | "stale" | "context_changed";
  record?: boolean;
  envelope?: string;
  label?: () => string;
  claimFails?: boolean;
};

function fakeStore(options: FakeOptions = {}) {
  const cap = capability();
  const events: string[] = [];
  const finishes: FinishOutcome[] = [];
  const occurrences = Array.from({ length: options.occurrences ?? 1 }, () => ({
    occurrenceId: randomUUID(),
    claimToken: randomUUID(),
  }));
  const store: Store = {
    async claim() {
      events.push("claim");
      return options.claimFails ? null : occurrences;
    },
    async prepare() {
      events.push("prepare");
      const status = options.prepare ?? "ready";
      if (status !== "ready") return { status };
      return {
        status: "ready",
        reminder: {
          tokenHash: cap.tokenHash,
          envelope: options.envelope ?? cap.envelope,
          recipient: "familia@example.com",
          partyLabel: options.label?.() ?? "Familia Pérez",
          weddingName: "Boda de Ana y Luis",
          weddingDate: "2090-06-30",
          weddingCity: "Ciudad Ejemplo",
          siteSlug: null,
        },
      };
    },
    async begin(_occ, expected) {
      events.push("begin");
      expect(expected).toEqual({ tokenHash: cap.tokenHash, recipient: "familia@example.com" });
      const status = options.begin ?? "sending";
      return status === "sending" ? { status, attempt: 1 } : { status };
    },
    async record(entry) {
      events.push("record");
      expect(entry.tokenHash).toBe(cap.tokenHash);
      return options.record === false ? { ok: false } : { ok: true, sentAt: "2090-06-16T10:00:01Z" };
    },
    async finish(_occ, outcome) {
      events.push(`finish:${outcome}`);
      finishes.push(outcome);
      switch (outcome) {
        case "link_unrecoverable":
          return "skipped";
        case "sent_unrecorded":
          return "sent_unrecorded";
        case "recipient_rejected":
          return "failed";
        case "idempotency_conflict":
          return "unknown";
        default:
          return "retry_wait";
      }
    },
  };
  return { store, events, finishes, cap, occurrences };
}

function fakeSender(result: (n: number) => EmailSendResult | "throw" = () => ({ ok: true, messageId: "msg-1" })) {
  const calls: Array<{ email: OutgoingEmail; options?: EmailSendOptions }> = [];
  const sender: EmailSender = {
    async send(email, options) {
      calls.push({ email, options });
      const r = result(calls.length);
      if (r === "throw") throw new Error("network down");
      return r;
    },
  };
  return { sender, calls };
}

const run = (store: Store, sender: EmailSender, extra: Record<string, unknown> = {}) =>
  runAutomaticRsvpReminders({ store, sender, appOrigin: APP_ORIGIN, encryption: ENCRYPTION, sleep: async () => {}, ...extra });

describe("runAutomaticRsvpReminders", () => {
  it("no claims → nothing happens", async () => {
    const { store, events } = fakeStore({ occurrences: 0 });
    const { sender, calls } = fakeSender();
    expect(await run(store, sender)).toMatchObject({ ok: true, claimed: 0, sent: 0 });
    expect(events).toEqual(["claim"]);
    expect(calls).toEqual([]);
  });

  it("a failed claim reports ok: false and sends nothing", async () => {
    const { store } = fakeStore({ claimFails: true });
    const { sender, calls } = fakeSender();
    expect(await run(store, sender)).toMatchObject({ ok: false, claimed: 0 });
    expect(calls).toEqual([]);
  });

  it("claim → prepare → begin → ONE send (stable key, current link) → record", async () => {
    const { store, events, cap, occurrences } = fakeStore();
    const { sender, calls } = fakeSender();
    expect(await run(store, sender)).toMatchObject({ claimed: 1, sent: 1 });
    expect(events).toEqual(["claim", "prepare", "begin", "record"]);
    expect(calls).toHaveLength(1);
    // The scheduler (and only the scheduler) opts into the 10 s deadline.
    expect(calls[0]!.options).toEqual({
      idempotencyKey: `lb-auto-rsvp-reminder:${occurrences[0]!.occurrenceId}`,
      timeoutMs: 10_000,
    });
    expect(calls[0]!.email.to).toBe("familia@example.com");
    expect(calls[0]!.email.text).toContain(`${APP_ORIGIN}/rsvp/${cap.token}`);
  });

  it("the provider is never called before begin succeeds (prepare skipped/unknown/stale, begin refused)", async () => {
    for (const prepare of ["skipped", "unknown", "stale"] as const) {
      const { store, events } = fakeStore({ prepare });
      const { sender, calls } = fakeSender();
      const summary = await run(store, sender);
      expect(calls, prepare).toEqual([]);
      expect(events, prepare).toEqual(["claim", "prepare"]);
      expect(summary[prepare === "stale" ? "deferred" : prepare]).toBe(1);
    }
    for (const begin of ["skipped", "unknown", "stale", "context_changed"] as const) {
      const { store } = fakeStore({ begin });
      const { sender, calls } = fakeSender();
      await run(store, sender);
      expect(calls, begin).toEqual([]);
    }
  });

  it("an undecryptable envelope → finish(link_unrecoverable), no begin, no send", async () => {
    const other = capability();
    const { store, events } = fakeStore({ envelope: other.envelope });
    const { sender, calls } = fakeSender();
    expect(await run(store, sender)).toMatchObject({ skipped: 1 });
    expect(events).toEqual(["claim", "prepare", "finish:link_unrecoverable"]);
    expect(calls).toEqual([]);
  });

  const providerCases: Array<
    [string, () => EmailSendResult | "throw", FakeOptions, FinishOutcome, "unrecorded" | "retry" | "failed" | "unknown"]
  > = [
    ["accepted, record failed", () => ({ ok: true, messageId: "msg-1" }), { record: false }, "sent_unrecorded", "unrecorded"],
    ["accepted, no storable id", () => ({ ok: true, messageId: null }), {}, "sent_unrecorded", "unrecorded"],
    ["timeout", () => ({ ok: false, reason: "timeout" }), {}, "retry", "retry"],
    ["provider failure", () => ({ ok: false, reason: "provider_failure" }), {}, "retry", "retry"],
    ["unclassified", () => ({ ok: false, reason: "unknown" }), {}, "retry", "retry"],
    ["concurrent same key", () => ({ ok: false, reason: "idempotency_in_progress" }), {}, "retry", "retry"],
    ["thrown", () => "throw", {}, "retry", "retry"],
    ["recipient rejected", () => ({ ok: false, reason: "invalid_recipient" }), {}, "recipient_rejected", "failed"],
    ["changed payload", () => ({ ok: false, reason: "idempotency_conflict" }), {}, "idempotency_conflict", "unknown"],
  ];

  it.each(providerCases)("%s → finish(%s)", async (_label, result, storeOptions, outcome, counter) => {
    const { store, finishes } = fakeStore(storeOptions);
    const { sender, calls } = fakeSender(result);
    const summary: RunSummary = await run(store, sender);
    expect(calls).toHaveLength(1);
    expect(finishes).toEqual([outcome]);
    expect(summary[counter]).toBe(1);
  });

  it("a provider configuration error aborts the run: the remaining claims are left untouched", async () => {
    const { store, events } = fakeStore({ occurrences: 3 });
    const { sender, calls } = fakeSender(() => ({ ok: false, reason: "configuration" }));
    expect(await run(store, sender)).toMatchObject({ aborted: true, retry: 1, deferred: 2, claimed: 3 });
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e === "prepare")).toHaveLength(1);
  });

  it("the 45 s budget: no prepare or begin starts after it", async () => {
    const { store, events } = fakeStore({ occurrences: 2 });
    const { sender, calls } = fakeSender();
    let t = 0;
    // The first occurrence passes; the second starts after 45 s.
    const clock = () => (t += 20_000);
    expect(await run(store, sender, { now: clock })).toMatchObject({ claimed: 2, sent: 1, deferred: 1 });
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e === "begin")).toHaveLength(1);
  });

  it("sends sequentially, at most 2 per second", async () => {
    const { store } = fakeStore({ occurrences: 3 });
    const { sender } = fakeSender();
    const sleeps: number[] = [];
    const t = 0;
    await run(store, sender, { now: () => t, sleep: async (ms: number) => void sleeps.push(ms) });
    expect(sleeps).toEqual([500, 500]);
  });

  it("the same occurrence always uses the same key; an unchanged payload replays identically, a changed one differs", async () => {
    let label = "Familia Pérez";
    const { store, occurrences } = fakeStore({ label: () => label });
    const { sender, calls } = fakeSender(() => ({ ok: false, reason: "timeout" }));
    await run(store, sender);
    await run(store, sender);
    label = "Familia Renombrada";
    await run(store, sender);
    const key = `lb-auto-rsvp-reminder:${occurrences[0]!.occurrenceId}`;
    expect(calls.map((c) => c.options?.idempotencyKey)).toEqual([key, key, key]);
    expect(JSON.stringify(calls[1]!.email)).toBe(JSON.stringify(calls[0]!.email));
    expect(JSON.stringify(calls[2]!.email)).not.toBe(JSON.stringify(calls[0]!.email));
  });
});

describe("finishOutcomeFor", () => {
  it("maps every provider failure to its closed outcome", () => {
    expect(finishOutcomeFor({ ok: true, messageId: "x" })).toBeNull();
    expect(finishOutcomeFor({ ok: false, reason: "invalid_recipient" })).toBe("recipient_rejected");
    expect(finishOutcomeFor({ ok: false, reason: "idempotency_conflict" })).toBe("idempotency_conflict");
    for (const reason of ["configuration", "provider_failure", "unknown", "timeout", "idempotency_in_progress"] as const) {
      expect(finishOutcomeFor({ ok: false, reason })).toBe("retry");
    }
  });
});
