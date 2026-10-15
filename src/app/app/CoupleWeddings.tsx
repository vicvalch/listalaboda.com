import Link from "next/link";

import { getMessages } from "@/lib/i18n";
import { formatWeddingDate } from "@/lib/weddings/format";
import type { WeddingSummary } from "@/lib/weddings/service";

/**
 * A couple account that already belonged to several weddings before account
 * types existed (ACCOUNT-01, ADR-020 §6). Nothing is deleted, moved or chosen
 * for them: a plain list of their weddings (no overview, attention or
 * create button) and a short explanation.
 */
export function CoupleWeddings({ weddings }: { weddings: readonly WeddingSummary[] }) {
  const { couple: copy, noDate, roleOwner, roleCollaborator } = getMessages().app.weddings;
  return (
    <section className="space-y-6" data-testid="couple-legacy-weddings">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.legacyTitle}</h1>
        <p className="text-muted max-w-prose">{copy.legacyBody}</p>
      </header>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-sm">
        {weddings.map((wedding) => (
          <li key={wedding.id} className="space-y-1 p-5">
            <h2 className="text-lg font-semibold break-words">
              <Link href={`/app/weddings/${wedding.id}`} className="underline-offset-4 hover:underline">
                {wedding.name}
              </Link>
            </h2>
            <p className="text-muted text-sm break-words">
              {wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : noDate}
              {wedding.city ? ` · ${wedding.city}` : null}
            </p>
            <p className="text-sm">{wedding.role === "owner" ? roleOwner : roleCollaborator}</p>
          </li>
        ))}
      </ul>
      <p className="text-muted text-sm max-w-prose">{copy.legacyNote}</p>
    </section>
  );
}
