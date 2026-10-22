"use client";

import { useActionState, type ReactNode } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";

import type { PhotoFormState } from "./actions";
import { useAnnounce } from "./PhotoAnnouncer";

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
 * One photo edit: fields, a submit button, and the result shown next to the
 * item it is about and announced by the page's `PhotoAnnouncer` (which also
 * covers forms the refreshed page no longer renders).
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
  const announce = useAnnounce();
  const [state, formAction] = useActionState<PhotoFormState, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    if (result?.ok) announce(result.data.message, "status");
    else if (result?.formError) announce(result.formError, "error");
    return result;
  }, null);
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
        {/* Shown here, announced once by the page's announcer (no second live region). */}
        <p className="text-sm" data-testid="photo-form-result">
          {state?.ok ? <span key={state.data.nonce}>{state.data.message}</span> : null}
        </p>
      </div>
      {state && !state.ok && state.formError ? <p className="text-danger mt-2 text-sm">{state.formError}</p> : null}
    </form>
  );
}
