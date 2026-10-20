import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { BrandSignature } from "@/components/brand/BrandLogo";
import {
  cardClass,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "@/components/ui/styles";
import { getCurrentAccountType } from "@/lib/accounts/session";
import { INVITE_CONTINUE_PATH, INVITE_INVALID_PARAM, INVITE_INVALID_VALUE, loginPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { INVITE_HANDOFF_COOKIE } from "@/lib/membership-invites/handoff";
import { isWellFormedMembershipInviteToken } from "@/lib/membership-invites/token";
import { MY_WEDDINGS_LIST_PATH } from "@/lib/weddings/entry";

import { AcceptInviteForm } from "./AcceptInviteForm";
import { switchAccountAction } from "./actions";

export const metadata: Metadata = { title: getMessages().inviteAccept.title };

export const dynamic = "force-dynamic";

/**
 * Resumes a pending invite from the httpOnly handoff cookie. Renders no
 * token: the page only knows whether one is pending. Rendered per request
 * (it reads cookies), never cached.
 *
 * - no pending invite after a refusal (`?invite=invalid`, set only by the
 *   invite link route and the accept action) → generic invalid state
 * - no pending invite otherwise (QA-02a: confirmed the sign-up on another
 *   device, the 30-minute handoff ran out) → "open the invitation link again
 *   on this device"; nothing is said about the invite itself. An untyped
 *   account gets no `/app` link, which would only lead to the one-time
 *   account-type choice: reopening the link is the way in (SIT-01).
 * - signed out → /login?next=/invite/continue (signup is linked from there)
 * - signed in → explicit "Unirme a la boda" confirmation (a POST)
 *
 * The flag is presentation only (a closed value; forging it only shows the
 * invalid copy), never a token or an authorization input.
 */
export default async function InviteContinuePage({ searchParams }: PageProps<"/invite/continue">) {
  const { common, inviteAccept, inviteInvalid, inviteMissing } = getMessages();
  const token = (await cookies()).get(INVITE_HANDOFF_COOKIE)?.value;
  const user = await getCurrentUser();

  if (!token || !isWellFormedMembershipInviteToken(token)) {
    const refused = (await searchParams)[INVITE_INVALID_PARAM] === INVITE_INVALID_VALUE;
    const copy = refused ? inviteInvalid : inviteMissing;
    // Only an account that already has a type has somewhere to go in /app.
    const canOpenApp = user ? Boolean(await getCurrentAccountType(user.id)) : false;
    return (
      <Shell>
        <section
          className="space-y-4 text-center"
          aria-labelledby="invite-unavailable-title"
          data-testid={refused ? "invite-invalid" : "invite-missing"}
        >
          <h1 id="invite-unavailable-title" className="text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-muted">{copy.body}</p>
          {refused ? null : <p className="text-muted">{inviteMissing.newLink}</p>}
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:justify-center">
            {user ? (
              canOpenApp || refused ? (
                <Link href={MY_WEDDINGS_LIST_PATH} className={primaryButtonClass}>
                  {common.goToMyWeddings}
                </Link>
              ) : null
            ) : (
              <>
                <Link href="/login" className={primaryButtonClass}>
                  {common.login}
                </Link>
                <Link href="/" className={secondaryButtonClass}>
                  {common.goHome}
                </Link>
              </>
            )}
          </div>
        </section>
      </Shell>
    );
  }

  if (!user) redirect(loginPath(INVITE_CONTINUE_PATH));

  return (
    <Shell>
      <section className="space-y-5" aria-labelledby="invite-accept-title">
        <header className="space-y-2">
          <h1 id="invite-accept-title" className="text-2xl font-semibold tracking-tight">
            {inviteAccept.title}
          </h1>
          <p className="text-muted">{inviteAccept.body}</p>
        </header>
        {user.email ? (
          <p className="text-sm">
            {inviteAccept.signedInAs} <span className="font-semibold break-all">{user.email}</span>
          </p>
        ) : null}
        <AcceptInviteForm />
        <form action={switchAccountAction} className="text-sm">
          {inviteAccept.notYou}{" "}
          <button type="submit" className={textLinkClass}>
            {inviteAccept.switchAccount}
          </button>
        </form>
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
