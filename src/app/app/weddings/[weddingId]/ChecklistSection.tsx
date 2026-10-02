import Link from "next/link";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import type { WeddingRole } from "@/lib/authz/wedding";
import { STATUS_FILTERS, filterItems, type StatusFilter } from "@/lib/checklist/filters";
import { assignedTo, groupByCategory, nextItems, sortByPlanning } from "@/lib/checklist/planning";
import { shortTimingLabel, timingLine } from "@/lib/checklist/presentation";
import { summarizeProgress, type ChecklistProgress } from "@/lib/checklist/progress";
import type { WeddingChecklist } from "@/lib/checklist/service";
import type { ChecklistItem } from "@/lib/checklist/types";
import { CHECKLIST_VIEWS, checklistHref, type ChecklistView } from "@/lib/checklist/views";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { assigneeLabel, type LabeledMember, type MemberOption } from "@/lib/weddings/members";

import { AddChecklistItem } from "./AddChecklistItem";
import { ChecklistItemRow } from "./ChecklistItemRow";
import { InitializeChecklistForm } from "./InitializeChecklistForm";

type Props = {
  weddingId: string;
  weddingDate: string | null;
  role: WeddingRole;
  /** null when it couldn't be loaded. */
  checklist: WeddingChecklist | null;
  view: ChecklistView;
  filter: StatusFilter;
  basePath: string;
  /** The caller's own membership (from the server-side access check). */
  currentMembershipId: string;
  /** Current members, ordered and labeled; null when they couldn't be loaded. */
  members: readonly LabeledMember[] | null;
};

/** Everything a row needs to show and change its assignee. */
type Assignment = Readonly<{
  members: readonly LabeledMember[];
  options: readonly MemberOption[];
}> | null;

const pillClass = (current: boolean) =>
  `inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold ${
    current ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface hover:bg-accent-soft"
  }`;

/**
 * The wedding's home: planning summary (progress, "Lo próximo"), the view
 * and status selectors, the items, and "Agregar pendiente". Rendered on the
 * server from data the page loaded after its membership check; only
 * individual forms are client components. Every view is derived in memory
 * from the same rows: none of them writes anything.
 */
