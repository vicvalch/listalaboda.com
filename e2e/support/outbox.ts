import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "@playwright/test";

/**
 * The E2E email "outbox": the app under test runs with
 * EMAIL_TRANSPORT=outbox (see playwright.config.ts), so each invitation
 * and RSVP confirmation email is written here as a JSON file instead of
 * being sent. No provider, no network, no public endpoint. Git-ignored;
 * cleared before each run. Invitations contain guest links (bearer
 * credentials): assertions on them are redacted.
 */
export const OUTBOX_DIR = resolve(process.cwd(), ".e2e-outbox");

/** Recipients at this domain make the fake transport fail (src/lib/email/outbox.ts). */
export const REJECTING_DOMAIN = "rechazo.example.com";

export type OutboxMessage = {
  messageId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function clearOutbox(): Promise<void> {
  if (!OUTBOX_DIR.endsWith(".e2e-outbox")) throw new Error("refusing to clear an unexpected directory");
  await rm(OUTBOX_DIR, { recursive: true, force: true });
}

/** Every message captured for `to`, oldest first. */
export async function emailsTo(to: string): Promise<OutboxMessage[]> {
  let files: string[];
  try {
    files = (await readdir(OUTBOX_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const messages = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(OUTBOX_DIR, f), "utf8")) as OutboxMessage),
  );
  return messages.filter((m) => m.to === to);
}

/** Waits until exactly `count` messages exist for `to`; returns the latest. */
export async function expectEmailCount(to: string, count: number): Promise<OutboxMessage | undefined> {
  await expect.poll(async () => (await emailsTo(to)).length, { message: "outbox message count" }).toBe(count);
  return (await emailsTo(to)).at(-1);
}

const RSVP_LINE = /^Confirmar asistencia: (http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43})$/m;

/** The RSVP link of a captured invitation (value redacted on failure). */
export function rsvpLinkOf(message: OutboxMessage): string {
  const link = RSVP_LINE.exec(message.text)?.[1];
  expect(link !== undefined, "the email carries a guest link (value redacted)").toBe(true);
  return link as string;
}
