"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { initializeChecklistAction, type InitializeChecklistState } from "./checklist-actions";

/**
 * Explicit, owner-only checklist creation from the suggested template. The
 * page never seeds on GET; this POST is the only trigger, and the database
 * makes a repeat (double submit) a no-op.
 */
export function InitializeChecklistForm({
  weddingId,
  label,
  variant = "primary",
}: {
  weddingId: string;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [state, formAction] = useActionState<InitializeChecklistState, FormData>(
    initializeChecklistAction,
    null,
  );
  const { checklist } = getMessages();

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="weddingId" value={weddingId} />
      {state && !state.ok ? <Notice tone="error">{state.formError}</Notice> : null}
      <SubmitButton label={label} pendingLabel={checklist.init.submitting} variant={variant} />
    </form>
  );
}
