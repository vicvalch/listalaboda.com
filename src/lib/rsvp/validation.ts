import { es } from "@/lib/i18n/messages/es";

/**
 * Parses the guest RSVP form. The form lists every guest of the party (a
 * hidden `guestId` per guest, in order) with a required Sí/No choice
 * (`attending-<guestId>`) and an optional food note (`dietaryNote-<guestId>`).
 *
 * Every guest must be answered explicitly: a missing choice is an error,
 * never "No". Guest ids here are only references; `submit_guest_rsvp`
 * re-checks that they are exactly the token's party. The database stays
 * authoritative for the note (CHECK); this mirrors it for Spanish messages.
 */

export const DIETARY_NOTE_MAX_LENGTH = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters (C0, DEL, C1): plain text only (single-line input).
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type RsvpResponse = Readonly<{
  guestId: string;
  attending: boolean;
  /** Trimmed; null when blank. */
  dietaryNote: string | null;
}>;

/** What the form sent for one guest (echoed back on failure; no secrets). */
export type RsvpFormValue = Readonly<{ attending: "yes" | "no" | ""; dietaryNote: string }>;

export type RsvpFormResult =
  | Readonly<{ ok: true; responses: readonly RsvpResponse[] }>
  | Readonly<{
      ok: false;
      /** Per guest id: the message to show inside that guest's group. */
      fieldErrors: Readonly<Record<string, string>>;
      formError?: string;
      values: Readonly<Record<string, RsvpFormValue>>;
    }>;

export type DietaryNoteResult =
  | Readonly<{ ok: true; dietaryNote: string | null }>
  | Readonly<{ ok: false; error: string }>;

export function parseDietaryNote(raw: string): DietaryNoteResult {
  const v = es.rsvp.validation;
  const value = raw.trim();
  if (!value) return { ok: true, dietaryNote: null };
  if ([...value].length > DIETARY_NOTE_MAX_LENGTH) return { ok: false, error: v.noteTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.noteInvalid };
  return { ok: true, dietaryNote: value };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function parseRsvpForm(formData: FormData): RsvpFormResult {
  const v = es.rsvp.validation;
  const guestIds = formData.getAll("guestId").filter((id): id is string => typeof id === "string");

  const values: Record<string, RsvpFormValue> = {};
  const fieldErrors: Record<string, string> = {};
  const responses: RsvpResponse[] = [];

  const malformed =
    guestIds.length === 0 ||
    new Set(guestIds).size !== guestIds.length ||
    guestIds.some((id) => !UUID_PATTERN.test(id));
  if (malformed) return { ok: false, fieldErrors: {}, formError: v.stale, values };

  for (const guestId of guestIds) {
    const rawAttending = text(formData, `attending-${guestId}`);
    const attending = rawAttending === "yes" || rawAttending === "no" ? rawAttending : "";
    const rawNote = text(formData, `dietaryNote-${guestId}`);
    values[guestId] = { attending, dietaryNote: rawNote };

    const note = parseDietaryNote(rawNote);
    if (!attending) fieldErrors[guestId] = v.choiceRequired;
    else if (!note.ok) fieldErrors[guestId] = note.error;
    else responses.push({ guestId, attending: attending === "yes", dietaryNote: note.dietaryNote });
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, formError: v.fixErrors, values };
  }
  return { ok: true, responses };
}
