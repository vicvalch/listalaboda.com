import { execFileSync } from "node:child_process";

import { expect } from "@playwright/test";

import { assertLocal } from "./local-supabase";

/**
 * The LOCAL Supabase stack's mail catcher (Mailpit): the local Auth server
 * delivers its emails (e.g. password recovery, AUTH-RECOVERY-01) there
 * instead of sending them. Read-only use; refuses anything but localhost.
 * Recovery links are bearer credentials: never log or print them.
 */

let cachedUrl: string | null = null;

function mailpitUrl(): string {
  if (cachedUrl) return cachedUrl;
  const status = JSON.parse(
    execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ) as { MAILPIT_URL?: string; INBUCKET_URL?: string };
  const url = status.MAILPIT_URL ?? status.INBUCKET_URL;
  if (!url) throw new Error("Local Supabase reports no mail catcher (is Mailpit excluded?).");
  assertLocal(url);
  cachedUrl = url;
  return url;
}

type Summary = { ID: string };

async function messagesTo(address: string): Promise<Summary[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const response = await fetch(`${mailpitUrl()}/api/v1/search?query=${query}`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages?: Summary[] };
  return body.messages ?? [];
}

/** How many emails the local Auth server has delivered to `address`. */
export async function countEmailsTo(address: string): Promise<number> {
  return (await messagesTo(address)).length;
}

/** The newest email to `address` (waits for it), as plain text. */
export async function latestEmailTextTo(address: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(async () => {
      id = (await messagesTo(address))[0]?.ID;
      return id !== undefined;
    }, { timeout: 15_000 })
    .toBe(true);
  const response = await fetch(`${mailpitUrl()}/api/v1/message/${id}`);
  if (!response.ok) throw new Error(`Mailpit message read failed: ${response.status}`);
  const body = (await response.json()) as { Text?: string; HTML?: string };
  return `${body.Text ?? ""}\n${body.HTML ?? ""}`;
}

/** The Supabase Auth verification link inside an Auth email. */
export function authLinkIn(text: string): URL {
  const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(text);
  if (!match) throw new Error("No Auth verification link in the email.");
  return new URL(match[0].replace(/&amp;/g, "&"));
}
