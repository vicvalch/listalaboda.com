import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { INVITE_CONTINUE_PATH, loginPath, safeNextPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { LEGAL_LINKS } from "@/lib/legal/links";

import { SignupForm } from "./SignupForm";

export const metadata: Metadata = { title: getMessages().auth.signup.title };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const { auth, legal } = getMessages();
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
      {/* Batch 1: the consent sentence with both documents linked right inside it. */}
      <p className="text-muted text-sm" data-testid="signup-legal">
        {auth.signup.legalConsent.before}
        <Link href={LEGAL_LINKS.TERMS} className={textLinkClass}>
          {legal.links.terms}
        </Link>
        {auth.signup.legalConsent.between}
        <Link href={LEGAL_LINKS.PRIVACY} className={textLinkClass}>
          {legal.links.privacy}
        </Link>
        {auth.signup.legalConsent.after}
      </p>
      <p className="text-sm">
        {auth.signup.haveAccount}{" "}
        <Link href={loginPath(next)} className={textLinkClass}>
          {auth.signup.goToLogin}
        </Link>
      </p>
    </div>
  );
}
