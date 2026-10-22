import { headers } from "next/headers";
import Link from "next/link";

import { BrandMonogram, BrandSignature } from "@/components/brand/BrandLogo";
import { secondaryButtonClass, textLinkClass } from "@/components/ui/styles";
import type { AccountType } from "@/lib/accounts/account-type";
import { requireAppEntry } from "@/lib/accounts/session";
import { safeNextPath } from "@/lib/auth/redirect";
import { loadBillingView } from "@/lib/billing/billing-page";
import { BILLING_PATH } from "@/lib/billing/plans";
import { isNeverCharged } from "@/lib/billing/presentation";
import { isBillingAvailable } from "@/lib/billing/runtime";
import { getMessages } from "@/lib/i18n";
import { REQUEST_PATH_HEADER } from "@/lib/supabase/proxy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MY_WEDDINGS_LIST_PATH } from "@/lib/weddings/entry";

import { logoutAction } from "./actions";

// Everything under /app is per-user: never prerender or cache it.
export const dynamic = "force-dynamic";

/**
 * Batch 1: the shell's one-line note for a typed account that has NEVER been
 * charged (no gating: the product stays usable unpaid). Only once billing is
 * configured, never on the billing pages themselves (they say it already),
 * never for an untyped invited account (SIT-01), and hidden whenever the
 * read fails: a database hiccup must never label a paying account unpaid.
 * Reads the same two own-row queries as the billing page; never Stripe.
 */
async function unpaidNoteFor(userId: string, accountType: AccountType | null, requestedPath: string): Promise<string | null> {
  if (accountType === null || !isBillingAvailable() || requestedPath.startsWith(BILLING_PATH)) return null;
  const view = await loadBillingView(await createSupabaseServerClient(), userId, accountType, true);
  if (!view || !isNeverCharged(view)) return null;
  return getMessages().app.unpaidNote[accountType];
}

/**
 * Protected shell. Validates the user on every request (pages and actions
 * validate again: a layout alone is not a security boundary), and sends an
 * account without an account type to the one-time choice first (ACCOUNT-01,
 * ADR-020), whatever `/app` URL was opened: a deep link can't skip it. The
 * one exception (SIT-01) is the wedding that account has just joined through
 * an invite, decided from its membership row, never from the URL.
 *
 * Planners get "Mis bodas" and "Crear boda"; a couple's account is about
 * their own wedding, so neither is offered (the brand link opens it).
 * Typed accounts also get "Facturación" (BILLING-01), only once billing is
 * configured; an invited account without a type never sees it.
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  // The requested path only shapes the post-login destination.
  const requestedPath = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
  const { user, accountType } = await requireAppEntry(requestedPath);
  const { app, common } = getMessages();
  const unpaidNote = await unpaidNoteFor(user.id, accountType, requestedPath);

  return (
    <div className="flex flex-1 flex-col">
      {/* Printed pages (the Cronograma) leave the app chrome out. */}
      <header className="border-b border-border bg-surface print:hidden">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
          {/* Phones get the monogram: the header also wraps navigation, email and logout. */}
          <Link href="/app" className="shrink-0 rounded-md">
            <BrandMonogram alt={common.brand} className="h-10 sm:hidden" />
            <BrandSignature alt={common.brand} className="hidden h-9 sm:block" />
          </Link>
          {accountType === "planner" ? (
            <nav aria-label={app.nav.label} className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {/* The list itself, even with one wedding (`/app` alone opens it). */}
              <Link href={MY_WEDDINGS_LIST_PATH} className="text-sm font-semibold hover:underline">
                {app.nav.myWeddings}
              </Link>
              <Link href="/app/weddings/new" className="text-sm font-semibold hover:underline">
                {app.nav.createWedding}
              </Link>
            </nav>
          ) : accountType === "couple" ? (
            <nav aria-label={app.nav.label} className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {/* `/app` opens a couple's own wedding (or its empty state). */}
              <Link href="/app" className="text-sm font-semibold hover:underline">
                {app.nav.myWedding}
              </Link>
            </nav>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {accountType !== null && isBillingAvailable() ? (
              <Link href={BILLING_PATH} className="text-sm font-semibold hover:underline">
                {app.nav.billing}
              </Link>
            ) : null}
            {user.email ? (
              <p className="text-muted max-w-56 truncate text-sm">
                <span className="sr-only">{app.nav.signedInAs} </span>
                {user.email}
              </p>
            ) : null}
            <form action={logoutAction}>
              <button type="submit" className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}>
                {app.nav.logout}
              </button>
            </form>
          </div>
        </div>
      </header>
      {unpaidNote ? (
        <div className="border-b border-border bg-accent-soft print:hidden" data-testid="unpaid-note">
          <p className="mx-auto max-w-4xl px-4 py-2 text-sm">
            {unpaidNote}{" "}
            <Link href={BILLING_PATH} className={textLinkClass}>
              {app.unpaidNote.link}
            </Link>
          </p>
        </div>
      ) : null}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
