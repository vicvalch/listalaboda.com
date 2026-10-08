import { describe, expect, it } from "vitest";

import {
  MONEY_MAX_MINOR,
  VENDOR_CURRENCIES,
  formatMoney,
  isMoneyMinor,
  isVendorCurrency,
  moneyInputValue,
  parseMoneyAmount,
} from "@/lib/vendors/money";

// LB-21 (ADR-014): vendor money is integer minor units of CRC or USD.

describe("currencies", () => {
  it("supports exactly CRC and USD", () => {
    expect(VENDOR_CURRENCIES).toEqual(["CRC", "USD"]);
    expect(isVendorCurrency("CRC")).toBe(true);
    expect(isVendorCurrency("USD")).toBe(true);
    for (const other of ["EUR", "MXN", "crc", "usd", "", " USD", "US$", "₡", null, undefined, 1]) {
      expect(isVendorCurrency(other), String(other)).toBe(false);
    }
  });

  it("keeps the maximum below the JS safe-integer range", () => {
    expect(MONEY_MAX_MINOR).toBe(99_999_999_999_999);
    expect(Number.isSafeInteger(MONEY_MAX_MINOR)).toBe(true);
    expect(MONEY_MAX_MINOR).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe("parseMoneyAmount", () => {
  it.each([
    // plain digits
    ["1200", 120_000],
    ["0", 0],
    ["5", 500],
    ["007", 700],
    // grouping: one separator kind, groups of three
    ["1 200", 120_000],
    ["1.200", 120_000],
    ["1,200", 120_000],
    ["12.000", 1_200_000],
    ["123,456", 12_345_600],
    // a single separator + exactly three digits is grouping, never decimals
    ["12.345", 1_234_500],
    ["1.200.000", 120_000_000],
    ["1,200,000", 120_000_000],
    ["1 200 000", 120_000_000],
    ["2 400 000", 240_000_000],
    ["2 400 000", 240_000_000],
    ["999.999.999.999", 99_999_999_999_900],
    // decimals: one or two digits after the last separator
    ["1200.50", 120_050],
    ["1200,50", 120_050],
    ["1200.5", 120_050],
    ["1200,5", 120_050],
    ["0,99", 99],
    ["0.01", 1],
    ["1.5", 150],
    ["12,34", 1234],
    // grouping + decimals
    ["1.200,50", 120_050],
    ["1,200.50", 120_050],
    ["1 200,50", 120_050],
    ["1 200.5", 120_050],
    ["1.234.567,89", 123_456_789],
    ["1,234,567.89", 123_456_789],
    // surrounding whitespace
    ["  1200  ", 120_000],
    // the maximum
    ["999999999999,99", MONEY_MAX_MINOR],
    ["999.999.999.999,99", MONEY_MAX_MINOR],
  ])("%j → %d minor units", (raw, minor) => {
    const result = parseMoneyAmount(raw);
    expect(result).toEqual({ ok: true, value: minor });
    if (result.ok && result.value !== null) expect(Number.isSafeInteger(result.value)).toBe(true);
  });

  it("treats blank input as no amount", () => {
    for (const raw of ["", "   ", " "]) {
      expect(parseMoneyAmount(raw)).toEqual({ ok: true, value: null });
    }
  });

  it.each([
    // ambiguous or malformed grouping
    "1.2.3",
    "1,20,0",
    "12..00",
    "1..200",
    "1.200.50",
    "1200.500",
    "1200,500",
    "12.34.567",
    "1.2345",
    "1,2345",
    "1 20",
    "12 34",
    "1  200",
    "1. 200",
    "1 .200",
    "1.200 000",
    "1,200 000",
    "1,200.000",
    "1.200,000",
    "1,234,567.891",
    "1.200,5.0",
    "1,200,50.5",
    // decimals
    "0.001",
    "0,500",
    "12,3456",
    "1.234,567",
    // edges
    ".50",
    ",5",
    "1200.",
    "1200,",
    "1.",
    ".",
    ",",
    // signs, letters, symbols, exponents
    "-1200",
    "+1200",
    "−5",
    "1e5",
    "1E3",
    "abc",
    "12a",
    "₡1200",
    "$1200",
    "1200 USD",
    "US$ 5",
    "Infinity",
    "NaN",
    "0x10",
    "1_000",
    "1'000",
    "١٢٣",
    "12\t00",
    "12\n00",
  ])("refuses %j", (raw) => {
    expect(parseMoneyAmount(raw)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses amounts above the maximum without losing precision", () => {
    expect(parseMoneyAmount("1000000000000")).toEqual({ ok: false, reason: "too_large" });
    expect(parseMoneyAmount("999999999999999")).toEqual({ ok: false, reason: "too_large" });
    expect(parseMoneyAmount("1.000.000.000.000")).toEqual({ ok: false, reason: "too_large" });
    // One minor unit over the maximum.
    expect(parseMoneyAmount("1000000000000,00")).toEqual({ ok: false, reason: "too_large" });
    // Far beyond any safe integer: still a clean refusal, never a rounded number.
    expect(parseMoneyAmount("99999999999999999999")).toEqual({ ok: false, reason: "too_large" });
    expect(parseMoneyAmount("9".repeat(40))).toEqual({ ok: false, reason: "invalid" });
  });

  it("never rounds through floating point", () => {
    // 0.1 + 0.2-style traps: exact integer assembly.
    expect(parseMoneyAmount("0,29")).toEqual({ ok: true, value: 29 });
    expect(parseMoneyAmount("1,15")).toEqual({ ok: true, value: 115 });
    expect(parseMoneyAmount("4,35")).toEqual({ ok: true, value: 435 });
    expect(parseMoneyAmount("9007199254,99")).toEqual({ ok: true, value: 900_719_925_499 });
    expect(parseMoneyAmount("999999999999,98")).toEqual({ ok: true, value: 99_999_999_999_998 });
  });
});

describe("isMoneyMinor", () => {
  it("accepts whole numbers within 0 – max", () => {
    for (const value of [0, 1, 120_000, MONEY_MAX_MINOR]) expect(isMoneyMinor(value)).toBe(true);
    for (const value of [-1, 1.5, MONEY_MAX_MINOR + 1, Number.NaN, Infinity, "100", null]) {
      expect(isMoneyMinor(value), String(value)).toBe(false);
    }
  });
});

describe("moneyInputValue", () => {
  it("renders an editable form that parses back to the same amount", () => {
    expect(moneyInputValue(null)).toBe("");
    expect(moneyInputValue(0)).toBe("0");
    expect(moneyInputValue(5)).toBe("0,05");
    expect(moneyInputValue(120_000)).toBe("1200");
    expect(moneyInputValue(120_050)).toBe("1200,50");
    expect(moneyInputValue(MONEY_MAX_MINOR)).toBe("999999999999,99");
    for (const minor of [0, 1, 99, 100, 120_050, 240_000_000, MONEY_MAX_MINOR]) {
      expect(parseMoneyAmount(moneyInputValue(minor))).toEqual({ ok: true, value: minor });
    }
  });
});

describe("formatMoney", () => {
  it("formats colones with ₡ and Spanish grouping, without zero cents", () => {
    expect(formatMoney(240_000_000, "CRC")).toBe("2.400.000 ₡");
    expect(formatMoney(120_000, "CRC")).toBe("1.200 ₡");
  });

  it("formats dollars as US$, never a bare $", () => {
    const text = formatMoney(350_000, "USD");
    expect(text).toBe("3.500 US$");
    expect(text).toMatch(/US\$/);
  });

  it("shows cents only when they are not zero", () => {
    expect(formatMoney(120_050, "USD")).toBe("1.200,50 US$");
    expect(formatMoney(5, "CRC")).toBe("0,05 ₡");
    expect(formatMoney(100, "USD")).toBe("1 US$");
  });

  it("formats zero", () => {
    expect(formatMoney(0, "CRC")).toBe("0 ₡");
    expect(formatMoney(0, "USD")).toBe("0 US$");
  });

  it("formats large amounts exactly (number or bigint)", () => {
    expect(formatMoney(MONEY_MAX_MINOR, "CRC")).toBe("999.999.999.999,99 ₡");
    // A total beyond Number.MAX_SAFE_INTEGER stays exact as a bigint.
    expect(formatMoney(BigInt("1999999999999998"), "USD")).toBe("19.999.999.999.999,98 US$");
  });

  it("never mixes currencies: one amount, one currency", () => {
    const crc = formatMoney(100_000, "CRC");
    const usd = formatMoney(100_000, "USD");
    expect(crc).not.toContain("US$");
    expect(usd).not.toContain("₡");
  });
});
