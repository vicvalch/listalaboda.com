import { afterEach, describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import {
  absoluteMinutes,
  clockMinutes,
  clockTime,
  durationParts,
  endsWithinWindow,
  formatDuration,
  formatTimelineDate,
  storedTimeToClock,
  timelineDayLabel,
  timelineDayName,
  timelinePhaseLabel,
  wallClockPoint,
} from "@/lib/timeline/presentation";
import {
  compareTimelineEntries,
  entryEnd,
  entrySpan,
  sortTimelineEntries,
  timelineNow,
  timelineNowMinutes,
  timelineOverview,
  timelineSections,
  type TimelineEntry,
  type TimelineVendor,
} from "@/lib/timeline/summary";

// LB-23 (ADR-016): pure timeline derivations. Every instant is explicit
// (never the real clock) and a few tests run under hostile process time
// zones, so nothing here depends on the machine.

const WEDDING_DATE = "2027-08-14";
const CR = "America/Costa_Rica"; // UTC−6, no daylight saving

let seq = 0;
function entry(fields: Partial<TimelineEntry> = {}): TimelineEntry {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    title: `Actividad ${seq}`,
    dayOffset: 0,
    startTime: null,
    durationMinutes: null,
    phase: null,
    location: null,
    responsibleName: null,
    notes: null,
    vendor: null,
    createdAt: `2026-10-09T12:00:${String(seq % 60).padStart(2, "0")}.000000+00:00`,
    ...fields,
  };
}

const vendor = (id: string): TimelineVendor => ({
  id,
  name: `Proveedor ${id}`,
  category: "music",
  customCategory: null,
  status: "booked",
  contactName: null,
  phone: null,
});

const titles = (entries: readonly TimelineEntry[]) => entries.map((e) => e.title);

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

// ------------------------------------------------------------ presentation

describe("wall-clock arithmetic", () => {
  it("parses strict HH:MM and formats minutes back", () => {
    expect(clockMinutes("00:00")).toBe(0);
    expect(clockMinutes("15:30")).toBe(930);
    expect(clockMinutes("23:59")).toBe(1439);
    expect(clockMinutes("24:00")).toBeNull();
    expect(clockMinutes("7:30")).toBeNull();
    expect(clockTime(0)).toBe("00:00");
    expect(clockTime(930)).toBe("15:30");
    expect(clockTime(1439)).toBe("23:59");
  });

  it("reads the Data API's stored time as HH:MM", () => {
    expect(storedTimeToClock("15:30:00")).toBe("15:30");
    expect(storedTimeToClock("00:30:00")).toBe("00:30");
    expect(storedTimeToClock(null)).toBeNull();
    expect(storedTimeToClock("15:30:30")).toBeNull();
    expect(storedTimeToClock("24:00:00")).toBeNull();
  });

  it("absolute minutes run from midnight starting the wedding day", () => {
    expect(absoluteMinutes(0, "23:45")).toBe(1425);
    expect(absoluteMinutes(1, "00:30")).toBe(1470);
    expect(wallClockPoint(1485)).toEqual({ dayOffset: 1, time: "00:45" });
    expect(wallClockPoint(2880)).toEqual({ dayOffset: 2, time: "00:00" });
  });

  it("the window ends at minute 2880", () => {
    expect(endsWithinWindow(0, "23:45", 60)).toBe(true);
    expect(endsWithinWindow(1, "22:00", 120)).toBe(true);
    expect(endsWithinWindow(1, "23:30", 30)).toBe(true);
    expect(endsWithinWindow(1, "23:30", 31)).toBe(false);
    expect(endsWithinWindow(1, "23:30", 120)).toBe(false);
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(1440)).toBe("24 h");
    expect(durationParts(90)).toEqual({ hours: 1, minutes: 30 });
  });

  it("labels every phase in Spanish", () => {
    expect(
      (["getting_ready", "setup", "ceremony", "photos", "cocktail", "reception", "closing"] as const).map(
        timelinePhaseLabel,
      ),
    ).toEqual(["Preparación", "Montaje", "Ceremonia", "Fotos", "Cóctel", "Recepción", "Cierre"]);
  });
});

