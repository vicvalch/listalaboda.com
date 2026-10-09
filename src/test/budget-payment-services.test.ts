import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { budgetFailure } = await import("@/lib/budget/service");
const { paymentFailure } = await import("@/lib/vendors/payments");
const { vendorFailure } = await import("@/lib/vendors/service");

// LB-22 (ADR-015): how database refusals map to the closed reasons. The
// refusals themselves (triggers, FKs, RLS) are proven against the real stack
// in tests/db/budget-payments*.test.ts.

describe("paymentFailure", () => {
  it("maps each named trigger refusal", () => {
    for (const [message, reason] of [
      ["vendor_contract_required", "contract_required"],
      ["vendor_schedule_exceeds_contract", "schedule_exceeds_contract"],
      ["vendor_schedule_item_below_paid", "schedule_item_below_paid"],
      ["vendor_payment_exceeds_schedule_item", "payment_exceeds_schedule_item"],
      ["vendor_payment_exceeds_unscheduled", "payment_exceeds_unscheduled"],
    ] as const) {
      expect(paymentFailure({ code: "23514", message })).toBe(reason);
    }
  });

  it("other check violations are invalid_input; vendor-side reasons never leak into payment results", () => {
    expect(paymentFailure({ code: "23514", message: 'new row violates check constraint "vendor_payments_note_valid"' })).toBe(
      "invalid_input",
    );
    expect(paymentFailure({ code: "23514", message: "vendor_currency_locked" })).toBe("invalid_input");
    expect(paymentFailure({ code: "23514", message: "toString" })).toBe("invalid_input");
  });

  it("a foreign key is invalid_target on writes and schedule_item_has_payments on item deletion", () => {
    expect(paymentFailure({ code: "23503" })).toBe("invalid_target");
    expect(paymentFailure({ code: "23503" }, "delete_item")).toBe("schedule_item_has_payments");
  });

  it("malformed values, privileges and anything else", () => {
    for (const code of ["22P02", "22007", "22008", "23502"]) expect(paymentFailure({ code }), code).toBe("invalid_input");
    expect(paymentFailure({ code: "42501" })).toBe("forbidden");
    expect(paymentFailure({ code: "XX000", message: "vendor_payment_exceeds_unscheduled" })).toBe("database_error");
    expect(paymentFailure({})).toBe("database_error");
  });
});

describe("vendorFailure (LB-22 guard)", () => {
  it("maps the vendor guard and the delete protection", () => {
    expect(vendorFailure({ code: "23514", message: "vendor_currency_locked" })).toBe("currency_locked");
    expect(vendorFailure({ code: "23514", message: "vendor_contract_required" })).toBe("contract_required");
    expect(vendorFailure({ code: "23514", message: "vendor_contract_below_recorded" })).toBe("contract_below_recorded");
    expect(vendorFailure({ code: "23503" })).toBe("has_financial_records");
  });

  it("keeps LB-21 behavior for everything else", () => {
    expect(vendorFailure({ code: "23514", message: "vendor_payment_exceeds_unscheduled" })).toBe("invalid_input");
    expect(vendorFailure({ code: "23514", message: 'violates check constraint "wedding_vendors_name_valid"' })).toBe(
      "invalid_input",
    );
    expect(vendorFailure({ code: "42501" })).toBe("forbidden");
    expect(vendorFailure({ code: "XX000" })).toBe("database_error");
  });
});

describe("budgetFailure", () => {
  it("maps to the closed budget reasons", () => {
    expect(budgetFailure({ code: "23514" })).toBe("invalid_input");
    expect(budgetFailure({ code: "22P02" })).toBe("invalid_input");
    expect(budgetFailure({ code: "42501" })).toBe("forbidden");
    expect(budgetFailure({ code: "23505" })).toBe("database_error");
  });
});
