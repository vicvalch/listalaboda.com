import { headers } from "next/headers";
import Link from "next/link";

import { secondaryButtonClass } from "@/components/ui/styles";
import { requireAppEntry } from "@/lib/accounts/session";
import { safeNextPath } from "@/lib/auth/redirect";
import { getMessages } from "@/lib/i18n";
import { REQUEST_PATH_HEADER } from "@/lib/supabase/proxy";
import { MY_WEDDINGS_LIST_PATH } from "@/lib/weddings/entry";

import { logoutAction } from "./actions";

// Everything under /app is per-user: never prerender or cache it.
export const dynamic = "force-dynamic";

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
 */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  // The requested path only shapes the post-login destination.
  const requestedPath = safeNextPath((await headers()).get(REQUEST_PATH_HEADER));
  const { user, accountType } = await requireAppEntry(requestedPath);
  const { app, common } = getMessages();

  return (
    <div className="flex flex-1 flex-col">
      {/* Printed pages (the Cronograma) leave the app chrome out. */}
      <header className="border-b border-border bg-surface print:hidden">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
          <Link href="/app" className="text-lg font-semibold tracking-tight">
            {common.brand}
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
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
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
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
