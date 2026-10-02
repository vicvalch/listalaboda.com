import { describe, expect, it } from "vitest";

import {
  isSupportedTimeZone,
  selectableTimeZones,
  timeZoneLabel,
  weddingLocalToday,
} from "@/lib/weddings/timezone";

// Wedding-local "today": the calendar date in the wedding's IANA zone at a
// fixed instant. Every instant here is explicit (never the real clock), so
// results don't depend on the machine's time zone or the time of day.

const at = (iso: string) => new Date(iso);

describe("weddingLocalToday", () => {
  it("the same instant is a different local date in different zones", () => {
    const instant = at("2027-01-02T02:00:00Z");
    expect(weddingLocalToday("America/Costa_Rica", instant)).toBe("2027-01-01"); // UTC−6
    expect(weddingLocalToday("Europe/Madrid", instant)).toBe("2027-01-02"); // UTC+1
    expect(weddingLocalToday("Asia/Tokyo", instant)).toBe("2027-01-02"); // UTC+9
    expect(weddingLocalToday("America/Lima", instant)).toBe("2027-01-01"); // UTC−5
  });

  it("Tokyo is already tomorrow while the Americas are still today", () => {
    const instant = at("2027-06-14T16:00:00Z");
    expect(weddingLocalToday("Asia/Tokyo", instant)).toBe("2027-06-15");
    expect(weddingLocalToday("America/New_York", instant)).toBe("2027-06-14");
  });

  it("crosses the year boundary at local midnight, not UTC midnight", () => {
    // 05:59 UTC on Jan 1 is still Dec 31 in Costa Rica; 06:00 is Jan 1.
    expect(weddingLocalToday("America/Costa_Rica", at("2027-01-01T05:59:59Z"))).toBe("2026-12-31");
    expect(weddingLocalToday("America/Costa_Rica", at("2027-01-01T06:00:00Z"))).toBe("2027-01-01");
    // Madrid reaches the new year an hour before UTC does.
    expect(weddingLocalToday("Europe/Madrid", at("2026-12-31T22:59:59Z"))).toBe("2026-12-31");
    expect(weddingLocalToday("Europe/Madrid", at("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });

  it("crosses month boundaries, including a leap day", () => {
    expect(weddingLocalToday("America/Lima", at("2028-03-01T04:59:59Z"))).toBe("2028-02-29");
    expect(weddingLocalToday("America/Lima", at("2028-03-01T05:00:00Z"))).toBe("2028-03-01");
    expect(weddingLocalToday("Asia/Tokyo", at("2027-04-30T15:00:00Z"))).toBe("2027-05-01");
  });

  it("follows daylight-saving rules (America/New_York) without any manual offset", () => {
    // DST starts 2027-03-14 at 02:00 EST (07:00Z): local midnight is 05:00Z
    // before the change and 04:00Z after it.
    expect(weddingLocalToday("America/New_York", at("2027-03-14T04:59:59Z"))).toBe("2027-03-13");
    expect(weddingLocalToday("America/New_York", at("2027-03-14T05:00:00Z"))).toBe("2027-03-14");
    expect(weddingLocalToday("America/New_York", at("2027-03-15T03:59:59Z"))).toBe("2027-03-14");
    expect(weddingLocalToday("America/New_York", at("2027-03-15T04:00:00Z"))).toBe("2027-03-15");
    // DST ends 2027-11-07: local midnight moves back to 05:00Z the next day.
    expect(weddingLocalToday("America/New_York", at("2027-11-08T04:59:59Z"))).toBe("2027-11-07");
    expect(weddingLocalToday("America/New_York", at("2027-11-08T05:00:00Z"))).toBe("2027-11-08");
  });

  it("Madrid around its own DST change (2027-03-28)", () => {
    expect(weddingLocalToday("Europe/Madrid", at("2027-03-27T22:59:59Z"))).toBe("2027-03-27");
    expect(weddingLocalToday("Europe/Madrid", at("2027-03-27T23:00:00Z"))).toBe("2027-03-28");
    expect(weddingLocalToday("Europe/Madrid", at("2027-03-28T21:59:59Z"))).toBe("2027-03-28");
    expect(weddingLocalToday("Europe/Madrid", at("2027-03-28T22:00:00Z"))).toBe("2027-03-29");
  });

  it("fails closed (null) for an unknown zone or an invalid instant", () => {
    expect(weddingLocalToday("Mars/Olympus", at("2027-01-01T00:00:00Z"))).toBeNull();
    expect(weddingLocalToday("America/Lima", new Date(Number.NaN))).toBeNull();
  });

  it("is not UTC slicing", () => {
    const instant = at("2027-01-02T02:00:00Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2027-01-02");
    expect(weddingLocalToday("America/Costa_Rica", instant)).not.toBe(
      instant.toISOString().slice(0, 10),
    );
  });
});

describe("isSupportedTimeZone", () => {
  it.each(["America/Costa_Rica", "America/Lima", "America/New_York", "Europe/Madrid", "Asia/Tokyo"])(
    "accepts %s",
    (zone) => {
      expect(isSupportedTimeZone(zone)).toBe(true);
    },
  );

  it.each([
    "Mars/Olympus",
    "America/Not_A_Real_Place",
    "GMT-Definitely-Fake",
    "garbage",
    "random text",
    "-06:00",
    "+01:00",
    "GMT-6",
    "local",
    "browser",
    "america/lima", // wrong casing: Intl would accept it, the database wouldn't
    " America/Lima",
    "",
    "A".repeat(65),
  ])("rejects %j", (zone) => {
    expect(isSupportedTimeZone(zone)).toBe(false);
  });

  it("accepts UTC: Intl knows it under exactly that name (so does Postgres)", () => {
    expect(isSupportedTimeZone("UTC")).toBe(true);
  });

  it("every selectable zone is accepted, sorted and includes the common ones", () => {
    const zones = selectableTimeZones();
    expect(zones.length).toBeGreaterThan(300);
    expect([...zones].sort()).toEqual(zones);
    expect(zones.every(isSupportedTimeZone)).toBe(true);
    for (const zone of ["America/Costa_Rica", "America/Mexico_City", "Europe/Madrid"]) {
      expect(zones).toContain(zone);
    }
  });

  it("labels zones readably without changing the identifier", () => {
    expect(timeZoneLabel("America/Costa_Rica")).toBe("America/Costa Rica");
    expect(timeZoneLabel("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos Aires");
  });
});
