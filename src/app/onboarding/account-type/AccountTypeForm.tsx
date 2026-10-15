"use client";

import { useActionState, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/account-type";
import { getMessages } from "@/lib/i18n";

import { selectAccountTypeAction, type AccountTypeState } from "./actions";

/**
 * Two large choices, nothing preselected, and an explicit confirmation whose
 * label names the choice. Choosing a card never saves anything: only the
 * button does. Without JavaScript the radios and the generic button still work.
 */
export function AccountTypeForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<AccountTypeState, FormData>(selectAccountTypeAction, null);
  const failure = state && !state.ok ? state : null;
  const [selected, setSelected] = useState<AccountType | null>(null);
  const copy = getMessages().accountType;
  const fieldError = failure?.fieldErrors?.accountType;

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <input type="hidden" name="next" value={next} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <fieldset aria-describedby={fieldError ? "account-type-error account-type-warning" : "account-type-warning"}>
        <legend className="sr-only">{copy.legend}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {ACCOUNT_TYPES.map((type) => (
            <label
              key={type}
              className="flex cursor-pointer flex-col gap-3 rounded-2xl border-2 border-border bg-surface p-6 transition-colors hover:border-accent/60 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="accountType"
                  value={type}
                  checked={selected === type}
                  onChange={() => setSelected(type)}
                  className="h-5 w-5 shrink-0 accent-accent"
                />
                <span className="text-xl font-semibold">{copy[type].label}</span>
              </span>
              <span className="text-muted leading-6">{copy[type].description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {fieldError ? (
        <p id="account-type-error" className="text-danger text-sm font-medium">
          {fieldError}
        </p>
      ) : null}
      <p id="account-type-warning" className="rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6">
        {copy.warning}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted text-sm sm:max-w-xs">{copy.bothHint}</p>
        <SubmitButton
          label={selected ? copy[selected].submit : copy.submit}
          pendingLabel={copy.submitting}
          className="w-full sm:w-auto"
        />
      </div>
    </form>
  );
}
