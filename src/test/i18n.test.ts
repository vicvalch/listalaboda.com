import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE, formatDate, formatNumber, getMessages } from "@/lib/i18n";

function leafValues(node: unknown): unknown[] {
  if (node && typeof node === "object") {
    return Object.values(node).flatMap(leafValues);
  }
  return [node];
}

describe("i18n foundation", () => {
  it("defaults to Spanish", () => {
    expect(DEFAULT_LOCALE).toBe("es");
  });

  it("serves the homepage copy from the Spanish catalog", () => {
    const { home } = getMessages();
    expect(home.brand).toBe("listalaboda.com");
    expect(home.tagline).toBe("Organiza tu boda, un pendiente a la vez.");
  });

  it("contains only non-empty strings", () => {
    const values = leafValues(getMessages());
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect((value as string).trim()).not.toBe("");
    }
  });

  it("formats dates in Spanish via Intl", () => {
    const date = new Date(Date.UTC(2027, 9, 16, 12));
    expect(formatDate(date, { month: "long", timeZone: "UTC" })).toBe("octubre");
    expect(formatDate(date, { dateStyle: "long", timeZone: "UTC" })).toBe(
      "16 de octubre de 2027",
    );
  });

  it("formats numbers with Spanish conventions", () => {
    expect(formatNumber(12345.5)).toBe("12.345,5");
  });
});
