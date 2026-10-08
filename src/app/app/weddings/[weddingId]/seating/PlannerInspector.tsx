"use client";

import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import type { SeatingGuest, SeatingPlan, SeatingTablePlan } from "@/lib/seating/plan";

import { ConfirmButton } from "../guests/ConfirmButton";
import { deleteTableAction, moveGuestAction, seatGuestAction, unseatGuestAction, updateTableAction } from "./actions";
import { AssignmentForm } from "./AssignmentForm";
import { seatingTableOptions } from "./table-options";
import { TableForm } from "./TableForm";

export type PlannerSelection = Readonly<{ kind: "table" | "guest"; id: string }> | null;

const copy = getMessages().seating;
const inspector = copy.planner.inspector;

function findGuest(plan: SeatingPlan, id: string): SeatingGuest | null {
  for (const table of plan.tables) {
    const guest = table.guests.find((g) => g.id === id);
    if (guest) return guest;
  }
  for (const groups of [plan.unassigned.attending, plan.unassigned.pending, plan.declined]) {
    for (const group of groups) {
      const guest = group.guests.find((g) => g.id === id);
      if (guest) return guest;
    }
  }
  return null;
}

/**
 * The planner's right-hand panel (LB-20): the non-drag path for everything.
 * It reuses the LB-19 forms and Server Actions unchanged — table name,
 * capacity and shape, delete, and seat / move / unseat for a guest — so the
 * planner never has a second editing domain.
 */
export function PlannerInspector({
  weddingId,
  plan,
  selection,
  onClose,
}: {
  weddingId: string;
  plan: SeatingPlan;
  selection: PlannerSelection;
  onClose: () => void;
}) {
  const table = selection?.kind === "table" ? (plan.tables.find((t) => t.id === selection.id) ?? null) : null;
  const guest = selection?.kind === "guest" ? findGuest(plan, selection.id) : null;

  return (
    <aside
      aria-labelledby="planner-inspector-title"
      data-testid="planner-inspector"
      className="space-y-4 rounded-2xl border border-border bg-surface p-4 xl:sticky xl:top-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="planner-inspector-title" className="text-lg font-semibold">
          {inspector.title}
        </h2>
        {table || guest ? (
          <button type="button" onClick={onClose} className="text-muted text-sm underline-offset-4 hover:underline">
            {inspector.close}
          </button>
        ) : null}
      </div>
      {table ? (
        <TableDetails weddingId={weddingId} table={table} />
      ) : guest ? (
        <GuestDetails weddingId={weddingId} guest={guest} tables={plan.tables} />
      ) : (
        <p className="text-muted text-sm">{inspector.empty}</p>
      )}
    </aside>
  );
}

