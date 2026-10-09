import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import {
  EMPTY_TIMELINE_FORM,
  isValidTimelineInput,
  parseTimelineDayOffset,
  parseTimelineDuration,
  parseTimelineInput,
  parseTimelineLocation,
  parseTimelineNotes,
  parseTimelinePhase,
  parseTimelineResponsible,
  parseTimelineStartTime,
  parseTimelineTitle,
  parseTimelineVendorId,
  timelineFormValues,
  type TimelineFormValues,
  type TimelineInput,
} from "@/lib/timeline/validation";

// LB-23 (ADR-016): the form validation mirrors every wedding_timeline_entries
// CHECK (tests/db/wedding-timeline.test.ts proves the database side).

const v = es.timeline.validation;
const VENDOR_ID = "44444444-4444-4444-8444-444444444444";

const form = (fields: Partial<TimelineFormValues>): TimelineFormValues => ({
  ...EMPTY_TIMELINE_FORM,
  title: "Ceremonia",
  ...fields,
});

describe("title", () => {
  it("is required, trimmed, 1–120 characters, plain text; never unique", () => {
    expect(parseTimelineTitle("  Primer baile  ")).toEqual({ ok: true, value: "Primer baile" });
    expect(parseTimelineTitle("   ")).toEqual({ ok: false, error: v.titleRequired });
    expect(parseTimelineTitle("a".repeat(120))).toEqual({ ok: true, value: "a".repeat(120) });
    expect(parseTimelineTitle("a".repeat(121))).toEqual({ ok: false, error: v.titleTooLong });
    // Characters, not UTF-16 units: 120 emoji fit.
    expect(parseTimelineTitle("💍".repeat(120)).ok).toBe(true);
    expect(parseTimelineTitle("Línea\nDos")).toEqual({ ok: false, error: v.titleInvalid });
    expect(parseTimelineTitle("Tab\there")).toEqual({ ok: false, error: v.titleInvalid });
  });
});

describe("day", () => {
  it("is exactly 0 or 1, never inferred", () => {
    expect(parseTimelineDayOffset("0")).toEqual({ ok: true, value: 0 });
    expect(parseTimelineDayOffset("1")).toEqual({ ok: true, value: 1 });
    for (const bad of ["", "-1", "2", "01", "1.0", "uno"]) {
      expect(parseTimelineDayOffset(bad)).toEqual({ ok: false, error: v.dayInvalid });
    }
  });
});

describe("start time", () => {
  it("accepts strict HH:MM from 00:00 to 23:59, blank = Sin hora", () => {
    for (const ok of ["00:00", "07:05", "15:30", "23:59"]) {
      expect(parseTimelineStartTime(ok)).toEqual({ ok: true, value: ok });
    }
    expect(parseTimelineStartTime("")).toEqual({ ok: true, value: null });
    expect(parseTimelineStartTime("  ")).toEqual({ ok: true, value: null });
  });

  it("rejects 24:00, single-digit hours, 60 minutes, seconds and garbage", () => {
    for (const bad of ["24:00", "7:30", "12:60", "15:30:00", "15:30:30", "1530", "3 pm", "aa:bb", "15:3", "15 :30"]) {
      expect(parseTimelineStartTime(bad), bad).toEqual({ ok: false, error: v.startTimeInvalid });
    }
  });
});

describe("no time is ever 'taken'", () => {
  it("every minute of both days parses: validation has no overlap or uniqueness rule", () => {
    for (const dayOffset of ["0", "1"]) {
      for (let minute = 0; minute < 1440; minute += 1) {
        const startTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const result = parseTimelineInput(form({ dayOffset, startTime }));
        if (!result.ok) throw new Error(`${dayOffset} ${startTime}: ${JSON.stringify(result.fieldErrors)}`);
      }
    }
  });
});

