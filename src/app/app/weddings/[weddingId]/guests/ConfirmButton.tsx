"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { secondaryButtonClass } from "@/components/ui/styles";

import type { ConfirmState } from "./actions";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  /** Server Action: remove a guest, revoke a link, or delete a party. */
  action: (prev: ConfirmState, formData: FormData) => Promise<ConfirmState>;
  /** Lookup keys only; the server re-derives the caller and their membership. */
  hidden: Readonly<Record<string, string>>;
  /** Unique per page. */
  id: string;
  openLabel: string;
  openAriaLabel?: string;
  confirmTitle: string;
  /** Each paragraph says exactly what happens (and what doesn't). */
  confirmBody: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
};

/**
 * A destructive guest-list action in two steps: the button opens an inline
 * confirmation that explains the consequences, focused on its confirm
 * button, then the user confirms or cancels. Failures are announced.
 */
export function ConfirmButton({
  action,
  hidden,
  id,
  openLabel,
  openAriaLabel,
  confirmTitle,
  confirmBody,
  confirmLabel,
  cancelLabel,
}: Props) {
  const [state, formAction] = useActionState<ConfirmState, FormData>(action, null);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const descriptionId = `${id}-confirm`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={openAriaLabel}
        className={`${smallButtonClass} text-danger`}
      >
        {openLabel}
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="w-full space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-3"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div id={descriptionId} className="space-y-1 text-sm">
        <p className="font-semibold break-words">{confirmTitle}</p>
        {confirmBody.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      {state && !state.ok ? (
        <p role="alert" className="text-danger text-sm">
          {state.formError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          ref={confirmRef}
          type="submit"
          aria-describedby={descriptionId}
          className={`${smallButtonClass} border-danger text-danger`}
        >
          {confirmLabel}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className={smallButtonClass}>
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}
