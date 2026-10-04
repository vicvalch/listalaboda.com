import "server-only";

import { Resend } from "resend";

import { isStorableMessageId, type EmailFailure, type EmailSender } from "@/lib/email/provider";

/**
 * Resend adapter (ADR-002 §1: Resend for email). Tiny on purpose: one SDK
 * call, its answer normalized to `EmailSendResult`. The SDK's types, error
 * messages and response bodies stay inside this file; nothing is logged.
 *
 * Sends both a plain-text and an HTML part. The recipient goes in the
 * structured `to` field of a JSON API call (no raw headers are built here);
 * the subject arrives single-line from the template.
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
    case "concurrent_idempotent_requests":
      return "provider_failure";
    default:
      return "unknown";
  }
}

type ResendSettings = Readonly<{ apiKey: string; from: string }>;

/** Builds the sender. Only called with a validated configuration; never in tests. */
export function createResendSender({ apiKey, from }: ResendSettings): EmailSender {
  const resend = new Resend(apiKey);
  return {
    async send(email) {
      try {
        const { data, error } = await resend.emails.send({
          from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
        if (error) return { ok: false, reason: mapResendError(error.name) };
        // Accepted: an unusable id doesn't make it "not sent".
        const id: unknown = data?.id;
        return { ok: true, messageId: isStorableMessageId(id) ? id : null };
      } catch {
        // Network failure or an SDK exception: retryable from the user's side.
        return { ok: false, reason: "provider_failure" };
      }
    },
  };
}
