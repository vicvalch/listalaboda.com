import { es } from "@/lib/i18n/messages/es";
import { isVendorCurrency, isMoneyMinor, parseMoneyAmount, type VendorCurrency } from "@/lib/vendors/money";
import { isVendorCategory, type VendorCategory } from "@/lib/vendors/presentation";

/**
 * Budget estimate validation (LB-22, ADR-015): the wedding total per currency
 * and the per-category estimates. Mirrors the CHECKs of
 * `wedding_budget_totals` / `wedding_budget_allocations`; the service runs it
 * again and the database stays authoritative.
 *
 * Saving needs an amount (0 is a valid estimate). Removing an estimate is a
 * separate, explicit action ("Quitar"), never a blank amount.
 */

type FieldResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

const v = es.budget.validation;

export function parseBudgetCurrency(raw: string): FieldResult<VendorCurrency> {
  const value = raw.trim();
  return isVendorCurrency(value) ? { ok: true, value } : { ok: false, error: v.currencyInvalid };
}

export function parseBudgetCategory(raw: string): FieldResult<VendorCategory> {
  const value = raw.trim();
  return isVendorCategory(value) ? { ok: true, value } : { ok: false, error: v.categoryInvalid };
}

/** Required (blank is not "remove"); 0 – the LB-21 money maximum. */
export function parseBudgetAmount(raw: string): FieldResult<number> {
  const result = parseMoneyAmount(raw);
  if (!result.ok) return { ok: false, error: result.reason === "too_large" ? v.amountTooLarge : v.amountInvalid };
  if (result.value === null) return { ok: false, error: v.amountRequired };
  return { ok: true, value: result.value };
}

/** The service's re-check of an amount: null (= remove) or stored-range integer minor units. */
export function isValidBudgetAmount(amountMinor: number | null): boolean {
  return amountMinor === null || isMoneyMinor(amountMinor);
}
