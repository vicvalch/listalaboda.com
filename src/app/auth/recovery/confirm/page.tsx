import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { FORGOT_PASSWORD_PATH, isWellFormedRecoveryTokenHash } from "@/lib/auth/recovery";
import { RECOVERY_TOKEN_COOKIE } from "@/lib/auth/recovery-handoff";
import { getMessages } from "@/lib/i18n";

import { ConfirmRecoveryForm } from "./ConfirmRecoveryForm";

export const metadata: Metadata = {
  title: getMessages().auth.recoveryConfirm.title,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Reads the handoff cookie on every request; never prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * Confirms a password recovery link (AUTH-RECOVERY-02). Rendering it NEVER
 * verifies or consumes anything: it only knows whether a well-formed token
 * is pending in the httpOnly handoff cookie, and renders no token (no
 * field, prop or text). The "Continuar" POST is the only step that
 * verifies it. No account is shown: nobody is identified until then.
 */
export default async function RecoveryConfirmPage() {
  const copy = getMessages().auth.recoveryConfirm;
  const pending = isWellFormedRecoveryTokenHash((await cookies()).get(RECOVERY_TOKEN_COOKIE)?.value);

  if (!pending) {
    return (
      <Shell>
        <section className="space-y-4 text-center" aria-labelledby="recovery-unavailable-title">
          <h1 id="recovery-unavailable-title" className="text-2xl font-semibold tracking-tight">
            {copy.unavailableTitle}
          </h1>
          <p className="text-muted">{copy.unavailableBody}</p>
          <div className="pt-2">
            <Link href={FORGOT_PASSWORD_PATH} className={primaryButtonClass}>
              {copy.requestNew}
            </Link>
          </div>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="space-y-5" aria-labelledby="recovery-confirm-title">
        <header className="space-y-2">
          <h1 id="recovery-confirm-title" className="text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-muted">{copy.body}</p>
        </header>
        <ConfirmRecoveryForm />
        <Link href={FORGOT_PASSWORD_PATH} className={`${secondaryButtonClass} w-full`}>
          {copy.requestNew}
        </Link>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { common } = getMessages();
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <Link href="/" className="mb-8 text-xl font-semibold tracking-tight">
        {common.brand}
      </Link>
      <div className={`w-full max-w-md ${cardClass}`}>{children}</div>
    </main>
  );
}
