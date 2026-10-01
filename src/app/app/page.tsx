import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import { requireUser } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatWeddingDate } from "@/lib/weddings/format";
import { listMyWeddings } from "@/lib/weddings/service";

export const metadata: Metadata = { title: getMessages().app.weddings.title };

export default async function MyWeddingsPage() {
  const user = await requireUser("/app");
  const { app, common } = getMessages();
  const weddings = await listMyWeddings(await createSupabaseServerClient(), user.id);

  if (weddings === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.title}</h1>
        <Notice tone="error">{common.unexpectedError}</Notice>
      </section>
    );
  }

  if (weddings.length === 0) {
    return (
      <section className={`${cardClass} mx-auto max-w-xl space-y-4 text-center`}>
        <h1 className="text-2xl font-semibold tracking-tight">{app.weddings.emptyTitle}</h1>
        <p className="text-muted">{app.weddings.emptyBody}</p>
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
        {weddings.map((wedding) => (
          <li key={wedding.id}>
            <Link
              href={`/app/weddings/${wedding.id}`}
              className="block h-full rounded-2xl border border-border bg-surface p-5 shadow-sm transition-colors hover:border-accent"
            >
              <h2 className="text-lg font-semibold">{wedding.name}</h2>
              <p className="text-muted mt-1 text-sm">
                {wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : app.weddings.noDate}
              </p>
              <p className="mt-3 text-sm">
                {wedding.role === "owner" ? app.weddings.roleOwner : app.weddings.roleCollaborator}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
