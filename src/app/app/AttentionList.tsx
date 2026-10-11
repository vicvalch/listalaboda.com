import Link from "next/link";

import { textLinkClass } from "@/components/ui/styles";
import type { AttentionRowView } from "@/lib/weddings/overview/presentation";
import type { AttentionLevel } from "@/lib/weddings/overview/types";

/** Text badge per level (color is never the only signal); existing tokens only. */
const levelClass: Record<AttentionLevel, string> = {
  overdue: "border-danger/40 bg-danger-soft text-danger",
  due_soon: "border-accent/30 bg-accent-soft text-accent",
  review: "border-border bg-surface",
  setup: "border-border bg-surface text-muted",
};

export function LevelBadge({ level, label }: { level: AttentionLevel; label: string }) {
  return (
    <span
      data-testid="attention-level"
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${levelClass[level]}`}
    >
      {label}
    </span>
  );
}

type Props = {
  rows: readonly AttentionRowView[];
  /** The global panel names each row's wedding; a card doesn't repeat its own. */
  showWeddingName: boolean;
  reviewText: string;
};

/**
 * Attention rows, in the order given (the overview's). Each row's only
 * control is its "Revisar" link, whose href is `attentionPath`'s.
 */
export function AttentionList({ rows, showWeddingName, reviewText }: Props) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li
          key={row.id}
          data-testid="attention-row"
          data-kind={row.kind}
          className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
        >
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <LevelBadge level={row.level} label={row.levelLabel} />
              {showWeddingName ? (
                <span className="text-sm font-semibold break-words" data-testid="attention-wedding">
                  {row.weddingName}
                </span>
              ) : null}
            </p>
            <p className="font-semibold break-words">{row.title}</p>
            {row.detail ? <p className="text-muted text-sm break-words">{row.detail}</p> : null}
          </div>
          <Link
            href={row.href}
            aria-label={row.linkLabel}
            className={`${textLinkClass} inline-flex min-h-11 shrink-0 items-center self-start text-sm`}
          >
            {reviewText}
          </Link>
        </li>
      ))}
    </ul>
  );
}
