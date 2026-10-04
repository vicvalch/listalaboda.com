import { describe, expect, it } from "vitest";

import { formatWeddingTimestamp } from "@/lib/weddings/format";

describe("formatWeddingTimestamp", () => {
  it("shows date and time in the wedding's time zone, naming the zone", () => {
    const text = formatWeddingTimestamp("2026-10-03T18:05:00Z", "America/Costa_Rica");
    expect(text).toContain("3 de octubre de 2026");
    expect(text).toContain("12:05");
    expect(text).toMatch(/GMT-6|CST/);
  });

  it("falls back to UTC (never the server's zone) when the wedding has none", () => {
    const text = formatWeddingTimestamp("2026-10-03T23:30:00Z", null);
    expect(text).toContain("3 de octubre de 2026");
    expect(text).toContain("23:30");
    expect(text).toContain("UTC");
  });
});
