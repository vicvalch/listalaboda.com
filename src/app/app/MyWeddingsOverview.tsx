import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import type { MyWeddingsListView } from "@/lib/weddings/overview/presentation";

import { AttentionList } from "./AttentionList";
import { WeddingCard } from "./WeddingCard";

/**
 * "Mis bodas" in list mode (LB-24C): see every wedding, what needs
 * attention, and enter the right one. Server-rendered from the view model;
 * nothing here fetches, sorts or derives.
 */
export function MyWeddingsOverview({ view }: { view: MyWeddingsListView }) {
  const copy = getMessages().app.weddings;
  const rich = view.mode === "rich" ? view : null;
  const attention = rich?.attention ?? null;

  return (
    <section className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
          {rich?.summary ? (
            <p className="text-muted" data-testid="my-weddings-summary">
              {rich.summary}
            </p>
          ) : null}
        </div>
        <Link href="/app/weddings/new" className={`${secondaryButtonClass} w-full shrink-0 sm:w-auto`}>
          {copy.createAnother}
        </Link>
      </div>

      {view.notice ? <Notice tone="info">{view.notice}</Notice> : null}

      {attention ? (
        <section
          aria-labelledby="attention-title"
          className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6"
          data-testid="global-attention"
        >
          <h2 id="attention-title" className="text-lg font-semibold">
            {copy.overview.attentionTitle}
          </h2>
          <AttentionList rows={attention.rows} showWeddingName reviewText={copy.attention.review} />
          {attention.moreLabel ? <p className="text-muted text-sm">{attention.moreLabel}</p> : null}
        </section>
      ) : null}

      {rich?.allClear ? (
        <p className="text-success font-semibold" data-testid="my-weddings-all-clear">
          {copy.overview.allClear}
        </p>
      ) : null}

      <section aria-labelledby="weddings-title" className="space-y-4">
        <h2 id="weddings-title" className="text-lg font-semibold">
          {copy.overview.listTitle}
        </h2>
        <ul className="space-y-4">
          {view.cards.map((card) => (
            <li key={card.id}>
              <WeddingCard card={card} />
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
