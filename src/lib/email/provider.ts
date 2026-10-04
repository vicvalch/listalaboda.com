/**
 * The narrow boundary between the app and whatever delivers email. Callers
 * hand over a fully rendered message and get back a normalized result; no
 * provider SDK types, raw errors or response bodies cross this line.
 *
 * Sending is at-least-once from the user's point of view: a click is one
 * provider call, there are no automatic retries, and nothing here claims
 * exactly-once delivery.
 */

export type OutgoingEmail = Readonly<{
  /** One recipient, already validated (no display name, no CR/LF). */
  to: string;
  /** Single line; built by the template with control characters removed. */
  subject: string;
  text: string;
  html: string;
}>;

/**
 * Normalized failure categories (LB-11):
 * - `configuration`: the provider refused our setup (key, sender domain).
 * - `invalid_recipient`: the provider rejected the address.
 * - `provider_failure`: the provider is down, rate-limited or errored.
 * - `unknown`: anything else.
 *
 * A provider that accepted the message but returned no storable id is still
 * a success (`messageId: null`): the email may well be on its way, so it
 * must never be reported as "not sent" (that would invite a duplicate).
 */
export type EmailFailure = "configuration" | "invalid_recipient" | "provider_failure" | "unknown";

export type EmailSendResult =
  | Readonly<{ ok: true; messageId: string | null }>
  | Readonly<{ ok: false; reason: EmailFailure }>;

export interface EmailSender {
  send(email: OutgoingEmail): Promise<EmailSendResult>;
}

/** What we store from a provider's answer: an opaque, bounded id, nothing else. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function isStorableMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}
