import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandSignature } from "@/components/brand/BrandLogo";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { loginPath, safeNextPath, signupPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { isWellFormedSignupTokenHash } from "@/lib/auth/signup-confirmation";
import { SIGNUP_TOKEN_COOKIE } from "@/lib/auth/signup-confirmation-handoff";
import { getMessages } from "@/lib/i18n";

import { ConfirmSignupForm } from "./ConfirmSignupForm";

export const metadata: Metadata = {
  title: getMessages().auth.signupConfirm.title,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Reads the handoff cookie and the session on every request; never prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * Confirms a signup email link (Batch 3). Rendering it NEVER verifies or
 * consumes anything: it only knows whether a well-formed token is pending in
 * the httpOnly handoff cookie, and renders no token (no field, prop or text).
 * The "Confirmar mi cuenta" POST is the only step that verifies it. No
 * account is shown: nobody is identified until then.
 *
 * Without a pending token (opened again, Back after confirming, an expired
 * handoff): a signed-in person is told the account is ready and continues;
 * anyone else gets the login / sign up again guidance, the same words
 * whatever the account's state.
 */
export default async function SignupConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const copy = getMessages().auth.signupConfirm;
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const pending = isWellFormedSignupTokenHash((await cookies()).get(SIGNUP_TOKEN_COOKIE)?.value);

  if (pending) {
    return (
      <Shell>
        <section className="space-y-5" aria-labelledby="signup-confirm-title">
          <header className="space-y-2">
            <h1 id="signup-confirm-title" className="text-2xl font-semibold tracking-tight">
              {copy.title}
            </h1>
            <p className="text-muted">{copy.body}</p>
          </header>
          <ConfirmSignupForm next={next} />
        </section>
      </Shell>
    );
  }

  if (await getCurrentUser()) {
    return (
      <Shell>
        <section className="space-y-4 text-center" aria-labelledby="signup-confirm-done-title">
          <h1 id="signup-confirm-done-title" className="text-2xl font-semibold tracking-tight">
            {copy.doneTitle}
          </h1>
          <p className="text-muted">{copy.doneBody}</p>
          <div className="pt-2">
            <Link href={next} className={primaryButtonClass}>
              {copy.continue}
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="space-y-4 text-center" aria-labelledby="signup-confirm-unavailable-title">
        <h1 id="signup-confirm-unavailable-title" className="text-2xl font-semibold tracking-tight">
          {copy.unavailableTitle}
        </h1>
        <p className="text-muted">{copy.unavailableBody}</p>
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:justify-center">
          <Link href={loginPath(next)} className={primaryButtonClass}>
            {copy.login}
          </Link>
          <Link href={signupPath(next)} className={secondaryButtonClass}>
            {copy.signup}
          </Link>
        </div>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { common } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Link href="/" className="mb-8 rounded-md">
        <BrandSignature alt={common.brand} className="h-12 sm:h-14" />
      </Link>
      <div className={`w-full max-w-md ${cardClass}`}>{children}</div>
    </main>
  );
}
