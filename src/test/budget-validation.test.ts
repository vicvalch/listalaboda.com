import { describe, expect, it } from "vitest";

import { isValidBudgetAmount, parseBudgetAmount, parseBudgetCategory, parseBudgetCurrency } from "@/lib/budget/validation";
import {
  isCalendarDate,
  isValidPaymentInput,
  isValidScheduleItemInput,
  parsePaymentInput,
  parseScheduleItemInput,
} from "@/lib/vendors/payment-validation";

// LB-22 (ADR-015): budget, schedule item and payment form validation.

describe("budget validation", () => {
  it("currency: CRC or USD only", () => {
    expect(parseBudgetCurrency("CRC")).toEqual({ ok: true, value: "CRC" });
    expect(parseBudgetCurrency(" USD ")).toEqual({ ok: true, value: "USD" });
    for (const raw of ["", "EUR", "crc", "US$"]) expect(parseBudgetCurrency(raw).ok, raw).toBe(false);
  });

  it("category: the vendor categories (other included)", () => {
    expect(parseBudgetCategory("other")).toEqual({ ok: true, value: "other" });
    expect(parseBudgetCategory("florist").ok).toBe(false);
  });

  it("amount: the LB-21 parser, required, zero allowed", () => {
    expect(parseBudgetAmount("12.000.000")).toEqual({ ok: true, value: 1_200_000_000 });
    expect(parseBudgetAmount("2500,50")).toEqual({ ok: true, value: 250_050 });
    expect(parseBudgetAmount("0")).toEqual({ ok: true, value: 0 });
    expect(parseBudgetAmount("")).toMatchObject({ ok: false });
    expect(parseBudgetAmount("-5")).toMatchObject({ ok: false });
    expect(parseBudgetAmount("1e5")).toMatchObject({ ok: false });
    expect(parseBudgetAmount("999999999999999999")).toMatchObject({ ok: false });
  });

  it("service re-check: null (remove) or stored-range integers", () => {
    expect(isValidBudgetAmount(null)).toBe(true);
    expect(isValidBudgetAmount(0)).toBe(true);
    expect(isValidBudgetAmount(99_999_999_999_999)).toBe(true);
    for (const value of [-1, 1.5, 100_000_000_000_000, Number.NaN]) expect(isValidBudgetAmount(value), String(value)).toBe(false);
  });
});

describe("calendar dates", () => {
  it("accepts real dates, past, today and future, and leap days", () => {
    for (const date of ["2028-02-29", "2000-02-29", "1999-01-01", "2026-10-08", "2099-12-31", "0001-01-01"]) {
      expect(isCalendarDate(date), date).toBe(true);
    }
  });

  it("refuses impossible or malformed dates", () => {
    for (const date of ["2027-02-29", "1900-02-29", "2026-13-01", "2026-04-31", "2026-00-10", "0000-01-01", "26-10-08", "2026/10/08", "2026-10-8", ""]) {
      expect(isCalendarDate(date), date).toBe(false);
    }
  });
});

describe("schedule item input", () => {
  it("parses label, amount (> 0) and due date", () => {
    expect(parseScheduleItemInput({ label: " Depósito ", amount: "300.000", dueOn: "2026-11-01" })).toEqual({
      ok: true,
      input: { label: "Depósito", amountMinor: 30_000_000, dueOn: "2026-11-01" },
    });
  });

  it("reports each invalid field", () => {
    const result = parseScheduleItemInput({ label: "", amount: "0", dueOn: "2026-02-30" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(["amount", "dueOn", "label"]);
    for (const label of ["x".repeat(81), "Dep\nósito", "Dep\u0085"]) {
      expect(parseScheduleItemInput({ label, amount: "1", dueOn: "2026-01-01" }).ok, JSON.stringify(label)).toBe(false);
    }
    for (const amount of ["", "0", "0,00", "-1", "abc"]) {
      expect(parseScheduleItemInput({ label: "A", amount, dueOn: "2026-01-01" }).ok, amount).toBe(false);
    }
    expect(parseScheduleItemInput({ label: "A", amount: "0,01", dueOn: "2026-01-01" }).ok).toBe(true);
  });

  it("the service re-check accepts only normalized input", () => {
    expect(isValidScheduleItemInput({ label: "Depósito", amountMinor: 1, dueOn: "2026-01-01" })).toBe(true);
    expect(isValidScheduleItemInput({ label: " Depósito", amountMinor: 1, dueOn: "2026-01-01" })).toBe(false);
    expect(isValidScheduleItemInput({ label: "Depósito", amountMinor: 0, dueOn: "2026-01-01" })).toBe(false);
    expect(isValidScheduleItemInput({ label: "Depósito", amountMinor: 1.5, dueOn: "2026-01-01" })).toBe(false);
    expect(isValidScheduleItemInput({ label: "Depósito", amountMinor: 1, dueOn: "2026-02-30" })).toBe(false);
  });
});

describe("payment input", () => {
  const ITEM = "55555555-5555-4555-8555-555555555555";

  it("parses amount, date, optional item and optional one-line note", () => {
    expect(parsePaymentInput({ amount: "150.000", paidOn: "2026-10-01", scheduleItemId: "", note: "" })).toEqual({
      ok: true,
      input: { amountMinor: 15_000_000, paidOn: "2026-10-01", scheduleItemId: null, note: null },
    });
    expect(parsePaymentInput({ amount: "1", paidOn: "2019-01-01", scheduleItemId: ITEM, note: " SINPE #8842 " })).toEqual({
      ok: true,
      input: { amountMinor: 100, paidOn: "2019-01-01", scheduleItemId: ITEM, note: "SINPE #8842" },
    });
  });

  it("refuses zero, bad dates, a malformed item and multi-line or long notes", () => {
    const result = parsePaymentInput({ amount: "0", paidOn: "", scheduleItemId: "item-1", note: "a\nb" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(["amount", "note", "paidOn", "scheduleItemId"]);
    expect(parsePaymentInput({ amount: "1", paidOn: "2026-10-01", scheduleItemId: "", note: "x".repeat(501) }).ok).toBe(false);
    expect(parsePaymentInput({ amount: "1", paidOn: "2026-10-01", scheduleItemId: "", note: "x".repeat(500) }).ok).toBe(true);
    expect(parsePaymentInput({ amount: "1", paidOn: "2026-10-01", scheduleItemId: "", note: "tab\there" }).ok).toBe(false);
  });

  it("the service re-check accepts only normalized input", () => {
    const valid = { amountMinor: 1, paidOn: "2026-10-01", scheduleItemId: null, note: null };
    expect(isValidPaymentInput(valid)).toBe(true);
    expect(isValidPaymentInput({ ...valid, note: "" })).toBe(false);
    expect(isValidPaymentInput({ ...valid, note: " x" })).toBe(false);
    expect(isValidPaymentInput({ ...valid, scheduleItemId: "" })).toBe(false);
    expect(isValidPaymentInput({ ...valid, amountMinor: 0 })).toBe(false);
    expect(isValidPaymentInput({ ...valid, amountMinor: 100_000_000_000_000 })).toBe(false);
  });
});
