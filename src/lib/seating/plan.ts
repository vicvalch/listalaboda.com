/**
 * The seating page model (LB-19, ADR-012), derived in memory from the loaded
 * tables and guest list — never stored. Pure: no I/O, no clock.
 *
 * Rules (they match the database exactly):
 *   * RSVP state per guest: no RSVP row = "pending"; attending true/false =
 *     "attending"/"declined". A party answers every guest at once, but this
 *     model doesn't rely on it.
 *   * "Seated" = the guest has an assignment row, whatever their RSVP. EVERY
 *     assignment row takes a seat: freeCapacity = capacity − assignedCount,
 *     never derived from confirmed answers.
 *   * A seated guest who declined stays on their table and is a conflict for
 *     the organizers to resolve by hand; nobody is unseated automatically.
 *   * Unseated guests: attending and pending ones can be seated (grouped by
 *     party); declined ones are informational only.
 *
 * Order is stable: tables in the given (persisted) order; guests in the given
 * party order, then their order within the party.
 */

export type SeatingRsvpState = "attending" | "pending" | "declined";

export type SeatingTableInput = Readonly<{ id: string; name: string; capacity: number }>;

export type SeatingGuestInput = Readonly<{
  id: string;
  name: string;
  /** null = no RSVP yet ("Sin responder"). */
  attending: boolean | null;
  /** The guest's table, or null when unassigned. */
  tableId: string | null;
}>;

export type SeatingPartyInput = Readonly<{
  id: string;
  label: string;
  guests: readonly SeatingGuestInput[];
}>;

export type SeatingGuest = Readonly<{
  id: string;
  name: string;
  partyId: string;
  partyLabel: string;
  rsvpState: SeatingRsvpState;
  tableId: string | null;
}>;

export type SeatingTablePlan = Readonly<{
  id: string;
  name: string;
  capacity: number;
  guests: readonly SeatingGuest[];
  assignedCount: number;
  /** capacity − assignedCount, never below 0. */
  freeCapacity: number;
  isFull: boolean;
}>;

export type SeatingPartyGroup = Readonly<{
  partyId: string;
  partyLabel: string;
  guests: readonly SeatingGuest[];
}>;

export type SeatingSummary = Readonly<{
  /** Guests whose RSVP is "attending". */
  confirmed: number;
  /** All assignment rows (any RSVP state). */
  seated: number;
  /** Attending guests without a table. */
  confirmedUnseated: number;
  /** Sum of all table capacities. */
  totalCapacity: number;
  /** Seated guests whose RSVP is "declined" (conflicts). */
  seatedDeclined: number;
}>;

export type SeatingPlan = Readonly<{
  tables: readonly SeatingTablePlan[];
  unassigned: Readonly<{
    attending: readonly SeatingPartyGroup[];
    pending: readonly SeatingPartyGroup[];
  }>;
  /** Unseated guests who declined: informational, never assignable. */
  declined: readonly SeatingPartyGroup[];
  /** Seated guests who declined, in table order. */
  conflicts: readonly SeatingGuest[];
  summary: SeatingSummary;
}>;

export function seatingRsvpState(attending: boolean | null): SeatingRsvpState {
  if (attending === null) return "pending";
  return attending ? "attending" : "declined";
}

/** Whether a guest in this state may be newly seated or moved (mirrors the database rule). */
export function isSeatable(state: SeatingRsvpState): boolean {
  return state !== "declined";
}

function groupByParty(guests: readonly SeatingGuest[]): SeatingPartyGroup[] {
  const groups: SeatingPartyGroup[] = [];
  const byParty = new Map<string, SeatingGuest[]>();
  for (const guest of guests) {
    let members = byParty.get(guest.partyId);
    if (!members) {
      members = [];
      byParty.set(guest.partyId, members);
      groups.push({ partyId: guest.partyId, partyLabel: guest.partyLabel, guests: members });
    }
    members.push(guest);
  }
  return groups;
}

export function buildSeatingPlan(
  tables: readonly SeatingTableInput[],
  parties: readonly SeatingPartyInput[],
): SeatingPlan {
  const seatedByTable = new Map<string, SeatingGuest[]>(tables.map((table) => [table.id, []]));
  const unseated: SeatingGuest[] = [];
  let confirmed = 0;

  for (const party of parties) {
    for (const input of party.guests) {
      const rsvpState = seatingRsvpState(input.attending);
      if (rsvpState === "attending") confirmed += 1;
      // An assignment to a table that isn't loaded can't be shown on a card;
      // the same-wedding FK makes it impossible, so it reads as unassigned.
      const tableGuests = input.tableId ? seatedByTable.get(input.tableId) : undefined;
      const guest: SeatingGuest = {
        id: input.id,
        name: input.name,
        partyId: party.id,
        partyLabel: party.label,
        rsvpState,
        tableId: tableGuests ? input.tableId : null,
      };
      if (tableGuests) tableGuests.push(guest);
      else unseated.push(guest);
    }
  }

  const tablePlans = tables.map((table): SeatingTablePlan => {
    const guests = seatedByTable.get(table.id) ?? [];
    return {
      id: table.id,
      name: table.name,
      capacity: table.capacity,
      guests,
      assignedCount: guests.length,
      freeCapacity: Math.max(0, table.capacity - guests.length),
      isFull: guests.length >= table.capacity,
    };
  });

  const conflicts = tablePlans.flatMap((table) => table.guests.filter((g) => g.rsvpState === "declined"));
  const unseatedAttending = unseated.filter((g) => g.rsvpState === "attending");

  return {
    tables: tablePlans,
    unassigned: {
      attending: groupByParty(unseatedAttending),
      pending: groupByParty(unseated.filter((g) => g.rsvpState === "pending")),
    },
    declined: groupByParty(unseated.filter((g) => g.rsvpState === "declined")),
    conflicts,
    summary: {
      confirmed,
      seated: tablePlans.reduce((sum, table) => sum + table.assignedCount, 0),
      confirmedUnseated: unseatedAttending.length,
      totalCapacity: tables.reduce((sum, table) => sum + table.capacity, 0),
      seatedDeclined: conflicts.length,
    },
  };
}
