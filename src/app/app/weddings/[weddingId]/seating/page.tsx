import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import {
  buildSeatingPlan,
  type SeatingGuest,
  type SeatingPartyGroup,
  type SeatingPlan,
  type SeatingTablePlan,
} from "@/lib/seating/plan";
import { getSeatingData } from "@/lib/seating/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ConfirmButton } from "../guests/ConfirmButton";
import {
  createTableAction,
  deleteTableAction,
  moveGuestAction,
  seatGuestAction,
  unseatGuestAction,
  updateTableAction,
} from "./actions";
import { AssignmentForm, type TableOption } from "./AssignmentForm";
import { TableForm } from "./TableForm";

export const metadata: Metadata = { title: getMessages().seating.title };

const copy = getMessages().seating;

/**
 * "Mesas" (LB-19, ADR-012): the wedding's tables and who sits where — a
 * secondary area next to the checklist (which stays the wedding's home) and
 * the guest list. Any member, owner or collaborator, sees and manages it;
 * membership is checked server-side first, and a non-member, a nonexistent
 * wedding and a malformed id all get the same 404. The data is loaded after
 * that check in two batched queries; occupancy, groups and conflicts are
 * derived in memory (`@/lib/seating/plan`). Plain forms and Server Actions:
 * no drag and drop, no floor plan.
 */
export default async function SeatingPage({ params }: PageProps<"/app/weddings/[weddingId]/seating">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/seating`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [wedding, data] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    getSeatingData(supabase, access.access),
  ]);
  if (!wedding) notFound();

  const plan = data ? buildSeatingPlan(data.tables, data.parties) : null;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href={`/app/weddings/${wedding.id}`} className={textLinkClass}>
            {copy.backToChecklist}
          </Link>
          <Link href={`/app/weddings/${wedding.id}/guests`} className={textLinkClass}>
            {copy.backToGuests}
          </Link>
        </p>
      </header>

      {plan ? (
        <>
          <SummarySection plan={plan} />

          <section aria-labelledby="new-table-title" className={`${cardClass} space-y-4`}>
            <h2 id="new-table-title" className="text-xl font-semibold">
              {copy.newTable.title}
            </h2>
            <TableForm
              action={createTableAction}
              weddingId={wedding.id}
              id="new-table"
              submitLabel={copy.newTable.submit}
              pendingLabel={copy.newTable.submitting}
            />
          </section>

          <TablesSection weddingId={wedding.id} plan={plan} />
          <UnassignedSection weddingId={wedding.id} plan={plan} />
        </>
      ) : (
        <Notice tone="error">{copy.loadFailed}</Notice>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ summary

function SummarySection({ plan }: { plan: SeatingPlan }) {
  const { summary } = plan;
  const stats = [
    { key: "confirmed", label: copy.summary.confirmed, value: summary.confirmed },
    { key: "seated", label: copy.summary.seated, value: summary.seated },
    { key: "unseated", label: copy.summary.unseated, value: summary.confirmedUnseated },
    { key: "capacity", label: copy.summary.capacity, value: summary.totalCapacity },
  ] as const;

  return (
    <section aria-label={copy.summary.label} className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.key}
            data-testid={`seating-summary-${stat.key}`}
            className="rounded-xl border border-border bg-surface px-4 py-3"
          >
            <dt className="text-muted text-sm">{stat.label}</dt>
            <dd className="text-2xl font-semibold">{formatNumber(stat.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted text-sm">{copy.summary.unseatedHint}</p>
      {summary.seatedDeclined > 0 ? (
        <div data-testid="seating-declined-warning">
          <Notice tone="error">
            {summary.seatedDeclined === 1
              ? copy.summary.declinedSeatedOne
              : interpolate(copy.summary.declinedSeatedMany, { count: formatNumber(summary.seatedDeclined) })}
          </Notice>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------- tables

function tableOptions(tables: readonly SeatingTablePlan[], excludeId: string | null): TableOption[] {
  return tables
    .filter((table) => table.id !== excludeId)
    .map((table) => ({
      id: table.id,
      label: table.isFull ? interpolate(copy.seat.fullOption, { table: table.name }) : table.name,
      disabled: table.isFull,
    }));
}

function RsvpBadge({ guest }: { guest: SeatingGuest }) {
  if (guest.rsvpState === "attending") return null;
  const declined = guest.rsvpState === "declined";
  return (
    <span
      data-testid="seating-guest-status"
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        declined ? "bg-danger-soft text-danger" : "bg-accent-soft"
      }`}
    >
      {declined ? copy.status.declined : copy.status.pending}
    </span>
  );
}