describe("day labels", () => {
  it("derive from the CURRENT wedding date", () => {
    expect(timelineDayLabel(WEDDING_DATE, 0)).toEqual({ title: "sábado, 14 de agosto de 2027", detail: null });
    expect(timelineDayLabel(WEDDING_DATE, 1)).toEqual({
      title: "domingo, 15 de agosto de 2027",
      detail: es.timeline.days.afterMidnight,
    });
    // The same rows under a moved wedding date: new labels, nothing rewritten.
    expect(timelineDayLabel("2027-12-31", 0).title).toBe("viernes, 31 de diciembre de 2027");
    expect(timelineDayLabel("2027-12-31", 1).title).toBe("sábado, 1 de enero de 2028");
  });

  it("fall back to relative names without a wedding date", () => {
    expect(timelineDayLabel(null, 0)).toEqual({ title: "Día de la boda", detail: null });
    expect(timelineDayLabel(null, 1)).toEqual({ title: "Día siguiente", detail: "después de medianoche" });
    expect(timelineDayName(0)).toBe("Día de la boda");
    expect(timelineDayName(1)).toBe("Día siguiente");
  });

  it("no process time zone shifts a date or a wall-clock time", () => {
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      expect(formatTimelineDate(WEDDING_DATE), tz).toBe("sábado, 14 de agosto de 2027");
      expect(timelineDayLabel(WEDDING_DATE, 1).title, tz).toBe("domingo, 15 de agosto de 2027");
      expect(storedTimeToClock("00:30:00"), tz).toBe("00:30");
      expect(storedTimeToClock("23:45:00"), tz).toBe("23:45");
      const late = entry({ startTime: "23:45", durationMinutes: 60 });
      expect(entryEnd(late), tz).toEqual({ dayOffset: 1, time: "00:45" });
    }
  });
});

// ---------------------------------------------------------------- ordering

describe("ordering", () => {
  it("day 0 before day 1, then by start time", () => {
    const teardown = entry({ title: "Desmontaje", dayOffset: 1, startTime: "00:30" });
    const lastCall = entry({ title: "Última ronda", startTime: "23:45" });
    const ceremony = entry({ title: "Ceremonia", startTime: "15:30" });
    const makeup = entry({ title: "Maquillaje", startTime: "07:00" });
    expect(titles(sortTimelineEntries([teardown, lastCall, ceremony, makeup]))).toEqual([
      "Maquillaje",
      "Ceremonia",
      "Última ronda",
      "Desmontaje",
    ]);
  });

  it("never mixes untimed entries in before timed ones", () => {
    const untimed0 = entry({ title: "Sin hora 0" });
    const early = entry({ title: "Temprano", startTime: "00:00" });
    const untimed1 = entry({ title: "Sin hora 1", dayOffset: 1 });
    const night = entry({ title: "Noche", dayOffset: 1, startTime: "01:00" });
    expect(titles(sortTimelineEntries([untimed1, untimed0, night, early]))).toEqual([
      "Temprano",
      "Sin hora 0",
      "Noche",
      "Sin hora 1",
    ]);
  });

  it("same start: creation order (created_at, then id), whatever the input order", () => {
    const florist = entry({ title: "Floristería", startTime: "14:00", createdAt: "2026-10-09T12:00:01+00:00" });
    const dj = entry({ title: "DJ", startTime: "14:00", createdAt: "2026-10-09T12:00:02+00:00" });
    const photos = entry({ title: "Fotos", startTime: "14:00", createdAt: "2026-10-09T12:00:03+00:00" });
    const expected = ["Floristería", "DJ", "Fotos"];
    expect(titles(sortTimelineEntries([photos, dj, florist]))).toEqual(expected);
    expect(titles(sortTimelineEntries([dj, florist, photos]))).toEqual(expected);

    // Identical created_at: the id decides.
    const at = "2026-10-09T12:00:00.123456+00:00";
    const b = entry({ id: "00000000-0000-4000-8000-00000000000b", title: "B", startTime: "14:00", createdAt: at });
    const a = entry({ id: "00000000-0000-4000-8000-00000000000a", title: "A", startTime: "14:00", createdAt: at });
    expect(titles(sortTimelineEntries([b, a]))).toEqual(["A", "B"]);
    expect(compareTimelineEntries(a, a)).toBe(0);
  });

  it("microsecond created_at differences still order", () => {
    const first = entry({ title: "1", startTime: "14:00", createdAt: "2026-10-09T12:00:00.1234+00:00" });
    const second = entry({ title: "2", startTime: "14:00", createdAt: "2026-10-09T12:00:00.12345+00:00" });
    expect(titles(sortTimelineEntries([second, first]))).toEqual(["1", "2"]);
  });

  it("does not reorder its input", () => {
    const input = [entry({ startTime: "10:00" }), entry({ startTime: "09:00" })];
    const copy = [...input];
    sortTimelineEntries(input);
    expect(input).toEqual(copy);
  });

  it("splits day sections (only days with entries) and Sin hora", () => {
    const morning = entry({ title: "Mañana", startTime: "07:00" });
    const tbd0 = entry({ title: "Fotógrafo", dayOffset: 0 });
    const tbd1 = entry({ title: "Recoger", dayOffset: 1 });
    const sections = timelineSections([tbd1, morning, tbd0], WEDDING_DATE);
    expect(sections.days.map((d) => [d.dayOffset, d.date, titles(d.entries)])).toEqual([
      [0, "2027-08-14", ["Mañana"]],
    ]);
    expect(titles(sections.untimed)).toEqual(["Fotógrafo", "Recoger"]);
    const late = entry({ title: "Desmontaje", dayOffset: 1, startTime: "00:30" });
    expect(timelineSections([late], null).days.map((d) => [d.dayOffset, d.date])).toEqual([[1, null]]);
  });
});

