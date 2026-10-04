import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EmailSender } from "@/lib/email/provider";

/**
 * Local "outbox" transport for E2E journeys and local development: instead
 * of sending, each message is written as one JSON file in a local directory
 * the test reads. No network, no provider account, no public endpoint.
 *
 * Only reachable through `EMAIL_TRANSPORT=outbox`, which the configuration
 * refuses unless the app's origin is localhost (see `@/lib/email/config`).
 * The files contain the full message, RSVP link included: the directory is
 * test tooling (git-ignored) and must never be a shared or deployed path.
 *
 * Deterministic failure for tests: any recipient at
 * `OUTBOX_REJECTING_DOMAIN` is refused as a provider failure, and nothing is
 * written.
 */

export const OUTBOX_REJECTING_DOMAIN = "rechazo.example.com";

export type OutboxMessage = Readonly<{
  messageId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

export function createOutboxSender(dir: string): EmailSender {
  return {
    async send(email) {
      if (email.to.endsWith(`@${OUTBOX_REJECTING_DOMAIN}`)) {
        return { ok: false, reason: "provider_failure" };
      }
      const messageId = `outbox-${randomUUID()}`;
      const message: OutboxMessage = { messageId, ...email };
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${Date.now()}-${messageId}.json`), JSON.stringify(message), {
          encoding: "utf8",
          flag: "wx",
        });
        return { ok: true, messageId };
      } catch {
        return { ok: false, reason: "provider_failure" };
      }
    },
  };
}
