import "server-only";

import { getEmailConfig } from "@/lib/email/config";
import { createOutboxSender } from "@/lib/email/outbox";
import { createResendSender } from "@/lib/email/resend";
import type { RunnerDeps } from "@/lib/scheduler/rsvp-reminder-runner";
import { getRsvpReminderStore } from "@/lib/scheduler/rsvp-reminder-store";
import { getRsvpCapabilityEncryptionSettings } from "@/lib/security/rsvp-capability-encryption";

/**
 * Everything one scheduler run needs from the server environment (LB-17,
 * ADR-010 §22), or null when ANY of it is missing or invalid: the scheduler
 * store (Supabase URL + service-role key), the email configuration
 * (`APP_ORIGIN`, `EMAIL_FROM`, provider), and the RSVP link key. A null
 * runtime means no claim, no database write and no email.
 *
 * `CRON_SECRET` is not read here: only `@/lib/scheduler/cron-auth` reads it,
 * and the route checks it before calling this.
 */
export function getAutomaticReminderRuntime(): RunnerDeps | null {
  const email = getEmailConfig();
  if (!email.ok) return null;
  const encryption = getRsvpCapabilityEncryptionSettings();
  if (!encryption.ok) return null;
  const store = getRsvpReminderStore();
  if (!store) return null;
  const { appOrigin, from, transport } = email.config;
  const sender =
    transport.kind === "resend"
      ? createResendSender({ apiKey: transport.apiKey, from })
      : createOutboxSender(transport.dir);
  return { store, sender, appOrigin, encryption: encryption.settings };
}
