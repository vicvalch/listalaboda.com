"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass, secondaryButtonClass } from "@/components/ui/styles";

import type { BudgetFormState } from "./actions";

type Submitted = Readonly<{ state: BudgetFormState; submission: number }>;

type Action = (prev: BudgetFormState, formData: FormData) => Promise<BudgetFormState>;

function useNumberedAction(action: Action) {
  // Numbered submissions remount the fields with the right values (a
  // <select> would otherwise snap back to its first option after an error).
  return useActionState<Submitted, FormData>(
    async (previous, formData) => ({ state: await action(previous.state, formData), submission: previous.submission + 1 }),
    { state: null, submission: 0 },
  );
}

type AmountFormProps = {
  action: Action;
  /** Lookup keys and fixed values (wedding, currency, and the category of an existing row). */
  hidden: Readonly<Record<string, string>>;
  /** Unique per page; prefixes the field ids. */
  id: string;
  amountLabel: string;
  amountHint?: string;
  defaultAmount: string;
  /** For "add a category estimate": a category picker. */
  categorySelect?: Readonly<{ label: string; placeholder: string; options: readonly { value: string; label: string }[] }>;
  submitLabel: string;
  pendingLabel: string;
};

/** One estimate: an amount (0 is valid), optionally with its category. Saving never removes. */
export function BudgetAmountForm({
  action,
  hidden,
  id,
  amountLabel,
  amountHint,
  defaultAmount,
  categorySelect,
  submitLabel,
  pendingLabel,
}: AmountFormProps) {
  const [{ state, submission }, formAction] = useNumberedAction(action);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const categoryId = `${id}-category`;

  return (
    <div className="space-y-2">
      <form key={`${id}-${submission}`} action={formAction} className="space-y-3" noValidate>
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <div className={`grid gap-3 ${categorySelect ? "sm:grid-cols-2" : ""}`}>
          {categorySelect ? (
            <div className="space-y-1.5">
              <label htmlFor={categoryId} className="block text-sm font-semibold">
                {categorySelect.label}
              </label>
              <select
                id={categoryId}
                name="category"
                className={inputClass}
                defaultValue={failure?.values?.category ?? ""}
                aria-invalid={errors.category ? true : undefined}
                aria-describedby={errors.category ? `${categoryId}-error` : undefined}
              >
                <option value="">{categorySelect.placeholder}</option>
                {categorySelect.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {errors.category ? (
                <p id={`${categoryId}-error`} className="text-danger text-sm font-medium">
                  {errors.category}
                </p>
              ) : null}
            </div>
          ) : null}
          <FormField
            id={`${id}-amount`}
            name="amount"
            type="text"
            inputMode="decimal"
            label={amountLabel}
            hint={amountHint}
            autoComplete="off"
            defaultValue={failure?.values?.amount ?? defaultAmount}
            error={errors.amount}
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

type RemoveProps = {
  action: Action;
  hidden: Readonly<Record<string, string>>;
  label: string;
  /** Names exactly what is removed ("Quitar presupuesto de Fotografía en USD"). */
  ariaLabel?: string;
  pendingLabel: string;
  hint?: string;
};

/** Explicitly removes one estimate (the row of its key). */
export function BudgetRemoveButton({ action, hidden, label, ariaLabel, pendingLabel, hint }: RemoveProps) {
  const [state, formAction] = useActionState<BudgetFormState, FormData>(action, null);
  return (
    <form action={formAction} className="space-y-1">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {hint ? <p className="text-muted text-sm">{hint}</p> : null}
      <RemoveSubmit label={label} ariaLabel={ariaLabel} pendingLabel={pendingLabel} />
      <p role="status" className="min-h-5 text-sm font-medium">
        {state?.ok ? <span className="text-success">{state.data.message}</span> : null}
        {state && !state.ok ? <span className="text-danger">{state.formError}</span> : null}
      </p>
    </form>
  );
}

function RemoveSubmit({ label, ariaLabel, pendingLabel }: { label: string; ariaLabel?: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={pending ? undefined : ariaLabel}
      className={`${secondaryButtonClass} text-danger min-h-9 px-3 py-1.5`}
    >
      <span aria-live="polite">{pending ? pendingLabel : label}</span>
    </button>
  );
}
