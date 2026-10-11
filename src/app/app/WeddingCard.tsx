import Link from "next/link";

import { textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import type { BasicCardView, RichCardView } from "@/lib/weddings/overview/presentation";
import type { AttentionLevel } from "@/lib/weddings/overview/types";

import { AttentionList } from "./AttentionList";

/** Only time-bound levels color the card's edge; never the whole card. */
const accentClass: Partial<Record<AttentionLevel, string>> = {
  overdue: "border-l-4 border-l-danger",
  due_soon: "border-l-4 border-l-accent",
};

/**
 * One wedding on "Mis bodas". An article, not a whole-card link: it holds
 * its own attention links. The basic variant (overview unavailable) shows
 * identity only.
 */
export function WeddingCard({ card }: { card: BasicCardView | RichCardView }) {
  const copy = getMessages().app.weddings;
  const rich = "facts" in card ? card : null;
  const accent = rich?.accent ? (accentClass[rich.accent] ?? "") : "";

  return (
    <article
      data-testid="wedding-card"
      data-attention-level={rich?.accent ?? undefined}
      className={`space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6 ${accent}`}
    >
      <header className="space-y-1">
        <h3 className="text-lg font-semibold break-words">
          <Link href={card.href} className="underline-offset-4 hover:underline">
            {card.name}
          </Link>
        </h3>
        <p className="text-muted text-sm break-words" data-testid="wedding-card-date">
          {card.dateLine}
          {rich?.countdown ? (
            <>
              {" · "}
              <span data-testid="wedding-card-countdown">{rich.countdown}</span>
            </>
          ) : null}
        </p>
        <p className="text-sm" data-testid="wedding-card-role">
          {card.roleLabel}
        </p>
      </header>

      {rich && rich.attentionCount ? (
        <section className="space-y-3" data-testid="wedding-card-attention">
          <p className="text-sm font-semibold">{rich.attentionCount}</p>
          <AttentionList rows={rich.attention} showWeddingName={false} reviewText={copy.attention.review} />
          {rich.moreLabel ? (
            <details className="border-t border-border pt-3">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-accent">
                {rich.moreLabel}
              </summary>
              <div className="pt-2">
                <AttentionList rows={rich.moreAttention} showWeddingName={false} reviewText={copy.attention.review} />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {rich ? (
        <dl className="grid gap-3 sm:grid-cols-3" aria-label={copy.card.factsLabel}>
          {rich.facts.map((fact) => (
            <div key={fact.label} className="rounded-lg bg-background px-3 py-2" data-testid="wedding-card-fact">
              <dt className="text-muted text-xs font-semibold">{fact.label}</dt>
              <dd className={`text-sm break-words ${fact.unavailable ? "text-muted" : ""}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {rich?.partial ? <p className="text-muted text-sm">{copy.card.partial}</p> : null}
      {rich?.allClear ? <p className="text-sm text-success">{copy.card.allClear}</p> : null}

      <p>
        <Link
          href={card.href}
          aria-label={interpolate(copy.card.openLabel, { name: card.name })}
          className={`${textLinkClass} inline-flex min-h-11 items-center text-sm`}
        >
          {copy.card.open}
          <span aria-hidden="true">&nbsp;→</span>
        </Link>
      </p>
    </article>
  );
}
