/**
 * What the guest sees about the confirmation email after saving (LB-12).
 * Pure, so the mapping is unit-tested.
 *
 * The RSVP result always comes first ("Guardamos tu respuesta"); this is
 * only a secondary note. It never names the address, the provider or any
 * internal problem:
 * - sent / sent_but_unrecorded → "También enviamos un correo…" (the provider
 *   accepted it; a missing status record is the organizers' concern);
 * - provider_failed / not_sent → a soft "no pudimos enviar el correo";
 * - skipped_no_email / skipped_undeliverable / not_configured → nothing (no
 *   email was expected, or it was deliberately not sent).
 *
 * It travels in the redirect as a fixed word (`?saved=1&email=sent`), never
 * data. Anyone can type it; it only changes that one sentence.
 */

/**
 * - `sent`: the provider accepted it and the status was recorded.
 * - `sent_but_unrecorded`: the provider accepted it (it may well arrive) but
 *   the status couldn't be recorded. Never "not sent"; never resent.
 * - `skipped_no_email`: the party has no contact email; nothing to send.
 * - `skipped_undeliverable`: LB-18.3 — the party's current address already
 *   bounced, was suppressed or complained in this wedding; deliberately not
 *   sent. The guest sees no note (the RSVP is what matters).
 * - `not_configured`: email isn't configured; nothing was attempted.
 * - `provider_failed`: the provider refused or failed; nothing recorded.
 * - `not_sent`: the email couldn't even be prepared (the private context
 *   couldn't be read, or the link stopped being usable in between).
 */
export type ConfirmationOutcome =
  | "sent"
  | "sent_but_unrecorded"
  | "skipped_no_email"
  | "skipped_undeliverable"
  | "not_configured"
  | "provider_failed"
  | "not_sent";

export type ConfirmationNotice = "sent" | "failed";

export function confirmationNoticeOf(outcome: ConfirmationOutcome): ConfirmationNotice | null {
  switch (outcome) {
    case "sent":
    case "sent_but_unrecorded":
      return "sent";
    case "provider_failed":
    case "not_sent":
      return "failed";
    case "skipped_no_email":
    case "skipped_undeliverable":
    case "not_configured":
      return null;
  }
}

/** Reads the `email` search param back; anything unexpected is no note. */
export function parseConfirmationNotice(value: string | string[] | undefined): ConfirmationNotice | null {
  return value === "sent" || value === "failed" ? value : null;
}
