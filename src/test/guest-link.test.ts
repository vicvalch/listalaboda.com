import { describe, expect, it } from "vitest";

import {
  GUEST_LINK_DAYS_AFTER_WEDDING,
  GUEST_LINK_UNDATED_DAYS,
  guestLinkExpiresAt,
  guestLinkState,
  guestRsvpPath,
} from "@/lib/guests/link";

const ISSUED = "2026-10-02T12:00:00.000Z";

describe("guest link expiry (derived, mirrors the database)", () => {
  it("is a defined, finite point after the wedding", () => {
    expect(GUEST_LINK_DAYS_AFTER_WEDDING).toBe(30);
    expect(GUEST_LINK_UNDATED_DAYS).toBe(365);
  });

  it("dated wedding: works through wedding day + 30, ends 00:00 UTC the day after", () => {
    expect(guestLinkExpiresAt(ISSUED, "2027-08-14").toISOString()).toBe("2027-09-14T00:00:00.000Z");
    // Month and leap-year boundaries.
    expect(guestLinkExpiresAt(ISSUED, "2028-02-29").toISOString()).toBe("2028-03-31T00:00:00.000Z");
    expect(guestLinkExpiresAt(ISSUED, "2027-12-15").toISOString()).toBe("2028-01-15T00:00:00.000Z");
  });

  it("does not depend on when the link was issued once the wedding has a date", () => {
    expect(guestLinkExpiresAt("2020-01-01T00:00:00.000Z", "2027-08-14")).toEqual(
      guestLinkExpiresAt(ISSUED, "2027-08-14"),
    );
  });

  it("no wedding date: 365 days after the link was issued", () => {
    expect(guestLinkExpiresAt(ISSUED, null).toISOString()).toBe("2027-10-02T12:00:00.000Z");
  });

  it("moving the wedding date moves the deadline", () => {
    expect(guestLinkExpiresAt(ISSUED, "2027-08-14").getTime()).toBeLessThan(
      guestLinkExpiresAt(ISSUED, "2027-10-01").getTime(),
    );
  });
});

describe("guest link state", () => {
  const link = { tokenIssuedAt: ISSUED, revokedAt: null };

  it("active before the deadline, expired from it on", () => {
    expect(guestLinkState(link, "2027-08-14", new Date("2027-09-13T23:59:59.999Z"))).toBe("active");
    expect(guestLinkState(link, "2027-08-14", new Date("2027-09-14T00:00:00.000Z"))).toBe("expired");
  });

  it("revoked wins over everything", () => {
    const revoked = { ...link, revokedAt: "2026-11-01T00:00:00.000Z" };
    expect(guestLinkState(revoked, "2090-01-01", new Date(ISSUED))).toBe("revoked");
  });
});

describe("guest link path", () => {
  it("carries the token in the path, never a query string", () => {
    const token = "A".repeat(43);
    expect(guestRsvpPath(token)).toBe(`/rsvp/${token}`);
    expect(guestRsvpPath(token)).not.toContain("?");
  });
});