describe("duration", () => {
  it("combines hours and minutes; both blank = null", () => {
    expect(parseTimelineDuration("", "")).toEqual({ ok: true, value: null });
    expect(parseTimelineDuration(" ", " ")).toEqual({ ok: true, value: null });
    expect(parseTimelineDuration("0", "45")).toEqual({ ok: true, value: 45 });
    expect(parseTimelineDuration("", "45")).toEqual({ ok: true, value: 45 });
    expect(parseTimelineDuration("1", "30")).toEqual({ ok: true, value: 90 });
    expect(parseTimelineDuration("2", "")).toEqual({ ok: true, value: 120 });
    expect(parseTimelineDuration("24", "0")).toEqual({ ok: true, value: 1440 });
  });

  it("typed zeros are not blank: 0 h 0 min is refused", () => {
    expect(parseTimelineDuration("0", "0")).toEqual({ ok: false, error: v.durationZero });
    expect(parseTimelineDuration("0", "")).toEqual({ ok: false, error: v.durationZero });
    expect(parseTimelineDuration("", "00")).toEqual({ ok: false, error: v.durationZero });
  });

  it("whole numbers only, minutes 0–59, total ≤ 1440", () => {
    for (const [h, m] of [["1.5", ""], ["", "-5"], ["1,5", ""], ["uno", ""], ["", "60"], ["", "1e2"], ["+1", ""]]) {
      expect(parseTimelineDuration(h, m), `${h}/${m}`).toEqual({ ok: false, error: v.durationInvalid });
    }
    expect(parseTimelineDuration("24", "1")).toEqual({ ok: false, error: v.durationTooLong });
    expect(parseTimelineDuration("25", "")).toEqual({ ok: false, error: v.durationTooLong });
  });
});

describe("the LB-23 window", () => {
  const timed = (dayOffset: string, startTime: string, hours: string, minutes: string) =>
    parseTimelineInput(form({ dayOffset, startTime, durationHours: hours, durationMinutes: minutes }));

  it("accepts spans that end by midnight after day 1", () => {
    expect(timed("0", "23:45", "1", "0").ok).toBe(true); // ends day 1 00:45
    expect(timed("1", "00:30", "2", "0").ok).toBe(true);
    expect(timed("1", "22:00", "2", "0").ok).toBe(true); // exactly 2880
    expect(timed("1", "23:30", "0", "30").ok).toBe(true); // exactly 2880
    expect(timed("0", "00:00", "24", "0").ok).toBe(true);
    expect(timed("1", "00:00", "24", "0").ok).toBe(true); // exactly 2880
  });

  it("refuses spans that would spill into day 2 (never clipped)", () => {
    expect(timed("1", "23:30", "0", "31")).toEqual({ ok: false, fieldErrors: { duration: v.endOutsideWindow } });
    expect(timed("1", "23:30", "2", "0")).toEqual({ ok: false, fieldErrors: { duration: v.endOutsideWindow } });
    expect(timed("1", "00:01", "24", "0")).toEqual({ ok: false, fieldErrors: { duration: v.endOutsideWindow } });
  });

  it("is not evaluated without a start time", () => {
    const result = parseTimelineInput(form({ dayOffset: "1", startTime: "", durationHours: "24" }));
    expect(result).toEqual({ ok: true, input: expect.objectContaining({ startTime: null, durationMinutes: 1440 }) });
  });
});

describe("phase, location, responsible, vendor, notes", () => {
  it("phase is one of the seven values or none", () => {
    for (const phase of ["getting_ready", "setup", "ceremony", "photos", "cocktail", "reception", "closing"]) {
      expect(parseTimelinePhase(phase)).toEqual({ ok: true, value: phase });
    }
    expect(parseTimelinePhase("")).toEqual({ ok: true, value: null });
    for (const bad of ["other", "Ceremonia", "CEREMONY", "teardown"]) {
      expect(parseTimelinePhase(bad)).toEqual({ ok: false, error: v.phaseInvalid });
    }
  });

  it("location and responsible are optional plain text up to 120", () => {
    for (const [parse, tooLong, invalid] of [
      [parseTimelineLocation, v.locationTooLong, v.locationInvalid],
      [parseTimelineResponsible, v.responsibleTooLong, v.responsibleInvalid],
    ] as const) {
      expect(parse("")).toEqual({ ok: true, value: null });
      expect(parse("  Hotel · Suite 405 ")).toEqual({ ok: true, value: "Hotel · Suite 405" });
      expect(parse("a".repeat(120)).ok).toBe(true);
      expect(parse("a".repeat(121))).toEqual({ ok: false, error: tooLong });
      expect(parse("a\u0007b")).toEqual({ ok: false, error: invalid });
    }
  });

  it("the vendor is blank or a UUID shape (the database decides the wedding)", () => {
    expect(parseTimelineVendorId("")).toEqual({ ok: true, value: null });
    expect(parseTimelineVendorId(VENDOR_ID)).toEqual({ ok: true, value: VENDOR_ID });
    expect(parseTimelineVendorId("ABCDEF01-2345-4678-89AB-CDEF01234567")).toEqual({
      ok: true,
      value: "abcdef01-2345-4678-89ab-cdef01234567",
    });
    for (const bad of ["not-a-uuid", "1", `${VENDOR_ID}x`, "' or 1=1 --"]) {
      expect(parseTimelineVendorId(bad)).toEqual({ ok: false, error: v.vendorInvalid });
    }
  });

  it("notes are multiline plain text up to 4000", () => {
    expect(parseTimelineNotes("")).toEqual({ ok: true, value: null });
    expect(parseTimelineNotes("Entrada por proveedores\r\n\tDejar boutonnieres")).toEqual({
      ok: true,
      value: "Entrada por proveedores\r\n\tDejar boutonnieres",
    });
    expect(parseTimelineNotes("a".repeat(4000)).ok).toBe(true);
    expect(parseTimelineNotes("a".repeat(4001))).toEqual({ ok: false, error: v.notesTooLong });
    expect(parseTimelineNotes("a\u0000b")).toEqual({ ok: false, error: v.notesInvalid });
    expect(parseTimelineNotes("a\u000bb")).toEqual({ ok: false, error: v.notesInvalid });
  });
});

