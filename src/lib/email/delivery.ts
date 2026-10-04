import "server-only";

import { getEmailConfig } from "@/lib/email/config";
import { getDeliveryRecorder, type DeliveryRecorder } from "@/lib/email/delivery-recorder";
import { createOutboxSender } from "@/lib/email/outbox";
import type { EmailSender } from "@/lib/email/provider";
import { createResendSender } from "@/lib/email/resend";

/**
 * What a Server Action hands to the email-sending services: a sender, the
 * trusted origin for absolute links, and the recorder of successful sends
 * (ADR-004). `null` = email isn't fully configured — including a missing
 * recorder, so nothing is ever sent that couldn't be recorded — which the
 * services report as `configuration_error` before touching anything.
 *
 * Services take this as a parameter (never read env themselves), so tests
 * inject a fake sender (and recorder) and never reach a real provider.
 */
export type EmailDelivery = Readonly<{
  sender: EmailSender;
  /** Trusted origin from configuration (`APP_ORIGIN`), never a request header. */
  appOrigin: string;
  /** Records provider-accepted sends; the only privileged step, used last. */
  recorder: DeliveryRecorder;
}>;

export function getEmailDelivery(): EmailDelivery | null {
  const result = getEmailConfig();
  if (!result.ok) return null;
  const recorder = getDeliveryRecorder();
  if (!recorder) return null;
  const { appOrigin, from, transport } = result.config;
  const sender =
    transport.kind === "resend"
      ? createResendSender({ apiKey: transport.apiKey, from })
      : createOutboxSender(transport.dir);
  return { sender, appOrigin, recorder };
}
