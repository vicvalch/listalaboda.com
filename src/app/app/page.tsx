import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass } from "@/components/ui/styles";
import { decideCoupleEntry } from "@/lib/accounts/account-type";
import { requireAccountType } from "@/lib/accounts/session";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { wantsWeddingList } from "@/lib/weddings/entry";
import { loadMyWeddingsPage } from "@/lib/weddings/my-weddings-page";
import { myWeddingsListView } from "@/lib/weddings/overview/presentation";
import { listMyWeddings } from "@/lib/weddings/service";

import { CoupleWeddings } from "./CoupleWeddings";
import { MyWeddingsOverview } from "./MyWeddingsOverview";

export const metadata: Metadata = { title: getMessages().app.weddings.title };

/**
 * Account entry (ADR-017, ADR-020): decided server-side from the account
 * type, then the user's own memberships. No account type yet → the one-time
 * choice (`requireAccountType`).
 *
 * Planner: one wedding opens it directly; `?all=1` ("Mis bodas") always shows
 * the list. Only the list pays for the multi-wedding overview (LB-24C); if the
 * overview fails or is over its limit, the list still shows, from the first
 * membership read.
 *
 * Couple: their wedding, never a portfolio (`decideCoupleEntry`): create it,
 * open it, or (an account from before account types with several weddings)
 * a plain list, with nothing changed. `?all` means nothing here.
 *
 * Either way a failed list is an error, never an empty state or a redirect.
 */
export default async function MyWeddingsPage({ searchParams }: PageProps<"/app">) {
  const { user, accountType } = await requireAccountType("/app");
  const { app, common } = getMessages();
  const supabase = await createSupabaseServerClient();

  if (accountType === "couple") {
    const entry = decideCoupleEntry(await listMyWeddings(supabase, user.id));
    if (entry.kind === "redirect") redirect(entry.path);
    if (entry.kind === "error") {
      return (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.couple.legacyTitle}</h1>
          <Notice tone="error">{common.unexpectedError}</Notice>
        </section>
      );
    }
    if (entry.kind === "empty") {
      return (
        <section className={`${cardClass} mx-auto max-w-xl space-y-4 text-center`}>
          <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.couple.emptyTitle}</h1>
          <p className="text-muted">{app.weddings.couple.emptyBody}</p>
          <p className="text-muted text-sm">{app.weddings.couple.emptyInviteHint}</p>
          <Link href="/app/weddings/new" className={primaryButtonClass}>
            {app.weddings.couple.emptyCta}
          </Link>
        </section>
      );
    }
    return <CoupleWeddings weddings={entry.weddings} />;
  }

  const { all } = await searchParams;
  // The request's one clock read for the overview (each wedding's own time zone does the rest).
  const now = new Date();
  const entry = await loadMyWeddingsPage(supabase, user.id, {
    showList: wantsWeddingList(all),
    now,
  });

  // Outside any try/catch: redirect() throws Next's control-flow signal.
  if (entry.kind === "redirect") redirect(entry.path);

  if (entry.kind === "error") {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.title}</h1>
        <Notice tone="error">{common.unexpectedError}</Notice>
      </section>
    );
  }

  if (entry.kind === "empty") {
    return (
      <section className={`${cardClass} mx-auto max-w-xl space-y-4 text-center`}>
        <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.emptyTitle}</h1>
        <p className="text-muted">{app.weddings.emptyBody}</p>
        <p className="text-muted text-sm">{app.weddings.emptyInviteHint}</p>
        <Link href="/app/weddings/new" className={primaryButtonClass}>
          {app.weddings.emptyCta}
        </Link>
      </section>
    );
  }

  return <MyWeddingsOverview view={myWeddingsListView(entry.weddings, entry.overview)} />;
}
