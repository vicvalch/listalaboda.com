"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { formText, type FormState } from "@/lib/forms/result";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  parsePaymentInput,
  parseScheduleItemInput,
  type PaymentField,
  type PaymentFormValues,
  type ScheduleItemField,
  type ScheduleItemFormValues,
} from "@/lib/vendors/payment-validation";
import {
  createScheduleItem,
  deleteScheduleItem,
  deleteVendorPayment,
  recordVendorPayment,
  updateScheduleItem,
  updateVendorPayment,
  type PaymentFailureReason,
} from "@/lib/vendors/payments";

/**
 * Vendor schedule item and payment mutations (LB-22, ADR-015). Any member of
 * the wedding. Forms carry only lookup keys (wedding, vendor, item, payment
 * ids) and the typed fields; the service re-derives the caller and their
 * membership, validates again, and the database re-checks every cap under the
 * vendor row lock. Results carry only catalog messages.
 */

function vendorPath(weddingId: string, vendorId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/vendors/${encodeURIComponent(vendorId)}`;
}

function revalidateFinance(weddingId: string, vendorId: string) {
  revalidatePath(vendorPath(weddingId, vendorId));
  revalidatePath(`/app/weddings/${encodeURIComponent(weddingId)}/budget`);
}

/** Maps a service failure to a form message (or a 404 / login redirect). */
async function failureMessage(weddingId: string, vendorId: string, reason: PaymentFailureReason): Promise<string> {
  const copy = getMessages().payments.errors;
  switch (reason) {
    case "unauthenticated":
      await requireUser(vendorPath(weddingId, vendorId));
      return copy.failed;
    case "not_found":
      notFound();
    case "invalid_target":
      revalidatePath(vendorPath(weddingId, vendorId));
      return copy.notFound;
    case "invalid_input":
      return copy.invalid;
    case "contract_required":
      return copy.contractRequired;
    case "schedule_exceeds_contract":
      return copy.scheduleExceedsContract;
    case "schedule_item_below_paid":
      return copy.scheduleItemBelowPaid;
    case "payment_exceeds_schedule_item":
      return copy.paymentExceedsScheduleItem;
    case "payment_exceeds_unscheduled":
      return copy.paymentExceedsUnscheduled;
    case "schedule_item_has_payments":
      return copy.scheduleItemHasPayments;
    case "forbidden":
    case "database_error":
      return copy.failed;
  }
}

/** The form field a financial refusal is about, so its message sits next to it. */
const SCHEDULE_REASON_FIELD: Partial<Record<PaymentFailureReason, ScheduleItemField>> = {
  schedule_exceeds_contract: "amount",
  schedule_item_below_paid: "amount",
};

const PAYMENT_REASON_FIELD: Partial<Record<PaymentFailureReason, PaymentField>> = {
  payment_exceeds_schedule_item: "amount",
  payment_exceeds_unscheduled: "amount",
};

type Saved = { message: string; nonce: string };

export type ScheduleItemFormState = FormState<ScheduleItemField, Saved> | null;
export type PaymentFormState = FormState<PaymentField, Saved> | null;
export type ConfirmState = FormState<never> | null;

function keys(formData: FormData) {
  return { weddingId: formText(formData, "weddingId"), vendorId: formText(formData, "vendorId") };
}

async function saveScheduleItem(formData: FormData, itemId: string | null): Promise<ScheduleItemFormState> {
  const { weddingId, vendorId } = keys(formData);
  await requireUser(vendorPath(weddingId, vendorId));
  const copy = getMessages().payments.schedule;

  const values: ScheduleItemFormValues = {
    label: formText(formData, "label"),
    amount: formText(formData, "amount"),
    dueOn: formText(formData, "dueOn"),
  };
  const parsed = parseScheduleItemInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  const result = itemId
    ? await updateScheduleItem(supabase, weddingId, vendorId, itemId, parsed.input)
    : await createScheduleItem(supabase, weddingId, vendorId, parsed.input);
  if (!result.ok) {
    const message = await failureMessage(weddingId, vendorId, result.reason);
    const field = SCHEDULE_REASON_FIELD[result.reason];
    return field ? { ok: false, fieldErrors: { [field]: message }, values } : { ok: false, formError: message, values };
  }

  revalidateFinance(weddingId, vendorId);
  return { ok: true, data: { message: itemId ? copy.saved : copy.created, nonce: crypto.randomUUID() } };
}

export async function createScheduleItemAction(
  _prev: ScheduleItemFormState,
  formData: FormData,
): Promise<ScheduleItemFormState> {
  return saveScheduleItem(formData, null);
}

export async function updateScheduleItemAction(
  _prev: ScheduleItemFormState,
  formData: FormData,
): Promise<ScheduleItemFormState> {
  return saveScheduleItem(formData, formText(formData, "itemId"));
}

export async function deleteScheduleItemAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const { weddingId, vendorId } = keys(formData);
  await requireUser(vendorPath(weddingId, vendorId));
  const supabase = await createSupabaseServerClient();
  const result = await deleteScheduleItem(supabase, weddingId, vendorId, formText(formData, "itemId"));
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, vendorId, result.reason) };
  revalidateFinance(weddingId, vendorId);
  return { ok: true, data: undefined };
}

async function savePayment(formData: FormData, paymentId: string | null): Promise<PaymentFormState> {
  const { weddingId, vendorId } = keys(formData);
  await requireUser(vendorPath(weddingId, vendorId));
  const copy = getMessages().payments.list;

  const values: PaymentFormValues = {
    amount: formText(formData, "amount"),
    paidOn: formText(formData, "paidOn"),
    scheduleItemId: formText(formData, "scheduleItemId"),
    note: formText(formData, "note"),
  };
  const parsed = parsePaymentInput(values);
  if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors, values };

  const supabase = await createSupabaseServerClient();
  const result = paymentId
    ? await updateVendorPayment(supabase, weddingId, vendorId, paymentId, parsed.input)
    : await recordVendorPayment(supabase, weddingId, vendorId, parsed.input);
  if (!result.ok) {
    const message = await failureMessage(weddingId, vendorId, result.reason);
    const field = PAYMENT_REASON_FIELD[result.reason];
    return field ? { ok: false, fieldErrors: { [field]: message }, values } : { ok: false, formError: message, values };
  }

  revalidateFinance(weddingId, vendorId);
  return { ok: true, data: { message: paymentId ? copy.saved : copy.recorded, nonce: crypto.randomUUID() } };
}

export async function recordPaymentAction(_prev: PaymentFormState, formData: FormData): Promise<PaymentFormState> {
  return savePayment(formData, null);
}

export async function updatePaymentAction(_prev: PaymentFormState, formData: FormData): Promise<PaymentFormState> {
  return savePayment(formData, formText(formData, "paymentId"));
}

export async function deletePaymentAction(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const { weddingId, vendorId } = keys(formData);
  await requireUser(vendorPath(weddingId, vendorId));
  const supabase = await createSupabaseServerClient();
  const result = await deleteVendorPayment(supabase, weddingId, vendorId, formText(formData, "paymentId"));
  if (!result.ok) return { ok: false, formError: await failureMessage(weddingId, vendorId, result.reason) };
  revalidateFinance(weddingId, vendorId);
  return { ok: true, data: undefined };
}