function TableDetails({ weddingId, table }: { weddingId: string; table: SeatingTablePlan }) {
  const occupancy = { assigned: formatNumber(table.assignedCount), capacity: formatNumber(table.capacity) };
  return (
    <section aria-label={inspector.tableHeading} data-testid="planner-inspector-table" className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold break-words">{table.name}</h3>
        <p className="text-sm">{interpolate(inspector.occupancy, occupancy)}</p>
        <p className="text-muted text-sm">{interpolate(inspector.shape, { shape: copy.shapes[table.shape] })}</p>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">{inspector.people}</h4>
        {table.guests.length === 0 ? (
          <p className="text-muted text-sm">{inspector.noGuests}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {table.guests.map((guest) => (
              <li key={guest.id} className="flex flex-wrap items-center gap-x-2">
                <span className="break-words">{guest.name}</span>
                {guest.rsvpState !== "attending" ? (
                  <span
                    className={`rounded-full px-2 text-xs font-semibold ${
                      guest.rsvpState === "declined" ? "bg-danger-soft text-danger" : "bg-accent-soft"
                    }`}
                  >
                    {guest.rsvpState === "declined" ? copy.status.declined : copy.status.pending}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Remount per table (and after each save) so the fields show the current values. */}
      <TableForm
        key={`${table.id}:${table.name}:${table.capacity}:${table.shape}`}
        action={updateTableAction}
        weddingId={weddingId}
        tableId={table.id}
        id={`inspector-edit-${table.id}`}
        defaultName={table.name}
        defaultCapacity={table.capacity}
        defaultShape={table.shape}
        submitLabel={copy.editTable.submit}
        pendingLabel={copy.editTable.submitting}
        compact
      />
      <ConfirmButton
        key={`delete-${table.id}`}
        action={deleteTableAction}
        hidden={{ weddingId, tableId: table.id }}
        id={`inspector-delete-${table.id}`}
        openLabel={copy.deleteTable.open}
        openAriaLabel={interpolate(copy.deleteTable.openAria, { table: table.name })}
        confirmTitle={interpolate(copy.deleteTable.confirmTitle, { table: table.name })}
        confirmBody={[copy.deleteTable.confirmBody]}
        confirmLabel={copy.deleteTable.confirm}
        cancelLabel={copy.deleteTable.cancel}
      />
    </section>
  );
}

function GuestDetails({
  weddingId,
  guest,
  tables,
}: {
  weddingId: string;
  guest: SeatingGuest;
  tables: readonly SeatingTablePlan[];
}) {
  const current = guest.tableId ? (tables.find((t) => t.id === guest.tableId) ?? null) : null;
  const declined = guest.rsvpState === "declined";
  return (
    <section aria-label={inspector.guestHeading} data-testid="planner-inspector-guest" className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold break-words">{guest.name}</h3>
        <p className="text-muted text-sm break-words">{interpolate(copy.party, { party: guest.partyLabel })}</p>
        {guest.rsvpState !== "attending" ? (
          <p className={`text-sm font-medium ${declined ? "text-danger" : ""}`}>
            {declined ? copy.status.declined : copy.status.pending}
          </p>
        ) : null}
        <p className="text-sm">
          {current ? interpolate(inspector.currentTable, { table: current.name }) : inspector.noTable}
        </p>
        {declined ? (
          <p className="text-danger text-sm">{current ? inspector.declinedSeated : inspector.declinedNoSeat}</p>
        ) : null}
      </div>

      {/* The same forms as the list: the database decides every one of them. */}
      {!current && !declined && tables.length > 0 ? (
        <AssignmentForm
          key={`seat-${guest.id}`}
          action={seatGuestAction}
          weddingId={weddingId}
          guestId={guest.id}
          id={`inspector-seat-${guest.id}`}
          select={{
            label: interpolate(copy.seat.selectLabel, { guest: guest.name }),
            placeholder: copy.seat.choose,
            options: seatingTableOptions(tables, null),
          }}
          submitLabel={copy.seat.submit}
          submitAriaLabel={interpolate(copy.seat.submitAria, { guest: guest.name })}
        />
      ) : null}
      {current && !declined && tables.length > 1 ? (
        <AssignmentForm
          key={`move-${guest.id}-${current.id}`}
          action={moveGuestAction}
          weddingId={weddingId}
          guestId={guest.id}
          id={`inspector-move-${guest.id}`}
          select={{
            label: interpolate(copy.move.selectLabel, { guest: guest.name }),
            placeholder: copy.seat.choose,
            options: seatingTableOptions(tables, current.id),
          }}
          submitLabel={copy.move.submit}
          submitAriaLabel={interpolate(copy.move.submitAria, { guest: guest.name })}
        />
      ) : null}
      {current ? (
        <AssignmentForm
          key={`unseat-${guest.id}-${current.id}`}
          action={unseatGuestAction}
          weddingId={weddingId}
          guestId={guest.id}
          id={`inspector-unseat-${guest.id}`}
          submitLabel={copy.unseat.submit}
          submitAriaLabel={interpolate(copy.unseat.submitAria, { guest: guest.name })}
        />
      ) : null}
      {!current && !declined && tables.length === 0 ? (
        <p className="text-muted text-sm">{copy.unassigned.noTables}</p>
      ) : null}
    </section>
  );
}
