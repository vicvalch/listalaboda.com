import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_REMINDER_DAYS_BEFORE,
  DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE,
  automaticReminderDueAt,
  automaticReminderIdempotencyKey,
  automaticReminderWindow,
  isAutomaticReminderDaysBefore,
} from "@/lib/scheduler/timing";

// LB-17 (ADR-010 §6, §12): the pure mirror of the database's due time, the
// 48 h window and the stable provider idempotency key.

const HOUR = 60 * 60 * 1000;

describe("automaticReminderDueAt", () => {
  it("is days_before days before the wedding at 10:00 wedding-local (14/21/30)", () => {
    expect(AUTOMATIC_REMINDER_DAYS_BEFORE).toEqual([14, 21, 30]);
    expect(DEFAULT_AUTOMATIC_REMINDER_DAYS_BEFORE).toBe(21);
    // Costa Rica: UTC−6 all year.
    expect(automaticReminderDueAt("2090-06-30", "America/Costa_Rica", 14)?.toISOString()).toBe("2090-06-16T16:00:00.000Z");
    expect(automaticReminderDueAt("2090-06-30", "America/Costa_Rica", 21)?.toISOString()).toBe("2090-06-09T16:00:00.000Z");
    expect(automaticReminderDueAt("2090-06-30", "America/Costa_Rica", 30)?.toISOString()).toBe("2090-05-31T16:00:00.000Z");
    expect(automaticReminderDueAt("2090-06-30", "UTC", 14)?.toISOString()).toBe("2090-06-16T10:00:00.000Z");
  });

  it("follows the wedding zone's daylight saving time, never the server's", () => {
    // Madrid: CET (UTC+1) before the last Sunday of March, CEST (UTC+2) after.
    expect(automaticReminderDueAt("2090-03-31", "Europe/Madrid", 21)?.toISOString()).toBe("2090-03-10T09:00:00.000Z");
    expect(automaticReminderDueAt("2090-07-31", "Europe/Madrid", 21)?.toISOString()).toBe("2090-07-10T08:00:00.000Z");
    // Across a month and a year boundary.
    expect(automaticReminderDueAt("2091-01-10", "America/Mexico_City", 14)?.toISOString()).toBe("2090-12-27T16:00:00.000Z");
    // Southern hemisphere DST (Santiago, summer UTC−3).
    expect(automaticReminderDueAt("2091-01-30", "America/Santiago", 14)?.toISOString()).toBe("2091-01-16T13:00:00.000Z");
  });

  it("is null without a date, without a zone, or for an unknown zone", () => {
    expect(automaticReminderDueAt(null, "UTC", 21)).toBeNull();
    expect(automaticReminderDueAt("2090-06-30", null, 21)).toBeNull();
    expect(automaticReminderDueAt("2090-06-30", "Mars/Olympus", 21)).toBeNull();
    expect(automaticReminderDueAt("30/06/2090", "UTC", 21)).toBeNull();
  });
});

describe("automaticReminderWindow", () => {
  const due = new Date("2090-06-16T16:00:00.000Z");

  it("before due → before; [due, due + 48 h) → open; after → closed", () => {
    expect(automaticReminderWindow(due, new Date(due.getTime() - 1))).toBe("before");
    expect(automaticReminderWindow(due, due)).toBe("open");
    expect(automaticReminderWindow(due, new Date(due.getTime() + 48 * HOUR - 1))).toBe("open");
    expect(automaticReminderWindow(due, new Date(due.getTime() + 48 * HOUR))).toBe("closed");
  });
});

describe("isAutomaticReminderDaysBefore", () => {
  it("accepts only 14, 21 and 30", () => {
    for (const ok of [14, 21, 30]) expect(isAutomaticReminderDaysBefore(ok)).toBe(true);
    for (const bad of [0, 7, 15, 31, -14, "21", null, 21.5]) expect(isAutomaticReminderDaysBefore(bad)).toBe(false);
  });
});

describe("automaticReminderIdempotencyKey", () => {
  it("is exactly lb-auto-rsvp-reminder:<occurrence id>, the same every time", () => {
    const id = "6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(automaticReminderIdempotencyKey(id)).toBe(`lb-auto-rsvp-reminder:${id}`);
    expect(automaticReminderIdempotencyKey(id)).toBe(automaticReminderIdempotencyKey(id));
  });
});
