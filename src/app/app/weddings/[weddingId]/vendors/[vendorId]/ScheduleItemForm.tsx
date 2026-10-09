"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages, interpolate } from "@/lib/i18n";
import { SCHEDULE_LABEL_MAX_LENGTH, type ScheduleItemFormValues } from "@/lib/vendors/payment-validation";

import type { ScheduleItemFormState } from "./payment-actions";

type Submitted = Readonly<{ state: ScheduleItemFormState; submission: number }>;

type Props = {
  action: (prev: ScheduleItemFormState, formData: FormData) => Promise<ScheduleItemFormState>;
  weddingId: string;
  vendorId: string;
  /** Set when editing an existing item. */
  itemId?: string;
  /** Unique per page; prefixes the field ids. */
  id: string;
  defaults: ScheduleItemFormValues;
  /** "colones" / "dólares": what the amount is in (the vendor's currency). */
  currencyName: string;
  submitLabel: string;
  pendingLabel: string;
};

/**
 * One schedule item (label, amount, due date). Works without JavaScript,
 * keeps typed values on errors, wires each error to its field and announces
 * success. Caps (contract, already paid) are decided by the database.
 */
export function ScheduleItemForm({
  action,
  weddingId,
  vendorId,
  itemId,
  id,
  defaults,
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

  return (
    <div className="space-y-2">
      <form key={`${id}-${submission}`} action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="vendorId" value={vendorId} />
        {itemId ? <input type="hidden" name="itemId" value={itemId} /> : null}
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <FormField
          id={`${id}-label`}
          name="label"
          type="text"
          label={fields.label}
          placeholder={itemId ? undefined : fields.labelPlaceholder}
          maxLength={SCHEDULE_LABEL_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.label}
          error={errors.label}
        />
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
            id={`${id}-dueOn`}
            name="dueOn"
            type="date"
            label={fields.dueOn}
            defaultValue={values.dueOn}
            error={errors.dueOn}
          />
        </div>
        <SubmitButton label={submitLabel} pendingLabel={pendingLabel} />
      </form>
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}