export function ChecklistSection(props: Props) {
  const copy = getMessages().checklist;
  const { checklist, weddingId } = props;

  return (
    <section aria-labelledby="checklist-title" className="space-y-6">
      <h2 id="checklist-title" className="text-2xl font-semibold tracking-tight">
        {copy.title}
      </h2>

      {checklist === null ? (
        <Notice tone="error">{copy.loadFailed}</Notice>
      ) : (
        <ChecklistBody {...props} checklist={checklist} />
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
  view,
  filter,
  basePath,
  currentMembershipId,
  members,
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
          <p>
            <a href="#add-item-title" className={textLinkClass}>
              {copy.form.addTitle}
            </a>
          </p>
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
  const mine = assignedTo(items, currentMembershipId);
  const minePending = mine.filter((item) => item.status === "pending").length;
  // Status counts describe what the current view can show.
  const viewProgress = view === "mine" ? summarizeProgress(mine) : progress;
  const counts: Record<StatusFilter, number> = {
    all: view === "mine" ? mine.length : items.length,
    pending: viewProgress.pending,
    done: viewProgress.done,
    not_applicable: viewProgress.notApplicable,
  };
  const assignment: Assignment = members
    ? {
        members,
        options: members.map(({ membershipId, optionLabel }) => ({ membershipId, optionLabel })),
      }
    : null;
  const hasRelativeItems = items.some((item) => item.timing.mode === "relative_to_wedding");
  // "Lo próximo" (always the whole wedding's) links must land on a rendered
  // row: pending items show in every view but "mine" under "all" and
  // "pending"; from "mine" they open the list.
  const nextUpBase = checklistHref(basePath, {
    view: view === "mine" ? "list" : view,
    status: filter === "pending" ? "pending" : "all",
  });

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

      <ProgressSummary progress={progress} />

      <NextUp items={items} weddingDate={weddingDate} progress={progress} hrefBase={nextUpBase} />

      {!weddingDate && hasRelativeItems ? (
        <div
          className="space-y-2 rounded-2xl border border-border bg-surface p-4 text-sm"
          data-testid="checklist-no-date"
        >
          <p>{isOwner ? copy.noDate.owner : copy.noDate.collaborator}</p>
          {isOwner ? (
            <p>
              <Link href={`${basePath}/settings`} className={textLinkClass}>
                {copy.noDate.ownerCta}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <nav aria-label={copy.views.label}>
          <ul className="flex flex-wrap gap-2">
            {CHECKLIST_VIEWS.map((value) => {
              const current = value === view;
              return (
                <li key={value}>
                  <Link
                    href={checklistHref(basePath, { view: value, status: filter })}
                    aria-current={current ? "page" : undefined}
                    scroll={false}
                    className={pillClass(current)}
                  >
                    {copy.views[value]}
                    {value === "mine" ? (
                      <span className={current ? "" : "text-muted"}>
                        ({formatNumber(minePending)})
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="text-muted text-sm" data-testid="checklist-view-hint">
          {copy.views.hint[view]}
        </p>

        <nav aria-label={copy.filters.label}>
          <ul className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((value) => {
              const current = value === filter;
              return (
                <li key={value}>
                  <Link
                    href={checklistHref(basePath, { view, status: value })}
                    aria-current={current ? "page" : undefined}
                    scroll={false}
                    className={pillClass(current)}
                  >
                    {copy.filters[value]}
                    <span className={current ? "" : "text-muted"}>
                      ({formatNumber(counts[value])})
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {view === "plan" ? (
        <PlanView
          weddingId={weddingId}
          weddingDate={weddingDate}
          items={items}
          filter={filter}
          assignment={assignment}
        />
      ) : view === "category" ? (
        <CategoryView
          weddingId={weddingId}
          weddingDate={weddingDate}
          items={items}
          filter={filter}
          assignment={assignment}
        />
      ) : view === "mine" ? (
        <MineView
          weddingId={weddingId}
          weddingDate={weddingDate}
          items={mine}
          filter={filter}
          assignment={assignment}
        />
      ) : (
        <ItemList
          weddingId={weddingId}
          weddingDate={weddingDate}
          items={filterItems(items, filter)}
          labelledBy="checklist-title"
          assignment={assignment}
        />
      )}
    </div>
  );
}

function ProgressSummary({ progress }: { progress: ChecklistProgress }) {
  const copy = getMessages().checklist;

  // Nothing applicable: no percentage and no bar, never a misleading 100%.
  if (progress.applicable === 0) {
    return (
      <div className="space-y-2" data-testid="checklist-progress">
        <p className="font-semibold" data-testid="checklist-progress-summary">
          {copy.progress.noneApplicable}
        </p>
        <NotApplicableNote count={progress.notApplicable} />
      </div>
    );
  }

  const summary = interpolate(copy.progress.summary, {
    done: formatNumber(progress.done),
    total: formatNumber(progress.applicable),
  });
  const percent = formatNumber(progress.percent / 100, { style: "percent" });

  return (
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
      <NotApplicableNote count={progress.notApplicable} />
    </div>
  );
}

function NotApplicableNote({ count }: { count: number }) {
  const copy = getMessages().checklist.progress;
  if (count === 0) return null;
  return (
    <p className="text-muted text-sm">
      {count === 1
        ? copy.notApplicableOne
        : interpolate(copy.notApplicableMany, { count: formatNumber(count) })}
    </p>
  );
}

/** "Lo próximo": the first pending items in planning order, derived on read, never stored. */
function NextUp({
  items,
  weddingDate,
  progress,
  hrefBase,
}: {
  items: readonly ChecklistItem[];
  weddingDate: string | null;
  progress: ChecklistProgress;
  hrefBase: string;
}) {
  const { checklist: copy } = getMessages();
  const next = nextItems(items, weddingDate);

  return (
    <section
      aria-labelledby="next-up-title"
      className="space-y-2 rounded-2xl border border-border bg-surface p-5"
    >
      <h3 id="next-up-title" className="font-semibold">
        {copy.nextUp.title}
      </h3>
      {next.length > 0 ? (
        <>
          <p className="text-muted text-sm">{copy.nextUp.hint}</p>
          <ol className="space-y-2" data-testid="next-up-items">
            {next.map((item) => (
              <li key={item.id} className="text-sm">
                <a href={`${hrefBase}#item-${item.id}`} className="font-semibold hover:underline">
                  {item.title}
                </a>
                <span className="text-muted block">
                  {[
                    item.category ? copy.categories[item.category] : null,
                    shortTimingLabel(item.timing, weddingDate),
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-sm" data-testid="next-up-empty">
          {progress.applicable > 0 ? copy.nextUp.allDone : copy.nextUp.noneApplicable}
        </p>
      )}
    </section>
  );
}

type ViewProps = {
  weddingId: string;
  weddingDate: string | null;
  items: readonly ChecklistItem[];
  filter: StatusFilter;
  assignment: Assignment;
};

/**
 * Planning order. Under "Todos", pending items come first in planning order
 * and finished ones (done / no aplica) follow in a collapsed section.
 */
function PlanView({
  weddingId,
  weddingDate,
  items,
  filter,
  assignment,
  noPendingText,
}: ViewProps & { noPendingText?: string }) {
  const copy = getMessages().checklist;

  if (filter !== "all") {
    return (
      <ItemList
        weddingId={weddingId}
        weddingDate={weddingDate}
        items={sortByPlanning(filterItems(items, filter), weddingDate)}
        labelledBy="checklist-title"
        assignment={assignment}
      />
    );
  }

  const pending = sortByPlanning(filterItems(items, "pending"), weddingDate);
  const resolved = items.filter((item) => item.status !== "pending");
  return (
    <div className="space-y-4">
      <ItemList
        weddingId={weddingId}
        weddingDate={weddingDate}
        items={pending}
        labelledBy="checklist-title"
        emptyText={noPendingText ?? copy.plan.noPending}
        assignment={assignment}
      />
      {resolved.length > 0 ? (
        <details className="space-y-3 rounded-2xl border border-border p-4">
          <summary className="min-h-11 cursor-pointer content-center font-semibold">
            {interpolate(copy.plan.resolvedTitle, { count: formatNumber(resolved.length) })}
          </summary>
          <div className="pt-3">
            <ItemList
              weddingId={weddingId}
              weddingDate={weddingDate}
              items={resolved}
              assignment={assignment}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * "Mis pendientes": the items assigned to the current member, laid out like
 * the Plan view (pending first in planning order, then done / no aplica).
 * The status filter narrows it as everywhere else.
 */
function MineView(props: ViewProps) {
  const copy = getMessages().checklist.mine;

  if (props.items.length === 0) {
    return (
      <div className="space-y-1" data-testid="mine-empty">
        <p className="font-semibold">{copy.empty}</p>
        <p className="text-muted text-sm">{copy.emptyHint}</p>
      </div>
    );
  }
  return <PlanView {...props} noPendingText={copy.noPending} />;
}

/** Grouped by category, with each category's progress; persisted order inside. */
function CategoryView({ weddingId, weddingDate, items, filter, assignment }: ViewProps) {
  const copy = getMessages().checklist;
  const groups = groupByCategory(items)
    .map((group) => ({ ...group, visible: filterItems(group.items, filter) }))
    .filter((group) => group.visible.length > 0);

  if (groups.length === 0) return <p className="text-muted">{copy.empty.filtered}</p>;

  return (
    <div className="space-y-8">
      {groups.map(({ category, visible, progress }) => {
        const key = category ?? "none";
        const headingId = `category-${key}-title`;
        const name = category ? copy.categories[category] : copy.form.categoryNone;
        const summary = interpolate(copy.progress.summary, {
          done: formatNumber(progress.done),
          total: formatNumber(progress.applicable),
        });
        return (
          <section
            key={key}
            aria-labelledby={headingId}
            className="space-y-3"
            data-testid="category-group"
            data-category={key}
          >
            <div className="space-y-1.5">
              <h3 id={headingId} className="text-lg font-semibold">
                {name}
              </h3>
              {progress.applicable > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="text-muted shrink-0 text-sm" data-testid="category-progress">
                    {summary}
                  </span>
                  <div
                    role="progressbar"
                    aria-label={interpolate(copy.categoryProgress.label, { category: name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percent}
                    aria-valuetext={summary}
                    className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-accent-soft"
                  >
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-muted text-sm" data-testid="category-progress">
                  {copy.categoryProgress.noneApplicable}
                </p>
              )}
            </div>
            <ItemList
              weddingId={weddingId}
              weddingDate={weddingDate}
              items={visible}
              labelledBy={headingId}
              assignment={assignment}
            />
          </section>
        );
      })}
    </div>
  );
}

function ItemList({
  weddingId,
  weddingDate,
  items,
  labelledBy,
  emptyText,
  assignment,
}: {
  weddingId: string;
  weddingDate: string | null;
  items: readonly ChecklistItem[];
  labelledBy?: string;
  emptyText?: string;
  assignment: Assignment;
}) {
  const copy = getMessages().checklist;
  if (items.length === 0) return <p className="text-muted">{emptyText ?? copy.empty.filtered}</p>;
  return (
    <ul className="space-y-3" aria-labelledby={labelledBy} data-testid="checklist-items">
      {items.map((item) => (
        <ChecklistItemRow
          key={item.id}
          weddingId={weddingId}
          item={item}
          timingText={timingLine(item.timing, weddingDate) ?? copy.timing.none}
          assignment={
            assignment
              ? {
                  label: assigneeLabel(assignment.members, item.assigneeMembershipId),
                  options: assignment.options,
                }
              : null
          }
        />
      ))}
    </ul>
  );
}
