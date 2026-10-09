"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { setBudgetAllocation, setBudgetTotal, type BudgetFailureReason } from "@/lib/budget/service";
import { parseBudgetAmount, parseBudgetCategory, parseBudgetCurrency } from "@/lib/budget/validation";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Budget estimate mutations (LB-22, ADR-015): the wedding total per currency
 * and the per-category estimates. Any member. Saving needs an amount;
 * removing is its own explicit action (never a blank amount). The service
 * re-derives the caller and membership and validates again; the database
 * re-checks everything.
 */

function budgetPath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/budget`;
}

async function failureMessage(weddingId: string, reason: BudgetFailureReason): Promise<string> {
  const copy = getMessages().budget.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(budgetPath(weddingId));
      return copy.failed;
    case "not_found":
      notFound();
    case "invalid_input":
      return copy.invalid;
    case "forbidden":
    case "database_error":
      return copy.failed;
  }
}

export type BudgetField = "amount" | "category";
type Saved = { message: string; nonce: string };
export type BudgetFormState = FormState<BudgetField, Saved> | null;

function saved(message: string): BudgetFormState {
  return { ok: true, data: { message, nonce: crypto.randomUUID() } };
}

/** Sets the total (`currency` + `amount`) or, with a `category`, that category's estimate. */
export async function saveBudgetAmountAction(_prev: BudgetFormState, formData: FormData): Promise<BudgetFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(budgetPath(weddingId));
  const copy = getMessages().budget;

  const forCategory = formData.has("category");
  const values = { amount: formText(formData, "amount"), category: formText(formData, "category") };
  const currency = parseBudgetCurrency(formText(formData, "currency"));
  const amount = parseBudgetAmount(values.amount);
  const category = forCategory ? parseBudgetCategory(values.category) : null;
  if (!currency.ok) return { ok: false, formError: currency.error, values };
  if (!amount.ok || (category && !category.ok)) {
    return {
      ok: false,
      fieldErrors: {
        ...(amount.ok ? {} : { amount: amount.error }),
        ...(category && !category.ok ? { category: category.error } : {}),
      },
      values,
    };
  }

  const supabase = await createSupabaseServerClient();
  const result = category?.ok
    ? await setBudgetAllocation(supabase, weddingId, category.value, currency.value, amount.value)
    : await setBudgetTotal(supabase, weddingId, currency.value, amount.value);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason), values };

  revalidatePath(budgetPath(weddingId));
  return saved(category ? copy.categories.saved : copy.totalForm.saved);
}

/** Removes the total of `currency` or, with a `category`, that category's estimate. */
export async function removeBudgetAmountAction(_prev: BudgetFormState, formData: FormData): Promise<BudgetFormState> {
  const weddingId = formText(formData, "weddingId");
  await requireUser(budgetPath(weddingId));
  const copy = getMessages().budget;

  const currency = parseBudgetCurrency(formText(formData, "currency"));
  const category = formData.has("category") ? parseBudgetCategory(formText(formData, "category")) : null;
  if (!currency.ok || (category && !category.ok)) return { ok: false, formError: copy.errors.invalid };

  const supabase = await createSupabaseServerClient();
  const result = category?.ok
    ? await setBudgetAllocation(supabase, weddingId, category.value, currency.value, null)
    : await setBudgetTotal(supabase, weddingId, currency.value, null);
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, result.reason) };

  revalidatePath(budgetPath(weddingId));
  return saved(category ? copy.categories.removed : copy.totalForm.removed);
}
