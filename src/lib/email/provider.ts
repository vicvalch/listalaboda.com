/**
 * The narrow boundary between the app and whatever delivers email. Callers
 * hand over a fully rendered message and get back a normalized result; no
 * provider SDK types, raw errors or response bodies cross this line.
 *
 * Sending is at-least-once from the user's point of view: a click is one
 * provider call with no automatic retries, and nothing here claims
 * exactly-once delivery. The automatic reminder scheduler (LB-17) replays
 * only under one stable idempotency key per occurrence, so the provider
 * itself suppresses duplicates of an unchanged payload.
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
 * Normalized failure categories (LB-11; LB-17 adds the last three):
 * - `configuration`: the provider refused our setup (key, sender domain).
 * - `invalid_recipient`: the provider rejected the address.
 * - `provider_failure`: the provider is down, rate-limited or errored.
 * - `unknown`: anything else.
 * - `timeout`: no answer within the caller's explicit `timeoutMs`. Proves nothing about
 *   whether the provider received the request.
 * - `idempotency_conflict`: the idempotency key was already used with a
 *   DIFFERENT payload; the provider refused to send (ADR-010 §12).
 * - `idempotency_in_progress`: a concurrent request with the same key is
 *   still in flight; retryable.
 *
 * A provider that accepted the message but returned no storable id is still
 * a success (`messageId: null`): the email may well be on its way, so it
 * must never be reported as "not sent" (that would invite a duplicate).
 */
export type EmailFailure =
  | "configuration"
  | "invalid_recipient"
  | "provider_failure"
  | "unknown"
  | "timeout"
  | "idempotency_conflict"
  | "idempotency_in_progress";

export type EmailSendResult =
  | Readonly<{ ok: true; messageId: string | null }>
  | Readonly<{ ok: false; reason: EmailFailure }>;

/**
 * Optional per-call options (LB-17, ADR-010 §4, §12). Both are opt-in at the
 * call site; manual flows (invitation, RSVP confirmation, manual reminder)
 * pass none, so their behavior is unchanged.
 * - `idempotencyKey`: the same key for every attempt of one logical send. The
 *   provider returns the original result for the same key and payload, and
 *   refuses the same key with a different payload.
 * - `timeoutMs`: give up after this many milliseconds (`timeout`, which
 *   proves nothing about delivery). Absent = no deadline is installed.
 */
export type EmailSendOptions = Readonly<{ idempotencyKey?: string; timeoutMs?: number }>;

export interface EmailSender {
  send(email: OutgoingEmail, options?: EmailSendOptions): Promise<EmailSendResult>;
}

/** What we store from a provider's answer: an opaque, bounded id, nothing else. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function isStorableMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}
