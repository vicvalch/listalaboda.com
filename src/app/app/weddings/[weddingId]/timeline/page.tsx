import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, primaryButtonClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  formatDuration,
  formatTimelineDate,
  timelineDayLabel,
  timelineDayName,
  timelinePhaseLabel,
  type WallClockPoint,
} from "@/lib/timeline/presentation";
import { getTimelineData, type TimelineVendorOption } from "@/lib/timeline/service";
import {
  entryEnd,
  timelineOverview,
  timelineSections,
  type TimelineEntry,
  type TimelineNow,
  type TimelineOverview,
} from "@/lib/timeline/summary";
import { EMPTY_TIMELINE_FORM, timelineFormValues } from "@/lib/timeline/validation";
import { phoneHref, vendorCategoryDisplay } from "@/lib/vendors/presentation";

import { ConfirmButton } from "../guests/ConfirmButton";
import { createTimelineEntryAction, deleteTimelineEntryAction, updateTimelineEntryAction } from "./actions";
import { PrintButton } from "./PrintButton";
import { TimelineEntryForm, type VendorChoice } from "./TimelineEntryForm";

export const metadata: Metadata = { title: getMessages().timeline.title };

const copy = getMessages().timeline;

const disclosureSummaryClass =
  "inline-flex min-h-9 cursor-pointer list-none items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-accent-soft [&::-webkit-details-marker]:hidden";

const badgeClass = "rounded-full border border-border px-2 py-0.5 text-xs font-semibold";

/**
 * "Cronograma" (LB-23, ADR-016): the wedding day's run of show — a
 * chronological list of wedding-relative wall-clock entries, the wedding day
 * then its continuation after midnight, then "Sin hora". A secondary area
 * next to the checklist (which stays the wedding's home). Any member, owner
 * or collaborator, sees and manages it; membership is checked first, and a
 * non-member, a nonexistent wedding and a malformed id all get the same 404.
 *
 * TWO reads after that check, whatever the size: the wedding (with its
 * vendors for the picker) and the entries (with each linked vendor's
 * operational projection). The clock is read once, here, and only to derive
 * "Ahora / Siguiente" in the wedding's time zone; nothing refreshes by
 * itself and nothing is stored.
 */
