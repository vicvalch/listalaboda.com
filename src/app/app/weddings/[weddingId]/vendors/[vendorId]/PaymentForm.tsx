"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { PAYMENT_NOTE_MAX_LENGTH, type PaymentFormValues } from "@/lib/vendors/payment-validation";

import type { PaymentFormState } from "./payment-actions";

type Submitted = Readonly<{ state: PaymentFormState; submission: number }>;

type Props = {
  action: (prev: PaymentFormState, formData: FormData) => Promise<PaymentFormState>;
  weddingId: string;
  vendorId: string;
  /** Set when editing an existing payment. */
  paymentId?: string;
  id: string;
  defaults: PaymentFormValues;
  /** The vendor's schedule items, already labelled ("Depósito · vence el … · pendiente …"). */
  itemOptions: readonly { value: string; label: string }[];
  currencyName: string;
  submitLabel: string;
  pendingLabel: string;
};

/**
 * One payment: amount, date, the optional schedule item ("Sin cuota" first,
 * never forced) and an optional one-line note. Editing can move a payment
 * between items or to/from "Sin cuota"; the database re-checks every cap.
 */
export function PaymentForm({
  action,
  weddingId,
  vendorId,
  paymentId,
  id,
  defaults,
  itemOptions,
  currencyName,
  submitLabel,
  pendingLabel,
}: Props) {
  const [{ state, submission }, formAction] = useActionState<Submitted, FormData>(
    async (previous, formData) => ({ state: await action(previous.state, formData), submission: previous.submission + 1 }),
    { state: null, submission: 0 },
  );
  const failure = state && !state.ok ? state : null;
  const values = { ...defaults, ...failure?.values };
  const errors = failure?.fieldErrors ?? {};
  const fields = getMessages().payments.fields;
  const itemId = `${id}-scheduleItemId`;
  const itemDescribedBy = [`${itemId}-hint`, errors.scheduleItemId ? `${itemId}-error` : null].filter(Boolean).join(" ");

  return (
    <div className="space-y-2">
      <form key={`${id}-${submission}`} action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="vendorId" value={vendorId} />
        {paymentId ? <input type="hidden" name="paymentId" value={paymentId} /> : null}
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={`${id}-amount`}
            name="amount"
            type="text"
            inputMode="decimal"
            label={fields.amount}
            hint={interpolate(fields.amountHint, { currency: currencyName })}
            autoComplete="off"
            defaultValue={values.amount}
            error={errors.amount}
          />
          <FormField
            id={`${id}-paidOn`}
            name="paidOn"
            type="date"
            label={fields.paidOn}
            defaultValue={values.paidOn}
            error={errors.paidOn}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={itemId} className="block text-sm font-semibold">
            {fields.scheduleItem}
          </label>
          <select
            id={itemId}
            name="scheduleItemId"
            className={inputClass}
            defaultValue={values.scheduleItemId}
            aria-invalid={errors.scheduleItemId ? true : undefined}
            aria-describedby={itemDescribedBy}
          >
            <option value="">{fields.noItem}</option>
            {itemOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={`${itemId}-hint`} className="text-muted text-sm">
            {fields.scheduleItemHint}
          </p>
          {errors.scheduleItemId ? (
            <p id={`${itemId}-error`} className="text-danger text-sm font-medium">
              {errors.scheduleItemId}
            </p>
          ) : null}
        </div>
        <FormField
          id={`${id}-note`}
          name="note"
          type="text"
          label={fields.note}
          hint={fields.noteHint}
          maxLength={PAYMENT_NOTE_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.note}
          error={errors.note}
        />
        <SubmitButton label={submitLabel} pendingLabel={pendingLabel} />
      </form>
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}
