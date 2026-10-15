"use client";

import { useActionState, useState, type FormEvent } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/validation";
import { getMessages } from "@/lib/i18n";

import { resetPasswordAction, type ResetPasswordState } from "../actions";

/**
 * The two password fields. A mismatch is shown as soon as the second field
 * is left (and blocks the submit); the server checks everything again.
 */
export function ResetPasswordForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<ResetPasswordState, FormData>(resetPasswordAction, null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmTouched, setConfirmTouched] = useState(false);
  const { auth } = getMessages();

  const failure = state && !state.ok ? state : null;
  const mismatch = confirmTouched && confirmPassword !== "" && confirmPassword !== password;
  const confirmError = mismatch ? auth.validation.passwordMismatch : failure?.fieldErrors?.confirmPassword;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (confirmPassword !== "" && confirmPassword !== password) {
      event.preventDefault();
      setConfirmTouched(true);
    }
  }

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="reset-password"
        name="password"
        type="password"
        label={auth.resetPassword.newPassword}
        hint={auth.fields.passwordHint}
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={failure?.fieldErrors?.password}
      />
      <FormField
        id="reset-password-confirm"
        name="confirmPassword"
        type="password"
        label={auth.resetPassword.confirmPassword}
        autoComplete="new-password"
        required
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        onBlur={() => setConfirmTouched(true)}
        error={confirmError}
      />
      <SubmitButton
        label={auth.resetPassword.submit}
        pendingLabel={auth.resetPassword.submitting}
        className="w-full"
      />
    </form>
  );
}
