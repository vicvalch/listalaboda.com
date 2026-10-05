import "server-only";

import { isAbsolute } from "node:path";

import { normalizeContactEmail } from "@/lib/guests/contact-email";
import { isLocalOrigin, parseAppOrigin } from "@/lib/http/app-origin";

export { parseAppOrigin };

/**
 * Server-only email configuration (LB-11). The one place that reads the
 * email environment; nothing here is ever `NEXT_PUBLIC_*` or reaches the
 * browser.
 *
 * - `APP_ORIGIN`: the trusted origin for absolute links in emails (the RSVP
 *   link, the wedding website). Never taken from request headers: a member
 *   could otherwise make our sender mail a link to any host.
 * - `EMAIL_FROM`: the sender, `Name <address>` or a bare address, on a
 *   domain verified with the provider. Never hardcoded.
 * - `EMAIL_TRANSPORT`: `resend` (default) or `outbox`.
 * - `RESEND_API_KEY`: required for `resend`.
 * - `EMAIL_OUTBOX_DIR`: for `outbox` only — a local directory where each
 *   message is written as a file instead of being sent. Test/local tooling:
 *   refused unless `APP_ORIGIN` is localhost, so a production deployment
 *   can't be switched to it by accident.
 *
 * Missing or invalid configuration is a safe, uniform failure: email isn't
 * available, nothing else breaks. Values are never echoed.
 */

export type EmailTransportConfig =
  | Readonly<{ kind: "resend"; apiKey: string }>
  | Readonly<{ kind: "outbox"; dir: string }>;

export type EmailConfig = Readonly<{
  appOrigin: string;
  from: string;
  transport: EmailTransportConfig;
}>;

export type EmailConfigResult =
  | Readonly<{ ok: true; config: EmailConfig }>
  | Readonly<{ ok: false; problem: "missing" | "invalid" }>;

type EnvSource = Readonly<Record<string, string | undefined>>;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** `Name <address>` or `address`; the address must be a plain valid one. */
export function parseSender(value: string): string | null {
  if (CONTROL_CHARACTERS.test(value) || value.length > 320) return null;
  const named = /^([^<>"]{1,100}?)\s*<([^<>\s]+)>$/.exec(value);
  if (named) {
    const name = named[1].trim();
    const address = normalizeContactEmail(named[2]);
    return name && address ? `${name} <${address}>` : null;
  }
  return normalizeContactEmail(value);
}

/** Pure: validates an env source into the email configuration. */
export function parseEmailConfig(source: EnvSource): EmailConfigResult {
  const read = (name: string) => source[name]?.trim() ?? "";
  const originRaw = read("APP_ORIGIN");
  const fromRaw = read("EMAIL_FROM");
  const transportRaw = read("EMAIL_TRANSPORT") || "resend";
  if (!originRaw || !fromRaw) return { ok: false, problem: "missing" };

  const appOrigin = parseAppOrigin(originRaw);
  const from = parseSender(fromRaw);
  if (!appOrigin || !from) return { ok: false, problem: "invalid" };

  if (transportRaw === "resend") {
    const apiKey = read("RESEND_API_KEY");
    if (!apiKey) return { ok: false, problem: "missing" };
    if (CONTROL_CHARACTERS.test(apiKey) || /\s/.test(apiKey)) return { ok: false, problem: "invalid" };
    return { ok: true, config: { appOrigin, from, transport: { kind: "resend", apiKey } } };
  }

  if (transportRaw === "outbox") {
    const dir = read("EMAIL_OUTBOX_DIR");
    if (!dir) return { ok: false, problem: "missing" };
    if (!isAbsolute(dir) || !isLocalOrigin(appOrigin)) return { ok: false, problem: "invalid" };
    return { ok: true, config: { appOrigin, from, transport: { kind: "outbox", dir } } };
  }

  return { ok: false, problem: "invalid" };
}

/** Reads the email configuration from `process.env` (server only). */
export function getEmailConfig(): EmailConfigResult {
  return parseEmailConfig({
    APP_ORIGIN: process.env.APP_ORIGIN,
    EMAIL_FROM: process.env.EMAIL_FROM,
    EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_OUTBOX_DIR: process.env.EMAIL_OUTBOX_DIR,
  });
}
