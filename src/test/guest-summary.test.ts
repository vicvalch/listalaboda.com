import { describe, expect, it } from "vitest";

import { guestResponseStatus, summarizeGuests } from "@/lib/guests/summary";

const yes = { rsvp: { attending: true } };
const no = { rsvp: { attending: false } };
const pending = { rsvp: null };

describe("summarizeGuests", () => {
  it("counts an empty list as all zeros", () => {
    expect(summarizeGuests([])).toEqual({
      parties: 0,
      total: 0,
      responded: 0,
      attending: 0,
      notAttending: 0,
      pending: 0,
    });
  });

  it("derives every count from the guests (no RSVP row = pending)", () => {
    const parties = [
      { guests: [yes, no] },
      { guests: [yes, yes, pending] },
      { guests: [pending] },
    ];
    expect(summarizeGuests(parties)).toEqual({
      parties: 3,
      total: 6,
      responded: 4,
      attending: 3,
      notAttending: 1,
      pending: 2,
    });
  });

  it("keeps the invariants for any mix", () => {
    const pool = [yes, no, pending];
    for (let seed = 0; seed < 50; seed += 1) {
      const parties = Array.from({ length: (seed % 4) + 1 }, (_, p) => ({
        guests: Array.from({ length: ((seed + p) % 5) + 1 }, (_, g) => pool[(seed * 7 + p * 3 + g) % 3]),
      }));
      const s = summarizeGuests(parties);
      expect(s.responded).toBe(s.attending + s.notAttending);
      expect(s.pending).toBe(s.total - s.responded);
      expect(s.total).toBe(parties.reduce((n, p) => n + p.guests.length, 0));
    }
  });
});

describe("guestResponseStatus", () => {
  it("maps a response (or its absence) to the organizer label key", () => {
    expect(guestResponseStatus({ attending: true })).toBe("attending");
    expect(guestResponseStatus({ attending: false })).toBe("not_attending");
    expect(guestResponseStatus(null)).toBe("pending");
  });
});
