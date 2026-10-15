import type { Metadata } from "next";
import Link from "next/link";

import { primaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { forgotPasswordPath, recoveryNext } from "@/lib/auth/recovery";
import { getRecoveryUser } from "@/lib/auth/recovery-session";
import { loginPath } from "@/lib/auth/redirect";
import { getMessages } from "@/lib/i18n";

import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: getMessages().auth.resetPassword.title };

/**
 * Chooses the new password (AUTH-RECOVERY-01). The form exists only for a
 * session that a recent recovery link established (checked on the server,
 * again in the action); anyone else is offered a new link.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { auth } = getMessages();
  const params = await searchParams;
  const next = recoveryNext(typeof params.next === "string" ? params.next : undefined);
  const user = await getRecoveryUser();

  if (!user) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{auth.resetPassword.invalidTitle}</h1>
          <p className="text-muted">{auth.resetPassword.invalidBody}</p>
        </header>
        <Link href={forgotPasswordPath(next)} className={`${primaryButtonClass} w-full`}>
          {auth.resetPassword.requestNew}
        </Link>
        <p className="text-sm">
          <Link href={loginPath(next)} className={textLinkClass}>
            {auth.forgotPassword.backToLogin}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{auth.resetPassword.title}</h1>
        <p className="text-muted">{auth.resetPassword.intro}</p>
        {user.email ? (
          <p className="text-sm">
            {auth.resetPassword.account} <span className="font-semibold">{user.email}</span>
          </p>
        ) : null}
      </header>
      <ResetPasswordForm next={next} />
    </div>
  );
}
