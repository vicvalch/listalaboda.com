import { describe, expect, it } from "vitest";

import {
  automaticReminderPartyStatus,
  lastEmailTo,
  type AutomaticReminderPartyInput,
} from "@/lib/scheduler/party-status";

// LB-17 (ADR-010 §26): what organizers see per party, derived in memory.

const NOW = new Date("2090-06-10T12:00:00.000Z");
// UTC wedding on 2090-06-30: the 14-day reminder is due 2090-06-16 10:00Z.
const base: AutomaticReminderPartyInput = {
  policy: { enabled: true, daysBefore: 14, enabledAt: "2090-01-01T00:00:00.000Z" },
  weddingDate: "2090-06-30",
  weddingTimeZone: "UTC",
  answered: false,
  contactEmail: "familia@example.com",
  contactEmailBlocked: false,
  linkState: "active",
  recordedEmails: [],
  occurrence: null,
  now: NOW,
};

const status = (overrides: Partial<AutomaticReminderPartyInput>) => automaticReminderPartyStatus({ ...base, ...overrides });

describe("automaticReminderPartyStatus", () => {
  it("scheduled for the computed date while everything qualifies", () => {
    expect(status({})).toEqual({ kind: "scheduled", dueAt: new Date("2090-06-16T10:00:00.000Z") });
  });

  it("off (no line) when the policy is off and nothing was attempted", () => {
    expect(status({ policy: { ...base.policy, enabled: false } })).toEqual({ kind: "off" });
  });

  it("final outcomes win over the policy, and never expose enum names", () => {
    const occurrence = (state: NonNullable<AutomaticReminderPartyInput["occurrence"]>["state"], extra = {}) => ({
      state,
      outcomeReason: null,
      sentAt: null,
      ...extra,
    });
    const off = { ...base.policy, enabled: false };
    expect(status({ policy: off, occurrence: occurrence("sent", { sentAt: "2090-06-16T10:05:00Z" }) })).toEqual({
      kind: "sent",
      sentAt: "2090-06-16T10:05:00Z",
    });
    expect(status({ occurrence: occurrence("sent_unrecorded") })).toEqual({ kind: "review", reason: "unrecorded" });
    expect(status({ occurrence: occurrence("unknown", { outcomeReason: "idempotency_conflict" }) })).toEqual({
      kind: "review",
      reason: "uncertain",
    });
    expect(status({ occurrence: occurrence("failed", { outcomeReason: "recipient_rejected" }) })).toEqual({
      kind: "review",
      reason: "rejected",
    });
    for (const s of ["claimed", "sending", "retry_wait"] as const) {
      expect(status({ occurrence: occurrence(s) })).toEqual({ kind: "in_progress" });
    }
  });

  it("explains why it won't be sent", () => {
    expect(status({ answered: true })).toEqual({ kind: "not_sending", reason: "answered" });
    expect(status({ contactEmail: null })).toEqual({ kind: "not_sending", reason: "no_contact_email" });
    expect(status({ linkState: "revoked" })).toEqual({ kind: "not_sending", reason: "link_unavailable" });
    expect(status({ linkState: "expired" })).toEqual({ kind: "not_sending", reason: "link_unavailable" });
    expect(status({ weddingDate: null })).toEqual({ kind: "not_sending", reason: "needs_date" });
    expect(status({ weddingTimeZone: null })).toEqual({ kind: "not_sending", reason: "needs_date" });
    expect(status({ now: new Date("2090-06-18T10:00:00.000Z") })).toEqual({ kind: "not_sending", reason: "date_passed" });
    // Enabled after the due date: no retroactive send.
    expect(
      status({ policy: { ...base.policy, enabledAt: "2090-06-17T00:00:00.000Z" }, now: new Date("2090-06-17T01:00:00.000Z") }),
    ).toEqual({ kind: "not_sending", reason: "date_passed" });
    // Inside the window, within 7 days of a recorded email.
    expect(
      status({
        now: new Date("2090-06-16T12:00:00.000Z"),
        recordedEmails: [{ sentAt: "2090-06-12T00:00:00.000Z", sentTo: "familia@example.com" }],
      }),
    ).toEqual({ kind: "not_sending", reason: "recently_reminded" });
    expect(
      status({ occurrence: { state: "skipped", outcomeReason: "link_unrecoverable", sentAt: null } }),
    ).toEqual({ kind: "not_sending", reason: "link_unrecoverable" });
    expect(status({ occurrence: { state: "skipped", outcomeReason: "answered", sentAt: null } })).toEqual({
      kind: "not_sending",
      reason: "answered",
    });
  });

  it("a remediable skip whose condition is fixed reads as scheduled again", () => {
    expect(status({ occurrence: { state: "skipped", outcomeReason: "no_contact_email", sentAt: null } })).toEqual({
      kind: "scheduled",
      dueAt: new Date("2090-06-16T10:00:00.000Z"),
    });
  });

  // LB-18.4 (ADR-010 §7 E9/E11): the line agrees with the scheduler.
  describe("recipient-aware (LB-18.4)", () => {
    const INSIDE = new Date("2090-06-16T12:00:00.000Z");

    it("a blocked current address → recipient_undeliverable, after the earlier reasons", () => {
      expect(status({ contactEmailBlocked: true })).toEqual({ kind: "not_sending", reason: "recipient_undeliverable" });
      expect(status({ contactEmailBlocked: true, answered: true })).toEqual({ kind: "not_sending", reason: "answered" });
      expect(status({ contactEmailBlocked: true, linkState: "revoked" })).toEqual({
        kind: "not_sending",
        reason: "link_unavailable",
      });
      expect(status({ contactEmailBlocked: true, policy: { ...base.policy, enabled: false } })).toEqual({ kind: "off" });
      // Wins over a recent send to the same address.
      expect(
        status({
          now: INSIDE,
          contactEmailBlocked: true,
          recordedEmails: [{ sentAt: "2090-06-15T00:00:00.000Z", sentTo: "familia@example.com" }],
        }),
      ).toEqual({ kind: "not_sending", reason: "recipient_undeliverable" });
    });

    it("a recipient_undeliverable skip reads as scheduled again once the address is fixed (remediable)", () => {
      const occurrence = { state: "skipped" as const, outcomeReason: "recipient_undeliverable" as const, sentAt: null };
      expect(status({ occurrence })).toEqual({ kind: "scheduled", dueAt: new Date("2090-06-16T10:00:00.000Z") });
      expect(status({ occurrence, contactEmailBlocked: true })).toEqual({
        kind: "not_sending",
        reason: "recipient_undeliverable",
      });
    });

    it("only sends to the CURRENT address (case-insensitive) count as recently reminded", () => {
      const recent = (sentTo: string) => status({ now: INSIDE, recordedEmails: [{ sentAt: "2090-06-12T00:00:00.000Z", sentTo }] });
      expect(recent("vieja@example.com")).toEqual({ kind: "scheduled", dueAt: new Date("2090-06-16T10:00:00.000Z") });
      expect(recent("Familia@Example.com")).toEqual({ kind: "not_sending", reason: "recently_reminded" });
      expect(recent(" familia@example.com ")).toEqual({ kind: "not_sending", reason: "recently_reminded" });
      // Outside 7 days: no longer.
      expect(
        status({ now: INSIDE, recordedEmails: [{ sentAt: "2090-06-08T00:00:00.000Z", sentTo: "familia@example.com" }] }),
      ).toEqual({ kind: "scheduled", dueAt: new Date("2090-06-16T10:00:00.000Z") });
    });
  });
});

describe("lastEmailTo", () => {
  const emails = [
    { sentAt: "2090-06-10T00:00:00.000Z", sentTo: "a@example.com" },
    { sentAt: "2090-06-12T00:00:00.000Z", sentTo: "b@example.com" },
    { sentAt: "2090-06-11T00:00:00.000Z", sentTo: "A@Example.com" },
  ];

  it("the latest send to the address in its comparison form; never another address", () => {
    expect(lastEmailTo(emails, "a@example.com")).toBe(Date.parse("2090-06-11T00:00:00.000Z"));
    expect(lastEmailTo(emails, "B@EXAMPLE.COM")).toBe(Date.parse("2090-06-12T00:00:00.000Z"));
    expect(lastEmailTo(emails, "c@example.com")).toBeNull();
    // Dots and +tags stay significant.
    expect(lastEmailTo(emails, "a+x@example.com")).toBeNull();
    expect(lastEmailTo([], "a@example.com")).toBeNull();
  });
});
