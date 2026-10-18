"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { confirmSignupAction, type ConfirmSignupState } from "./actions";

/** One button and the continuation: the token never reaches the browser's JavaScript. */
export function ConfirmSignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<ConfirmSignupState, FormData>(confirmSignupAction, null);
  const { signupConfirm } = getMessages().auth;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      {state && !state.ok && state.formError ? <Notice tone="error">{state.formError}</Notice> : null}
      <SubmitButton label={signupConfirm.submit} pendingLabel={signupConfirm.submitting} className="w-full" />
    </form>
  );
}
