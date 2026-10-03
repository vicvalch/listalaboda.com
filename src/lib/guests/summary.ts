/**
 * Guest list counts, derived in memory from the loaded parties — never
 * stored. A guest without an RSVP row is "Sin responder" (pending).
 *
 * Invariants: responded = attending + notAttending; pending = total - responded.
 */

export type GuestResponse = Readonly<{ attending: boolean }> | null;

export type GuestSummary = Readonly<{
  parties: number;
  total: number;
  responded: number;
  attending: number;
  notAttending: number;
  pending: number;
}>;

export function summarizeGuests(
  parties: readonly Readonly<{ guests: readonly Readonly<{ rsvp: GuestResponse }>[] }>[],
): GuestSummary {
  let total = 0;
  let attending = 0;
  let notAttending = 0;
  for (const party of parties) {
    for (const guest of party.guests) {
      total += 1;
      if (guest.rsvp?.attending === true) attending += 1;
      else if (guest.rsvp?.attending === false) notAttending += 1;
    }
  }
  const responded = attending + notAttending;
  return {
    parties: parties.length,
    total,
    responded,
    attending,
    notAttending,
    pending: total - responded,
  };
}

export type GuestResponseStatus = "attending" | "not_attending" | "pending";

export function guestResponseStatus(rsvp: GuestResponse): GuestResponseStatus {
  if (!rsvp) return "pending";
  return rsvp.attending ? "attending" : "not_attending";
}