// --------------------------------------------------------------- spans/ends

describe("derived end", () => {
  it("adds the duration in wall-clock minutes, across midnight", () => {
    expect(entryEnd(entry({ startTime: "15:30", durationMinutes: 45 }))).toEqual({ dayOffset: 0, time: "16:15" });
    expect(entryEnd(entry({ startTime: "23:45", durationMinutes: 60 }))).toEqual({ dayOffset: 1, time: "00:45" });
    expect(entryEnd(entry({ dayOffset: 1, startTime: "23:30", durationMinutes: 30 }))).toEqual({
      dayOffset: 2,
      time: "00:00",
    });
  });

  it("has no end without a duration or without a start", () => {
    expect(entryEnd(entry({ startTime: "21:00" }))).toBeNull();
    expect(entryEnd(entry({ durationMinutes: 45 }))).toBeNull();
    expect(entrySpan(entry({ durationMinutes: 45 }))).toBeNull();
  });
});

// -------------------------------------------------------------- now / next

/** An instant from a Costa Rica wall clock (UTC−6). */
const crInstant = (date: string, time: string) => new Date(`${date}T${time}:00-06:00`);

describe("current / next", () => {
  const makeup = entry({ title: "Maquillaje", startTime: "07:00", durationMinutes: 120 });
  const photographer = entry({ title: "Llega fotógrafo", startTime: "09:30" });
  const ceremony = entry({ title: "Ceremonia", startTime: "15:30", durationMinutes: 45 });
  const music = entry({ title: "Música", startTime: "15:00", durationMinutes: 120 });
  const photos = entry({ title: "Fotos familiares", startTime: "16:15", durationMinutes: 45 });
  const toast = entry({ title: "Brindis", startTime: "16:15" });
  const lastCall = entry({ title: "Última ronda", startTime: "23:45", durationMinutes: 60 });
  const tbd = entry({ title: "Sin hora", durationMinutes: 600 });
  const all = [makeup, photographer, ceremony, music, photos, toast, lastCall, tbd];
  const ctx = (now: Date, overrides: Partial<{ weddingDate: string | null; timeZone: string | null }> = {}) => ({
    weddingDate: WEDDING_DATE,
    timeZone: CR,
    now,
    ...overrides,
  });

  it("a timed entry with a duration is current inside its span; overlaps are all current", () => {
    const now = timelineNow(all, ctx(crInstant(WEDDING_DATE, "15:40")));
    expect(now?.time).toBe("15:40");
    expect(titles(now!.currentEntries)).toEqual(["Música", "Ceremonia"]);
    // Two entries share the next start: both are next (a moment included).
    expect(titles(now!.nextEntries)).toEqual(["Fotos familiares", "Brindis"]);
  });

  it("the start is inclusive, the end exclusive", () => {
    expect(titles(timelineNow(all, ctx(crInstant(WEDDING_DATE, "07:00")))!.currentEntries)).toEqual(["Maquillaje"]);
    expect(titles(timelineNow(all, ctx(crInstant(WEDDING_DATE, "09:00")))!.currentEntries)).toEqual([]);
  });

  it("moments are never current but can be next; untimed entries are neither", () => {
    const now = timelineNow(all, ctx(crInstant(WEDDING_DATE, "09:10")));
    expect(titles(now!.currentEntries)).toEqual([]);
    expect(titles(now!.nextEntries)).toEqual(["Llega fotógrafo"]);
    const at930 = timelineNow(all, ctx(crInstant(WEDDING_DATE, "09:30")));
    expect(titles(at930!.currentEntries)).toEqual([]);
    for (const t of ["00:01", "12:00", "23:00"]) {
      const result = timelineNow(all, ctx(crInstant(WEDDING_DATE, t)))!;
      expect([...result.currentEntries, ...result.nextEntries]).not.toContain(tbd);
    }
  });

  it("a day-0 span crossing midnight is current on day 1", () => {
    const now = timelineNow(all, ctx(crInstant("2027-08-15", "00:15")));
    expect(now?.minutes).toBe(1440 + 15);
    expect(now?.time).toBe("00:15");
    expect(titles(now!.currentEntries)).toEqual(["Última ronda"]);
  });

  it("past every entry: nothing next (and nothing is 'late')", () => {
    const now = timelineNow(all, ctx(crInstant("2027-08-15", "03:00")));
    expect(now).toEqual({ minutes: 1440 + 180, time: "03:00", currentEntries: [], nextEntries: [] });
  });

  it("no panel without a wedding date, without a time zone, or on any other day", () => {
    const instant = crInstant(WEDDING_DATE, "15:40");
    expect(timelineNow(all, ctx(instant, { weddingDate: null }))).toBeNull();
    expect(timelineNow(all, ctx(instant, { timeZone: null }))).toBeNull();
    expect(timelineNow(all, ctx(instant, { timeZone: "Not/AZone" }))).toBeNull();
    expect(timelineNow(all, ctx(crInstant("2027-08-13", "23:59")))).toBeNull();
    expect(timelineNow(all, ctx(crInstant("2027-08-16", "00:00")))).toBeNull();
    // Months before the wedding: no "next" either.
    expect(timelineNow(all, ctx(crInstant("2027-03-01", "10:00")))).toBeNull();
  });

  it("uses the WEDDING's time zone, never the process's", () => {
    // 21:40 UTC = 15:40 in Costa Rica, but already 06:40 next day in Tokyo.
    const instant = new Date("2027-08-14T21:40:00Z");
    for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      expect(titles(timelineNow(all, ctx(instant))!.currentEntries), tz).toEqual(["Música", "Ceremonia"]);
    }
    // Same instant interpreted for a wedding in Tokyo: the day after, 06:40.
    expect(timelineNowMinutes(ctx(instant, { timeZone: "Asia/Tokyo" }))).toBe(1440 + 400);
  });

  it("follows daylight saving: New York's repeated fall-back hour is 01:xx twice", () => {
    const nyDate = "2027-11-07";
    const late = entry({ title: "Cierre", dayOffset: 1, startTime: "01:00", durationMinutes: 60 });
    const nyCtx = (iso: string) => ({ weddingDate: "2027-11-06", timeZone: "America/New_York", now: new Date(iso) });
    // 05:30Z = 01:30 EDT and 06:30Z = 01:30 EST: both inside the 01:00–02:00 wall-clock span.
    expect(titles(timelineNow([late], nyCtx(`${nyDate}T05:30:00Z`))!.currentEntries)).toEqual(["Cierre"]);
    expect(titles(timelineNow([late], nyCtx(`${nyDate}T06:30:00Z`))!.currentEntries)).toEqual(["Cierre"]);
    expect(timelineNow([late], nyCtx(`${nyDate}T07:30:00Z`))!.currentEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------- overview

describe("overview", () => {
  it("counts, first/last start, distinct vendors and phases", () => {
    const v1 = vendor("v1");
    const v2 = vendor("v2");
    const entries = [
      entry({ startTime: "07:00", phase: "getting_ready", vendor: v1 }),
      entry({ startTime: "15:30", phase: "ceremony", vendor: v2 }),
      entry({ dayOffset: 1, startTime: "00:30", phase: "closing", vendor: v1 }),
      entry({ phase: "ceremony" }),
    ];
    const overview = timelineOverview(entries);
    expect(overview).toMatchObject({
      entryCount: 4,
      timedCount: 3,
      untimedCount: 1,
      firstStart: { dayOffset: 0, time: "07:00" },
      lastStart: { dayOffset: 1, time: "00:30" },
      vendorIds: ["v1", "v2"],
      now: null,
    });
    expect(overview.phaseCounts).toEqual({
      getting_ready: 1,
      setup: 0,
      ceremony: 2,
      photos: 0,
      cocktail: 0,
      reception: 0,
      closing: 1,
    });
  });

  it("no first/last without timed entries", () => {
    expect(timelineOverview([entry()])).toMatchObject({ firstStart: null, lastStart: null, timedCount: 0 });
    expect(timelineOverview([])).toMatchObject({ entryCount: 0, vendorIds: [] });
  });

  it("includes current/next when given the wedding context", () => {
    const entries = [entry({ title: "Ceremonia", startTime: "15:30", durationMinutes: 45 })];
    const overview = timelineOverview(entries, { weddingDate: WEDDING_DATE, timeZone: CR, now: crInstant(WEDDING_DATE, "15:31") });
    expect(titles(overview.now!.currentEntries)).toEqual(["Ceremonia"]);
  });

  it("accepts overlapping and identical entries without complaint", () => {
    const same = [entry({ startTime: "14:00", durationMinutes: 60 }), entry({ startTime: "14:00", durationMinutes: 60 })];
    expect(timelineOverview(same).timedCount).toBe(2);
  });
});
