import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { INVITE_CONTINUE_PATH, loginPath, safeNextPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";

import { SignupForm } from "./SignupForm";

export const metadata: Metadata = { title: getMessages().auth.signup.title };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const { auth } = getMessages();
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);

  if (await getCurrentUser()) redirect(next);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{auth.signup.title}</h1>
        <p className="text-muted">{auth.signup.intro}</p>
      </header>
      {next === INVITE_CONTINUE_PATH ? <Notice tone="info">{auth.invitePending}</Notice> : null}
      <SignupForm next={next} />
      <p className="text-sm">
        {auth.signup.haveAccount}{" "}
        <Link href={loginPath(next)} className={textLinkClass}>
          {auth.signup.goToLogin}
        </Link>
      </p>
    </div>
  );
}