export default async function TimelinePage({ params }: PageProps<"/app/weddings/[weddingId]/timeline">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/timeline`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const data = await getTimelineData(supabase, access.access);
  const id = access.access.weddingId;

  if (!data) {
    return (
      <div className="space-y-8">
        <PageHeader weddingId={id} weddingName={null} weddingDate={null} />
        <Notice tone="error">{copy.loadFailed}</Notice>
      </div>
    );
  }

  const overview = timelineOverview(data.entries, {
    weddingDate: data.weddingDate,
    timeZone: data.timeZone,
    now: new Date(),
  });
  const sections = timelineSections(data.entries, data.weddingDate);
  const vendorChoices = data.vendorOptions.map(vendorChoice);
  const currentIds = new Set(overview.now?.currentEntries.map((entry) => entry.id));
  const nextIds = new Set(overview.now?.nextEntries.map((entry) => entry.id));

  return (
    <div className="space-y-8 print:space-y-4">
      <PageHeader weddingId={id} weddingName={data.weddingName} weddingDate={data.weddingDate} />

      {data.entries.length > 0 ? <OverviewLine overview={overview} /> : null}

      {overview.now ? <NowPanel now={overview.now} /> : null}
      {data.timeZone === null && data.entries.length > 0 ? (
        <p className="text-muted text-sm print:hidden" data-testid="timeline-no-time-zone">
          {copy.noTimeZoneHint}
        </p>
      ) : null}

      {data.entries.length === 0 ? (
        <section data-testid="timeline-empty" className={`${cardClass} space-y-2 print:hidden`}>
          <h2 className="text-xl font-semibold">{copy.empty.title}</h2>
          <p className="text-muted">{copy.empty.body}</p>
        </section>
      ) : null}

      <CreateEntry weddingId={id} vendors={vendorChoices} />

      {sections.days.map((day) => {
        const label = timelineDayLabel(data.weddingDate, day.dayOffset);
        return (
          <section
            key={day.dayOffset}
            aria-labelledby={`timeline-day-${day.dayOffset}`}
            data-testid={`timeline-day-${day.dayOffset}`}
            className="space-y-3"
          >
            <h2 id={`timeline-day-${day.dayOffset}`} className="text-xl font-semibold first-letter:uppercase">
              {label.title}
              {label.detail ? <span className="text-muted font-normal"> · {label.detail}</span> : null}
            </h2>
            <ol className="border-l-2 border-border">
              {day.entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  weddingId={id}
                  vendors={vendorChoices}
                  current={currentIds.has(entry.id)}
                  next={nextIds.has(entry.id)}
                />
              ))}
            </ol>
          </section>
        );
      })}

      {sections.untimed.length > 0 ? (
        <section aria-labelledby="timeline-untimed" data-testid="timeline-untimed" className="space-y-3">
          <div>
            <h2 id="timeline-untimed" className="text-xl font-semibold">
              {copy.untimed.title}
            </h2>
            <p className="text-muted text-sm">{copy.untimed.hint}</p>
          </div>
          <ol className="border-l-2 border-dashed border-border">
            {sections.untimed.map((entry) => (
              <EntryRow key={entry.id} entry={entry} weddingId={id} vendors={vendorChoices} current={false} next={false} />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function PageHeader({
  weddingId,
  weddingName,
  weddingDate,
}: {
  weddingId: string;
  weddingName: string | null;
  weddingDate: string | null;
}) {
  return (
    <header className="space-y-3">
      {weddingName ? <p className="text-muted text-sm font-semibold break-words">{weddingName}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <div className="print:hidden">
          <PrintButton label={copy.print} />
        </div>
      </div>
      {weddingDate ? (
        <p className="font-semibold first-letter:uppercase" data-testid="timeline-wedding-date">
          {formatTimelineDate(weddingDate)}
        </p>
      ) : null}
      <p className="text-muted print:hidden">{copy.intro}</p>
      <p className="text-sm print:hidden">
        <Link href={`/app/weddings/${weddingId}`} className={textLinkClass}>
          {copy.backToChecklist}
        </Link>
      </p>
    </header>
  );
}

/** "07:00" or "00:30 (después de medianoche)" for a start on the next day. */
function pointText(point: WallClockPoint): string {
  return point.dayOffset === 0 ? point.time : `${point.time} (${copy.days.afterMidnight})`;
}

function OverviewLine({ overview }: { overview: TimelineOverview<TimelineEntry> }) {
  const parts = [
    overview.entryCount === 1
      ? copy.overview.countOne
      : interpolate(copy.overview.countMany, { count: formatNumber(overview.entryCount) }),
  ];
  // Only facts that exist: no range without timed entries.
  if (overview.firstStart && overview.lastStart) {
    parts.push(
      interpolate(copy.overview.range, { first: pointText(overview.firstStart), last: pointText(overview.lastStart) }),
    );
  }
  if (overview.vendorIds.length > 0) {
    parts.push(
      overview.vendorIds.length === 1
        ? copy.overview.vendorsOne
        : interpolate(copy.overview.vendorsMany, { count: formatNumber(overview.vendorIds.length) }),
    );
  }
  return (
    <p aria-label={copy.overview.label} data-testid="timeline-overview" className="text-muted font-semibold">
      {parts.join(" · ")}
    </p>
  );
}

function spanText(entry: TimelineEntry): string {
  const end = entryEnd(entry);
  if (!entry.startTime) return copy.row.timeTbd;
  if (!end) return entry.startTime;
  // Midnight at the end of a day reads "24:00" rather than a misleading "00:00".
  const endTime = end.dayOffset > entry.dayOffset && end.time === "00:00" ? "24:00" : end.time;
  return `${entry.startTime}–${endTime}`;
}

function NowPanel({ now }: { now: TimelineNow<TimelineEntry> }) {
  return (
    <section
      aria-label={copy.now.label}
      data-testid="timeline-now"
      className="space-y-3 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4 print:hidden"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide">{copy.now.current}</h2>
          {now.currentEntries.length === 0 ? (
            <p className="text-muted text-sm">{copy.now.nothingNow}</p>
          ) : (
            <ul className="space-y-1" data-testid="timeline-now-current">
              {now.currentEntries.map((entry) => (
                <NowItem key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide">{copy.now.next}</h2>
          {now.nextEntries.length === 0 ? (
            <p className="text-muted text-sm">{copy.now.nothingNext}</p>
          ) : (
            <ul className="space-y-1" data-testid="timeline-now-next">
              {now.nextEntries.map((entry) => (
                <NowItem key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-muted text-xs">{interpolate(copy.now.asOf, { time: now.time })}</p>
    </section>
  );
}

function NowItem({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="break-words">
      <a href={`#entry-${entry.id}`} className={textLinkClass}>
        {entry.title}
      </a>{" "}
      <span className="text-muted tabular-nums">· {spanText(entry)}</span>
    </li>
  );
}

