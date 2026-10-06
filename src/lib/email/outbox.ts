import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 *
 * Idempotency (LB-17, ADR-010 §12), mirroring the provider: a message sent
 * with an idempotency key is written once, under a name derived from the key.
 * The same key with the same payload returns the original message id and
 * writes nothing; the same key with a different payload is refused as
 * `idempotency_conflict`.
 */

export const OUTBOX_REJECTING_DOMAIN = "rechazo.example.com";

export type OutboxMessage = Readonly<{
  messageId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

function samePayload(a: OutboxMessage, b: Omit<OutboxMessage, "messageId">): boolean {
  return a.to === b.to && a.subject === b.subject && a.text === b.text && a.html === b.html;
}

export function createOutboxSender(dir: string): EmailSender {
  return {
    async send(email, options) {
      if (email.to.endsWith(`@${OUTBOX_REJECTING_DOMAIN}`)) {
        return { ok: false, reason: "provider_failure" };
      }
      const messageId = `outbox-${randomUUID()}`;
      const message: OutboxMessage = { messageId, ...email };
      const keyed = options?.idempotencyKey
        ? `idem-${createHash("sha256").update(options.idempotencyKey, "utf8").digest("hex")}.json`
        : null;
      try {
        await mkdir(dir, { recursive: true });
        if (keyed) {
          try {
            await writeFile(join(dir, keyed), JSON.stringify(message), { encoding: "utf8", flag: "wx" });
            return { ok: true, messageId };
          } catch {
            const earlier = JSON.parse(await readFile(join(dir, keyed), "utf8")) as OutboxMessage;
            return samePayload(earlier, email)
              ? { ok: true, messageId: earlier.messageId }
              : { ok: false, reason: "idempotency_conflict" };
          }
        }
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
