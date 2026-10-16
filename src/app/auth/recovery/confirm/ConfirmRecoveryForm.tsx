"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { confirmRecoveryAction, type ConfirmRecoveryState } from "./actions";

/** One button, no fields: the token never reaches the browser's JavaScript. */
export function ConfirmRecoveryForm() {
  const [state, formAction] = useActionState<ConfirmRecoveryState, FormData>(confirmRecoveryAction, null);
  const { recoveryConfirm } = getMessages().auth;

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok && state.formError ? <Notice tone="error">{state.formError}</Notice> : null}
      <SubmitButton label={recoveryConfirm.submit} pendingLabel={recoveryConfirm.submitting} className="w-full" />
    </form>
  );
}