function EntryRow({
  entry,
  weddingId,
  vendors,
  current,
  next,
}: {
  entry: TimelineEntry;
  weddingId: string;
  vendors: readonly VendorChoice[];
  current: boolean;
  next: boolean;
}) {
  const row = copy.row;
  const end = entryEnd(entry);
  const crossesMidnight = end !== null && end.dayOffset > entry.dayOffset && end.time !== "00:00";
  const vendor = entry.vendor;
  const tel = vendor?.phone ? phoneHref(vendor.phone) : null;

  return (
    <li
      id={`entry-${entry.id}`}
      data-testid="timeline-entry"
      data-current={current ? "true" : undefined}
      className={`relative -ml-px scroll-mt-4 break-inside-avoid border-l-4 py-4 pr-2 pl-4 sm:grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-6 ${
        current ? "border-accent bg-accent-soft/40 print:border-transparent" : "border-transparent"
      }`}
    >
      <div className="mb-1 sm:mb-0">
        {entry.startTime ? (
          <p className="text-lg font-semibold tabular-nums" data-testid="timeline-entry-time">
            {spanText(entry)}
          </p>
        ) : (
          <p className="text-muted text-sm font-semibold" data-testid="timeline-entry-time">
            {timelineDayName(entry.dayOffset)}
          </p>
        )}
        <p className="text-muted text-sm" data-testid="timeline-entry-duration">
          {[
            entry.durationMinutes !== null ? formatDuration(entry.durationMinutes) : null,
            entry.startTime === null ? row.timeTbd : null,
            crossesMidnight ? row.nextDayEnd : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-semibold break-words" data-testid="timeline-entry-title">
            {entry.title}
          </h3>
          {entry.phase ? (
            <span className={`${badgeClass} text-muted`} data-testid="timeline-entry-phase">
              {timelinePhaseLabel(entry.phase)}
            </span>
          ) : null}
          {/* Derived at load time: never printed (paper isn't live). */}
          {current ? (
            <span className={`${badgeClass} border-accent text-accent print:hidden`}>{copy.now.currentBadge}</span>
          ) : null}
          {next ? (
            <span className={`${badgeClass} border-accent text-accent print:hidden`}>{copy.now.nextBadge}</span>
          ) : null}
        </div>

        {entry.location || entry.responsibleName || vendor ? (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            {entry.location ? (
              <>
                <dt className="text-muted">{row.location}</dt>
                <dd className="break-words" data-testid="timeline-entry-location">
                  {entry.location}
                </dd>
              </>
            ) : null}
            {vendor ? (
              <>
                <dt className="text-muted">{row.vendor}</dt>
                <dd className="break-words" data-testid="timeline-entry-vendor">
                  <span className="font-semibold">{vendor.name}</span>
                  <span className="text-muted"> · {vendorCategoryDisplay(vendor)}</span>
                  {vendor.status === "discarded" ? (
                    <span className="text-danger font-semibold"> · {row.discardedVendor}</span>
                  ) : null}
                  {vendor.contactName ? <span> · {vendor.contactName}</span> : null}
                  {vendor.phone ? (
                    <>
                      {" · "}
                      {tel ? (
                        <a
                          href={tel}
                          className={`${textLinkClass} tabular-nums`}
                          aria-label={interpolate(row.call, { name: vendor.contactName ?? vendor.name })}
                        >
                          {vendor.phone}
                        </a>
                      ) : (
                        <span className="tabular-nums">{vendor.phone}</span>
                      )}
                    </>
                  ) : null}
                </dd>
              </>
            ) : null}
            {entry.responsibleName ? (
              <>
                <dt className="text-muted">{row.responsible}</dt>
                <dd className="break-words" data-testid="timeline-entry-responsible">
                  {entry.responsibleName}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {entry.notes ? (
          <>
            <details className="text-sm print:hidden">
              <summary className="text-accent cursor-pointer font-semibold">{row.notes}</summary>
              <p className="mt-1 break-words whitespace-pre-line" data-testid="timeline-entry-notes">
                {entry.notes}
              </p>
            </details>
            {/* Printed pages can't open a disclosure: the notes print in full. */}
            <p className="hidden text-sm break-words whitespace-pre-line print:block" data-testid="timeline-entry-notes-print">
              {entry.notes}
            </p>
          </>
        ) : null}

        <div className="flex flex-wrap items-start gap-2 pt-1 print:hidden">
          <details className="group open:w-full">
            <summary
              className={`${disclosureSummaryClass} w-fit`}
              aria-label={interpolate(row.editAria, { title: entry.title })}
            >
              {row.edit}
            </summary>
            <div className="mt-3 space-y-3 rounded-xl border border-border p-4">
              <h4 className="font-semibold">{copy.edit.title}</h4>
              <TimelineEntryForm
                action={updateTimelineEntryAction}
                weddingId={weddingId}
                entryId={entry.id}
                id={`edit-${entry.id}`}
                defaults={timelineFormValues({
                  title: entry.title,
                  dayOffset: entry.dayOffset,
                  startTime: entry.startTime,
                  durationMinutes: entry.durationMinutes,
                  phase: entry.phase,
                  location: entry.location,
                  responsibleName: entry.responsibleName,
                  weddingVendorId: entry.vendor?.id ?? null,
                  notes: entry.notes,
                })}
                vendors={vendors}
                submitLabel={copy.edit.submit}
                pendingLabel={copy.edit.submitting}
              />
            </div>
          </details>
          <ConfirmButton
            action={deleteTimelineEntryAction}
            hidden={{ weddingId, entryId: entry.id }}
            id={`delete-${entry.id}`}
            openLabel={copy.delete.open}
            openAriaLabel={interpolate(copy.delete.openAria, { title: entry.title })}
            confirmTitle={interpolate(copy.delete.confirmTitle, { title: entry.title })}
            confirmBody={[copy.delete.confirmBody]}
            confirmLabel={copy.delete.confirm}
            cancelLabel={copy.delete.cancel}
          />
        </div>
      </div>
    </li>
  );
}

/** "Floristería Las Gardenias · Flores y decoración" — no contact data, no money. */
function vendorChoice(vendor: TimelineVendorOption): VendorChoice {
  const parts = [vendor.name, vendorCategoryDisplay(vendor)];
  if (vendor.status === "discarded") parts.push(getMessages().vendors.statuses.discarded);
  return { id: vendor.id, label: parts.join(" · ") };
}

function CreateEntry({ weddingId, vendors }: { weddingId: string; vendors: readonly VendorChoice[] }) {
  return (
    <details className="group print:hidden">
      <summary className={`${primaryButtonClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        {copy.create.open}
      </summary>
      <section aria-labelledby="new-timeline-entry-heading" className={`${cardClass} mt-4 space-y-4`}>
        <h2 id="new-timeline-entry-heading" className="text-xl font-semibold">
          {copy.create.title}
        </h2>
        <TimelineEntryForm
          action={createTimelineEntryAction}
          weddingId={weddingId}
          id="new-timeline-entry"
          defaults={EMPTY_TIMELINE_FORM}
          vendors={vendors}
          submitLabel={copy.create.submit}
          pendingLabel={copy.create.submitting}
        />
      </section>
    </details>
  );
}
