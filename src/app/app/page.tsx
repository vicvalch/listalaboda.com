import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass } from "@/components/ui/styles";
import { requireUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { wantsWeddingList } from "@/lib/weddings/entry";
import { loadMyWeddingsPage } from "@/lib/weddings/my-weddings-page";
import { myWeddingsListView } from "@/lib/weddings/overview/presentation";

import { MyWeddingsOverview } from "./MyWeddingsOverview";

export const metadata: Metadata = { title: getMessages().app.weddings.title };

/**
 * Account entry (ADR-017): adapts to the user's own memberships. One wedding
 * opens it directly; `?all=1` ("Mis bodas") always shows the list. A failed
 * list is an error, never an empty state or a redirect. Only the list pays
 * for the multi-wedding overview (LB-24C); if the overview fails or is over
 * its limit, the list still shows, from the first membership read.
 */
export default async function MyWeddingsPage({ searchParams }: PageProps<"/app">) {
  const user = await requireUser("/app");
  const { app, common } = getMessages();
  const { all } = await searchParams;
  // The request's one clock read for the overview (each wedding's own time zone does the rest).
  const now = new Date();
  const entry = await loadMyWeddingsPage(await createSupabaseServerClient(), user.id, {
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
