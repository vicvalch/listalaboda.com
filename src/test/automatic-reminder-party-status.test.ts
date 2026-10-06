import { describe, expect, it } from "vitest";

import {
  automaticReminderPartyStatus,
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
  hasContactEmail: true,
  linkState: "active",
  lastReminderEmailAt: null,
  lastInvitationEmailAt: null,
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
    expect(status({ hasContactEmail: false })).toEqual({ kind: "not_sending", reason: "no_contact_email" });
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
      status({ now: new Date("2090-06-16T12:00:00.000Z"), lastReminderEmailAt: "2090-06-12T00:00:00.000Z" }),
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
});
