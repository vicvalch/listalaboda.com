"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { requestPasswordResetAction, type ForgotPasswordState } from "../actions";

export function ForgotPasswordForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<ForgotPasswordState, FormData>(requestPasswordResetAction, null);
  const { auth } = getMessages();

  // The same answer whether or not an account exists.
  if (state?.ok) {
    return (
      <section aria-labelledby="forgot-password-sent" className="space-y-2" role="status">
        <h2 id="forgot-password-sent" className="text-lg font-semibold">
          {auth.forgotPassword.sentTitle}
        </h2>
        <p>{auth.forgotPassword.sentBody}</p>
        <p className="text-muted text-sm">{auth.forgotPassword.sentHint}</p>
      </section>
    );
  }

  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="forgot-password-email"
        name="email"
        type="email"
        label={auth.fields.email}
        autoComplete="email"
        required
        defaultValue={failure?.values?.email}
        error={failure?.fieldErrors?.email}
      />
      <SubmitButton
        label={auth.forgotPassword.submit}
        pendingLabel={auth.forgotPassword.submitting}
        className="w-full"
      />
    </form>
  );
}
