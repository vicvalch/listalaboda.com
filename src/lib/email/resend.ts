import "server-only";

import { Resend } from "resend";

import {
  isStorableMessageId,
  type EmailFailure,
  type EmailSendResult,
  type EmailSender,
} from "@/lib/email/provider";

/**
 * Resend adapter (ADR-002 §1: Resend for email). Tiny on purpose: one SDK
 * call, its answer normalized to `EmailSendResult`. The SDK's types, error
 * messages and response bodies stay inside this file; nothing is logged.
 *
 * Sends both a plain-text and an HTML part. The recipient goes in the
 * structured `to` field of a JSON API call (no raw headers are built here);
 * the subject arrives single-line from the template.
 *
 * LB-17 (ADR-010 §4, §12), both opt-in per call:
 * - `timeoutMs`: only when the caller supplies it is a deadline installed
 *   (an abort signal plus a timer); a timeout proves nothing about whether
 *   Resend received the request. Without it the call is made exactly as
 *   before LB-17 (no deadline, no request options).
 * - `idempotencyKey`: passed through unchanged; Resend returns the original
 *   result for the same key and payload and refuses the same key with a
 *   different payload (`invalid_idempotent_request`).
 */

/** Resend error names (`ErrorResponse.name`) → our categories. */
export function mapResendError(name: string | undefined): EmailFailure {
  switch (name) {
    case "missing_api_key":
    case "invalid_api_key":
    case "restricted_api_key":
    case "invalid_from_address":
    case "invalid_access":
    case "invalid_region":
    case "security_error":
      return "configuration";
    case "validation_error":
    case "invalid_parameter":
    case "missing_required_field":
      return "invalid_recipient";
    case "rate_limit_exceeded":
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
    case "application_error":
    case "internal_server_error":
      return "provider_failure";
    case "invalid_idempotent_request":
      return "idempotency_conflict";
    case "concurrent_idempotent_requests":
      return "idempotency_in_progress";
    default:
      return "unknown";
  }
}

type ResendSettings = Readonly<{ apiKey: string; from: string }>;

const TIMED_OUT = Symbol("timed out");

/** Builds the sender. Only called with a validated configuration; never in tests. */
export function createResendSender({ apiKey, from }: ResendSettings): EmailSender {
  const resend = new Resend(apiKey);
  return {
    async send(email, options) {
      const payload = {
        from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      };
      const timeoutMs = options?.timeoutMs;
      const controller = timeoutMs !== undefined ? new AbortController() : null;
      const requestOptions = {
        ...(controller ? { signal: controller.signal } : {}),
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request =
          Object.keys(requestOptions).length > 0
            ? resend.emails.send(payload, requestOptions)
            : resend.emails.send(payload);
        const answer = controller
          ? await Promise.race([
              request,
              new Promise<typeof TIMED_OUT>((resolve) => {
                timer = setTimeout(() => {
                  controller.abort();
                  resolve(TIMED_OUT);
                }, timeoutMs);
              }),
            ])
          : await request;
        if (answer === TIMED_OUT) return { ok: false, reason: "timeout" } satisfies EmailSendResult;
        const { data, error } = answer;
        if (error) return { ok: false, reason: mapResendError(error.name) };
        // Accepted: an unusable id doesn't make it "not sent".
        const id: unknown = data?.id;
        return { ok: true, messageId: isStorableMessageId(id) ? id : null };
      } catch {
        // Network failure, an abort or an SDK exception: retryable from the user's side.
        return controller?.signal.aborted ? { ok: false, reason: "timeout" } : { ok: false, reason: "provider_failure" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
