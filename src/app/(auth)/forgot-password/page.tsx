import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { recoveryNext } from "@/lib/auth/recovery";
import { loginPath } from "@/lib/auth/redirect";
import { getMessages } from "@/lib/i18n";

import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: getMessages().auth.forgotPassword.title };

/**
 * Requests a password recovery email (AUTH-RECOVERY-01). Open to everyone:
 * it reveals nothing about any account. `error=` only picks a fixed notice
 * (a failed link, an expired recovery session); it is never an input to
 * anything else.
 */
export default async function ForgotPasswordPage({ searchParams }: PageProps<"/forgot-password">) {
  const { auth } = getMessages();
  const params = await searchParams;
  const next = recoveryNext(typeof params.next === "string" ? params.next : undefined);
  const notice =
    params.error === "link"
      ? auth.forgotPassword.linkInvalid
      : params.error === "expired"
        ? auth.forgotPassword.sessionExpired
        : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{auth.forgotPassword.title}</h1>
        <p className="text-muted">{auth.forgotPassword.intro}</p>
      </header>
      {notice ? <Notice tone="error">{notice}</Notice> : null}
      <ForgotPasswordForm next={next} />
      <p className="text-sm">
        <Link href={loginPath(next)} className={textLinkClass}>
          {auth.forgotPassword.backToLogin}
        </Link>
      </p>
    </div>
  );
}