function GuestIdentity({ guest }: { guest: SeatingGuest }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="flex flex-wrap items-center gap-2">
        <span data-testid="seating-guest-name" className="font-semibold break-words">
          {guest.name}
        </span>
        <RsvpBadge guest={guest} />
      </p>
      <p className="text-muted text-sm break-words">{interpolate(copy.party, { party: guest.partyLabel })}</p>
    </div>
  );
}

function TablesSection({ weddingId, plan }: { weddingId: string; plan: SeatingPlan }) {
  return (
    <section aria-labelledby="tables-title" className="space-y-4">
      <h2 id="tables-title" className="text-2xl font-semibold">
        {copy.tables.title}
      </h2>
      {plan.tables.length === 0 ? <p className="text-muted">{copy.tables.empty}</p> : null}
      <ul className="space-y-4">
        {plan.tables.map((table) => (
          <li key={table.id}>
            <TableCard weddingId={weddingId} table={table} tables={plan.tables} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TableCard({
  weddingId,
  table,
  tables,
}: {
  weddingId: string;
  table: SeatingTablePlan;
  tables: readonly SeatingTablePlan[];
}) {
  const occupancy = { assigned: formatNumber(table.assignedCount), capacity: formatNumber(table.capacity) };
  const headingId = `table-${table.id}-title`;
  return (
    <article
      aria-labelledby={headingId}
      data-testid="seating-table"
      className="space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-lg font-semibold break-words">
          {table.name}
        </h3>
        <p className="flex items-center gap-2">
          <span
            data-testid="seating-table-occupancy"
            aria-label={interpolate(copy.tables.occupancyLabel, occupancy)}
            className="font-semibold"
          >
            {interpolate(copy.tables.occupancy, occupancy)}
          </span>
          {table.isFull ? (
            <span data-testid="seating-table-full" className="bg-accent-soft rounded-full px-2 py-0.5 text-xs font-semibold">
              {copy.tables.full}
            </span>
          ) : null}
        </p>
      </div>

      {table.guests.length === 0 ? (
        <p className="text-muted text-sm">{copy.tables.noGuests}</p>
      ) : (
        <ul className="divide-y divide-border">
          {table.guests.map((guest) => (
            <li
              key={guest.id}
              data-testid="seated-guest"
              className={`space-y-2 py-3 ${guest.rsvpState === "declined" ? "rounded-lg bg-danger-soft px-3" : ""}`}
            >
              <GuestIdentity guest={guest} />
              {guest.rsvpState === "declined" ? (
                <p data-testid="seating-declined-note" className="text-danger text-sm font-medium">
                  {copy.declinedNote}
                </p>
              ) : null}
              <div className="flex flex-wrap items-start gap-3">
                {/* A guest who declined can't be moved (the database refuses): only unseated. */}
                {guest.rsvpState !== "declined" && tables.length > 1 ? (
                  <AssignmentForm
                    action={moveGuestAction}
                    weddingId={weddingId}
                    guestId={guest.id}
                    id={`move-${guest.id}`}
                    select={{
                      label: interpolate(copy.move.selectLabel, { guest: guest.name }),
                      placeholder: copy.seat.choose,
                      options: tableOptions(tables, table.id),
                    }}
                    submitLabel={copy.move.submit}
                    submitAriaLabel={interpolate(copy.move.submitAria, { guest: guest.name })}
                  />
                ) : null}
                <AssignmentForm
                  action={unseatGuestAction}
                  weddingId={weddingId}
                  guestId={guest.id}
                  id={`unseat-${guest.id}`}
                  submitLabel={copy.unseat.submit}
                  submitAriaLabel={interpolate(copy.unseat.submitAria, { guest: guest.name })}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-start gap-3 border-t border-border pt-4">
        <TableForm
          action={updateTableAction}
          weddingId={weddingId}
          tableId={table.id}
          id={`edit-${table.id}`}
          defaultName={table.name}
          defaultCapacity={table.capacity}
          submitLabel={copy.editTable.submit}
          pendingLabel={copy.editTable.submitting}
          disclosure={{
            label: copy.editTable.open,
            ariaLabel: interpolate(copy.editTable.openAria, { table: table.name }),
          }}
        />
        <ConfirmButton
          action={deleteTableAction}
          hidden={{ weddingId, tableId: table.id }}
          id={`delete-${table.id}`}
          openLabel={copy.deleteTable.open}
          openAriaLabel={interpolate(copy.deleteTable.openAria, { table: table.name })}
          confirmTitle={interpolate(copy.deleteTable.confirmTitle, { table: table.name })}
          confirmBody={[copy.deleteTable.confirmBody]}
          confirmLabel={copy.deleteTable.confirm}
          cancelLabel={copy.deleteTable.cancel}
        />
      </div>
    </article>
  );
}

// --------------------------------------------------------------- unassigned

function PartyGroups({
  weddingId,
  groups,
  tables,
  seatable,
}: {
  weddingId: string;
  groups: readonly SeatingPartyGroup[];
  tables: readonly SeatingTablePlan[];
  seatable: boolean;
}) {
  return (
    <ul className="space-y-3">
      {groups.map((group) => (
        <li key={group.partyId} data-testid="seating-party-group" className="rounded-xl border border-border p-3">
          <p className="text-muted mb-2 text-sm font-semibold break-words">{group.partyLabel}</p>
          <ul className="divide-y divide-border">
            {group.guests.map((guest) => (
              <li key={guest.id} data-testid="unseated-guest" className="space-y-2 py-2">
                <GuestIdentity guest={guest} />
                {seatable && tables.length > 0 ? (
                  <AssignmentForm
                    action={seatGuestAction}
                    weddingId={weddingId}
                    guestId={guest.id}
                    id={`seat-${guest.id}`}
                    select={{
                      label: interpolate(copy.seat.selectLabel, { guest: guest.name }),
                      placeholder: copy.seat.choose,
                      options: tableOptions(tables, null),
                    }}
                    submitLabel={copy.seat.submit}
                    submitAriaLabel={interpolate(copy.seat.submitAria, { guest: guest.name })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function UnassignedSection({ weddingId, plan }: { weddingId: string; plan: SeatingPlan }) {
  const { attending, pending } = plan.unassigned;
  const nothingToSeat = attending.length === 0 && pending.length === 0;
  return (
    <section aria-labelledby="unassigned-title" data-testid="seating-unassigned" className={`${cardClass} space-y-6`}>
      <h2 id="unassigned-title" className="text-2xl font-semibold">
        {copy.unassigned.title}
      </h2>
      {nothingToSeat ? <p className="text-muted">{copy.unassigned.empty}</p> : null}
      {!nothingToSeat && plan.tables.length === 0 ? <p className="text-muted">{copy.unassigned.noTables}</p> : null}

      {attending.length > 0 ? (
        <section aria-labelledby="unassigned-attending-title" className="space-y-3">
          <h3 id="unassigned-attending-title" className="text-lg font-semibold">
            {copy.unassigned.attendingTitle}
          </h3>
          <PartyGroups weddingId={weddingId} groups={attending} tables={plan.tables} seatable />
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section aria-labelledby="unassigned-pending-title" className="space-y-3">
          <h3 id="unassigned-pending-title" className="text-lg font-semibold">
            {copy.unassigned.pendingTitle}
          </h3>
          <p className="text-muted text-sm">{copy.unassigned.pendingHint}</p>
          <PartyGroups weddingId={weddingId} groups={pending} tables={plan.tables} seatable />
        </section>
      ) : null}

      {plan.declined.length > 0 ? (
        <details data-testid="seating-declined-group" className="space-y-3">
          <summary className="cursor-pointer text-lg font-semibold">{copy.unassigned.declinedTitle}</summary>
          <p className="text-muted text-sm">{copy.unassigned.declinedHint}</p>
          <PartyGroups weddingId={weddingId} groups={plan.declined} tables={plan.tables} seatable={false} />
        </details>
      ) : null}
    </section>
  );
}