describe("parseTimelineInput", () => {
  it("normalizes a full entry", () => {
    expect(
      parseTimelineInput({
        title: " Peinado y maquillaje ",
        dayOffset: "0",
        startTime: "07:00",
        durationHours: "2",
        durationMinutes: "",
        phase: "getting_ready",
        location: "Hotel · Suite 405",
        responsibleName: "Ana",
        weddingVendorId: VENDOR_ID,
        notes: "Llevar café",
      }),
    ).toEqual({
      ok: true,
      input: {
        title: "Peinado y maquillaje",
        dayOffset: 0,
        startTime: "07:00",
        durationMinutes: 120,
        phase: "getting_ready",
        location: "Hotel · Suite 405",
        responsibleName: "Ana",
        weddingVendorId: VENDOR_ID,
        notes: "Llevar café",
      },
    });
  });

  it("reports one message per invalid field", () => {
    const result = parseTimelineInput({
      title: "",
      dayOffset: "2",
      startTime: "25:00",
      durationHours: "x",
      durationMinutes: "",
      phase: "other",
      location: "a".repeat(121),
      responsibleName: "a\u0001",
      weddingVendorId: "nope",
      notes: "a".repeat(4001),
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        title: v.titleRequired,
        dayOffset: v.dayInvalid,
        startTime: v.startTimeInvalid,
        duration: v.durationInvalid,
        phase: v.phaseInvalid,
        location: v.locationTooLong,
        responsibleName: v.responsibleInvalid,
        weddingVendorId: v.vendorInvalid,
        notes: v.notesTooLong,
      },
    });
  });
});

describe("isValidTimelineInput (the service's re-check)", () => {
  const valid: TimelineInput = {
    title: "Ceremonia",
    dayOffset: 0,
    startTime: "15:30",
    durationMinutes: 45,
    phase: "ceremony",
    location: "Jardín",
    responsibleName: null,
    weddingVendorId: null,
    notes: null,
  };

  it("accepts exactly what the parser produces, and round-trips through the form", () => {
    expect(isValidTimelineInput(valid)).toBe(true);
    expect(parseTimelineInput(timelineFormValues(valid))).toEqual({ ok: true, input: valid });
  });

  it.each([
    ["untrimmed title", { title: " Ceremonia" }],
    ["day 2", { dayOffset: 2 as never }],
    ["seconds", { startTime: "15:30:00" }],
    ["zero duration", { durationMinutes: 0 }],
    ["fractional duration", { durationMinutes: 45.5 }],
    ["over a day", { durationMinutes: 1441 }],
    ["spill into day 2", { dayOffset: 1 as const, startTime: "23:30", durationMinutes: 31 }],
    ["unknown phase", { phase: "other" as never }],
    ["blank location", { location: "" }],
    ["malformed vendor", { weddingVendorId: "nope" }],
    ["uppercase vendor id", { weddingVendorId: "ABCDEF01-2345-4678-89AB-CDEF01234567" }],
  ] as const)("refuses %s", (_name, change) => {
    expect(isValidTimelineInput({ ...valid, ...change } as TimelineInput)).toBe(false);
  });
});
