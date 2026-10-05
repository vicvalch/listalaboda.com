import { toSingleLine } from "@/lib/email/invitation";
import { es } from "@/lib/i18n/messages/es";
import { interpolate } from "@/lib/i18n";
import { formatWeddingDate } from "@/lib/weddings/format";

/**
 * The WhatsApp-ready RSVP reminder text (LB-14, ADR-007 §6): plain text the
 * organizer copies and sends THEMSELVES. Pure — no database, React, env,
 * key or network. The app never sends it, never stores it and never records
 * it as delivered.
 *
 * Concise on purpose: a greeting to the party, one reminder line with the
 * wedding's name (and date, if set) and the party's CURRENT RSVP link,
 * which the server recovered and built from the trusted origin. Never the
 * party's answers, food notes, contact email, members or ids.
 *
 * People-supplied values are collapsed onto one line each, so a label can't
 * inject extra lines into the message.
 */

export type RsvpReminderMessageInput = Readonly<{
  partyLabel: string;
  weddingName: string;
  /** Postgres date (`YYYY-MM-DD`) or null. */
  weddingDate: string | null;
  /** The party's CURRENT absolute RSVP link. */
  rsvpUrl: string;
}>;

export function renderRsvpReminderMessage(input: RsvpReminderMessageInput): string {
  const copy = es.rsvpReminderMessage;
  const values = {
    party: toSingleLine(input.partyLabel),
    wedding: toSingleLine(input.weddingName),
    ...(input.weddingDate ? { date: formatWeddingDate(input.weddingDate) } : {}),
  };
  return [
    interpolate(copy.greeting, values),
    "",
    interpolate(input.weddingDate ? copy.introWithDate : copy.intro, values),
    "",
    copy.linkIntro,
    input.rsvpUrl,
    "",
    copy.thanks,
  ].join("\n");
}
