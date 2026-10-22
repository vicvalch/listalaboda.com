"use client";

import { useActionState, type ReactNode } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";

import type { PhotoFormState } from "./actions";

type Props = {
  action: (prev: PhotoFormState, formData: FormData) => Promise<PhotoFormState>;
  /** Lookup keys only; the server re-derives the caller and their membership. */
  hidden: Readonly<Record<string, string>>;
  submitLabel: string;
  pendingLabel: string;
  /** An accessible name when the visible label alone is ambiguous (e.g. "Mover antes"). */
  submitAriaLabel?: string;
  variant?: "primary" | "secondary";
  className?: string;
  buttonClassName?: string;
  children?: ReactNode;
};

/**
 * One photo edit: fields, a submit button, and the result in a live region
 * (polite for success, an alert for failures). The component keeps its
 * state across the page refresh the action triggers, so the message stays
 * announced next to the item it is about (keyed by id in the lists).
 */
export function PhotoForm({
  action,
  hidden,
  submitLabel,
  pendingLabel,
  submitAriaLabel,
  variant = "secondary",
  className = "",
  buttonClassName = "",
  children,
}: Props) {
  const [state, formAction] = useActionState<PhotoFormState, FormData>(action, null);
  return (
    <form action={formAction} className={className}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          label={submitLabel}
          pendingLabel={pendingLabel}
          variant={variant}
          className={buttonClassName}
          ariaLabel={submitAriaLabel}
        />
        <p role="status" aria-live="polite" className="text-sm">
          {state?.ok ? <span key={state.data.nonce}>{state.data.message}</span> : null}
        </p>
      </div>
      {state && !state.ok && state.formError ? (
        <p role="alert" className="text-danger mt-2 text-sm">
          {state.formError}
        </p>
      ) : null}
    </form>
  );
}
