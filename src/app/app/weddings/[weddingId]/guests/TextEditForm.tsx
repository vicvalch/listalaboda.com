"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { secondaryButtonClass } from "@/components/ui/styles";

import type { TextEditState } from "./actions";

const summaryClass = `${secondaryButtonClass} min-h-9 cursor-pointer list-none px-3 py-1.5 [&::-webkit-details-marker]:hidden`;

type Props = {
  /** Server Action: add a guest, rename a guest, or rename a party. */
  action: (prev: TextEditState, formData: FormData) => Promise<TextEditState>;
  /** Lookup keys only (wedding, party or guest id); the server re-derives authority. */
  hidden: Readonly<Record<string, string>>;
  /** Unique per page; prefixes the field id. */
  id: string;
  openLabel: string;
  /** Accessible name of the disclosure when the visible label is generic ("Editar"). */
  openAriaLabel?: string;
  fieldLabel: string;
  defaultValue?: string;
  maxLength: number;
  submitLabel: string;
  pendingLabel: string;
};

/**
 * One text field behind a disclosure ("Agregar invitado", "Editar grupo",
 * "Editar"): works without JavaScript (native <details>), keeps typed text on
 * errors, and announces success in a status region.
 */
export function TextEditForm({
  action,
  hidden,
  id,
  openLabel,
  openAriaLabel,
  fieldLabel,
  defaultValue = "",
  maxLength,
  submitLabel,
  pendingLabel,
}: Props) {
  const [state, formAction] = useActionState<TextEditState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;

  return (
    <details className="group">
      <summary className={summaryClass} aria-label={openAriaLabel}>
        {openLabel}
      </summary>
      <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
        {/* Remount after success: a cleared "add" field, a fresh "edit" value. */}
        <form
          key={state?.ok ? state.data.nonce : id}
          action={formAction}
          className="space-y-3"
          noValidate
        >
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
          <FormField
            id={`${id}-text`}
            name="text"
            type="text"
            label={fieldLabel}
            maxLength={maxLength}
            autoComplete="off"
            defaultValue={failure?.values?.text ?? defaultValue}
            error={failure?.fieldErrors?.text}
          />
          <SubmitButton label={submitLabel} pendingLabel={pendingLabel} variant="secondary" />
        </form>
        <p role="status" className="text-success min-h-5 text-sm font-medium">
          {state?.ok ? state.data.message : null}
        </p>
      </div>
    </details>
  );
}
