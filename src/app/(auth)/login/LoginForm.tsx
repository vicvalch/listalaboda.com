"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { textLinkClass } from "@/components/ui/styles";
import { forgotPasswordPath } from "@/lib/auth/recovery";
import { getMessages } from "@/lib/i18n";

import { loginAction, type LoginState } from "../actions";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, null);
  const failure = state && !state.ok ? state : null;
  const { auth } = getMessages();

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="login-email"
        name="email"
        type="email"
        label={auth.fields.email}
        autoComplete="email"
        required
        defaultValue={failure?.values?.email}
        error={failure?.fieldErrors?.email}
      />
      <FormField
        id="login-password"
        name="password"
        type="password"
        label={auth.fields.password}
        autoComplete="current-password"
        required
        error={failure?.fieldErrors?.password}
      />
      <p className="-mt-2 text-sm">
        <Link href={forgotPasswordPath(next)} className={textLinkClass}>
          {auth.login.forgotPassword}
        </Link>
      </p>
      <SubmitButton
        label={auth.login.submit}
        pendingLabel={auth.login.submitting}
        className="w-full"
      />
    </form>
  );
}
