"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { signupAction, type SignupState } from "../actions";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<SignupState, FormData>(signupAction, null);
  const { auth } = getMessages();

  if (state?.ok) {
    return (
      <section aria-labelledby="signup-check-email" className="space-y-2" role="status">
        <h2 id="signup-check-email" className="text-lg font-semibold">
          {auth.signup.checkEmailTitle}
        </h2>
        <p>{auth.signup.checkEmailBody}</p>
      </section>
    );
  }

  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="signup-email"
        name="email"
        type="email"
        label={auth.fields.email}
        autoComplete="email"
        required
        defaultValue={failure?.values?.email}
        error={failure?.fieldErrors?.email}
      />
      <FormField
        id="signup-password"
        name="password"
        type="password"
        label={auth.fields.password}
        hint={auth.fields.passwordHint}
        autoComplete="new-password"
        minLength={8}
        required
        error={failure?.fieldErrors?.password}
      />
      <SubmitButton
        label={auth.signup.submit}
        pendingLabel={auth.signup.submitting}
        className="w-full"
      />
    </form>
  );
}
