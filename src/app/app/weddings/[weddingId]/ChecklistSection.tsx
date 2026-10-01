import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { cardClass } from "@/components/ui/styles";
import type { WeddingRole } from "@/lib/authz/wedding";
import {
  STATUS_FILTERS,
  filterItems,
  nextUpItems,
  statusFilterHref,
  type StatusFilter,
} from "@/lib/checklist/filters";
import { timingLine } from "@/lib/checklist/presentation";
import { summarizeProgress } from "@/lib/checklist/progress";
import type { WeddingChecklist } from "@/lib/checklist/service";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { formatWeddingDate } from "@/lib/weddings/format";

import { AddChecklistItem } from "./AddChecklistItem";
import { ChecklistItemRow } from "./ChecklistItemRow";
import { InitializeChecklistForm } from "./InitializeChecklistForm";

type Props = {
  weddingId: string;
  weddingDate: string | null;
  role: WeddingRole;
  /** null when it couldn't be loaded. */
  checklist: WeddingChecklist | null;
  filter: StatusFilter;
  basePath: string;
};

/**
 * The wedding's home: progress, what's next, the list, and "Agregar
 * pendiente". Rendered on the server from data the page loaded after its
 * membership check; only individual forms are client components.
 */
export function ChecklistSection({ weddingId, weddingDate, role, checklist, filter, basePath }: Props) {
  const copy = getMessages().checklist;

  return (
    <section aria-labelledby="checklist-title" className="space-y-6">
      <h2 id="checklist-title" className="text-2xl font-semibold tracking-tight">
        {copy.title}
      </h2>

      {checklist === null ? (
        <Notice tone="error">{copy.loadFailed}</Notice>
      ) : (
        <ChecklistBody
          weddingId={weddingId}
          weddingDate={weddingDate}
          role={role}
          checklist={checklist}
          filter={filter}
          basePath={basePath}
        />
      )}

      {checklist !== null ? <AddChecklistItem weddingId={weddingId} /> : null}
    </section>
  );
}

function ChecklistBody({
  weddingId,
  weddingDate,
  role,
  checklist,
  filter,
  basePath,
}: Props & { checklist: WeddingChecklist }) {
  const copy = getMessages().checklist;
  const isOwner = role === "owner";
  const { items, initialized } = checklist;

  if (items.length === 0) {
    if (initialized) {
      // Emptied by the couple. Never offer to re-seed: that would be a reset.
      return (
        <div className={`${cardClass} space-y-2 text-center`}>
          <h3 className="text-xl font-semibold">{copy.empty.title}</h3>
          <p className="text-muted">{copy.empty.body}</p>
        </div>
      );
    }
    return isOwner ? (
      <div className={`${cardClass} space-y-4`}>
        <h3 className="text-xl font-semibold">{copy.init.ownerTitle}</h3>
        <p className="text-muted">{copy.init.ownerBody}</p>
        <InitializeChecklistForm weddingId={weddingId} label={copy.init.cta} />
        <p className="text-muted text-sm">{copy.init.startEmpty}</p>
      </div>
    ) : (
      <div className={`${cardClass} space-y-2`}>
        <h3 className="text-xl font-semibold">{copy.init.collaboratorTitle}</h3>
        <p className="text-muted">{copy.init.collaboratorBody}</p>
      </div>
    );
  }

  const progress = summarizeProgress(items);
  const visible = filterItems(items, filter);
  const nextUp = nextUpItems(items, weddingDate);
  const counts: Record<StatusFilter, number> = {
    all: items.length,
    pending: progress.pending,
    done: progress.done,
    not_applicable: progress.notApplicable,
  };
  const summary = interpolate(copy.progress.summary, {
    done: formatNumber(progress.done),
    total: formatNumber(progress.applicable),
  });
  const percent = formatNumber(progress.percent / 100, { style: "percent" });

  return (
    <div className="space-y-6">
      {!initialized && isOwner ? (
        <div className="space-y-3 rounded-2xl border border-accent/30 bg-accent-soft p-5">
          <h3 className="font-semibold">{copy.init.offerTitle}</h3>
          <p className="text-sm">{copy.init.offerBody}</p>
          <InitializeChecklistForm
            weddingId={weddingId}
            label={copy.init.offerCta}
            variant="secondary"
          />
        </div>
      ) : null}

      <div className="space-y-2" data-testid="checklist-progress">
        <p id="checklist-progress-label" className="sr-only">
          {copy.progress.label}
        </p>
        <p className="flex items-baseline justify-between gap-4">
          <span className="font-semibold" data-testid="checklist-progress-summary">
            {summary}
          </span>
          <span className="text-muted text-sm" data-testid="checklist-progress-percent">
            {percent}
          </span>
        </p>
        <div
          role="progressbar"
          aria-labelledby="checklist-progress-label"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          aria-valuetext={`${summary} (${percent})`}
          className="h-2.5 overflow-hidden rounded-full bg-accent-soft"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress.percent}%` }} />
        </div>
        {progress.notApplicable > 0 ? (
          <p className="text-muted text-sm">
            {progress.notApplicable === 1
              ? copy.progress.notApplicableOne
              : interpolate(copy.progress.notApplicableMany, {
                  count: formatNumber(progress.notApplicable),
                })}
          </p>
        ) : null}
      </div>

      {nextUp.length > 0 ? (
        <section
          aria-labelledby="next-up-title"
          className="space-y-2 rounded-2xl border border-border bg-surface p-5"
        >
          <h3 id="next-up-title" className="font-semibold">
            {copy.nextUp.title}
          </h3>
          <p className="text-muted text-sm">{copy.nextUp.hint}</p>
          <ol className="space-y-1.5">
            {nextUp.map(({ item, dueDate }) => (
              <li key={item.id} className="flex flex-wrap justify-between gap-x-4 text-sm">
                <a href={`#item-${item.id}`} className="font-semibold hover:underline">
                  {item.title}
                </a>
                <span className="text-muted">{formatWeddingDate(dueDate)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <nav aria-label={copy.filters.label}>
        <ul className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((value) => {
            const current = value === filter;
            return (
              <li key={value}>
                <Link
                  href={statusFilterHref(basePath, value)}
                  aria-current={current ? "page" : undefined}
                  scroll={false}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold ${
                    current
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border bg-surface hover:bg-accent-soft"
                  }`}
                >
                  {copy.filters[value]}
                  <span className={current ? "" : "text-muted"}>({formatNumber(counts[value])})</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {visible.length === 0 ? (
        <p className="text-muted">{copy.empty.filtered}</p>
      ) : (
        <ul className="space-y-3" aria-labelledby="checklist-title" data-testid="checklist-items">
          {visible.map((item) => (
            <ChecklistItemRow
              key={item.id}
              weddingId={weddingId}
              item={item}
              timingText={timingLine(item.timing, weddingDate)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
