import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { requireUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decideWeddingEntry, wantsWeddingList } from "@/lib/weddings/entry";
import { formatWeddingDate } from "@/lib/weddings/format";
import { listMyWeddings } from "@/lib/weddings/service";

export const metadata: Metadata = { title: getMessages().app.weddings.title };

/**
 * Account entry (ADR-017): adapts to the user's own memberships. One wedding
 * opens it directly; `?all=1` ("Mis bodas") always shows the list. A failed
 * list is an error, never an empty state or a redirect.
 */
export default async function MyWeddingsPage({ searchParams }: PageProps<"/app">) {
  const user = await requireUser("/app");
  const { app, common } = getMessages();
  const { all } = await searchParams;
  const entry = decideWeddingEntry(
    await listMyWeddings(await createSupabaseServerClient(), user.id),
    { showList: wantsWeddingList(all) },
  );

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

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.title}</h1>
        <Link href="/app/weddings/new" className={secondaryButtonClass}>
          {app.weddings.createAnother}
        </Link>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2">
        {entry.weddings.map((wedding) => (
          <li key={wedding.id}>
            <Link
              href={`/app/weddings/${wedding.id}`}
              data-testid="wedding-card"
              className="block h-full rounded-2xl border border-border bg-surface p-5 shadow-sm transition-colors hover:border-accent"
            >
              <h2 className="text-lg font-semibold break-words">{wedding.name}</h2>
              <p className="text-muted mt-1 text-sm break-words">
                {wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : app.weddings.noDate}
                {wedding.city ? ` · ${wedding.city}` : null}
              </p>
              <p className="mt-3 text-sm" data-testid="wedding-card-role">
                {wedding.role === "owner" ? app.weddings.roleOwner : app.weddings.roleCollaborator}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
