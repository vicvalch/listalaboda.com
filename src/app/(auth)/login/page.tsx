import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { INVITE_CONTINUE_PATH, safeNextPath, signupPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: getMessages().auth.login.title };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { auth } = getMessages();
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);

  // Already signed in: continue (to /app, or to a pending invite).
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{auth.login.title}</h1>
        <p className="text-muted">{auth.login.intro}</p>
      </header>
      {next === INVITE_CONTINUE_PATH ? <Notice tone="info">{auth.invitePending}</Notice> : null}
      {params.error === "callback" ? (
        <Notice tone="error">{auth.login.callbackFailed}</Notice>
      ) : null}
      <LoginForm next={next} />
      <p className="text-sm">
        {auth.login.noAccount}{" "}
        <Link href={signupPath(next)} className={textLinkClass}>
          {auth.login.createAccount}
        </Link>
      </p>
    </div>
  );
}
