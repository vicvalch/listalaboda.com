import "server-only";

/**
 * The app's trusted public origin (`APP_ORIGIN`), for absolute links that
 * leave the current request: emailed links (LB-11/LB-12) and recovered RSVP
 * links (LB-13). Configuration only — never derived from request headers
 * (Host/Origin), so nobody can make the server mint a link to another host.
 *
 * Kept apart from the email configuration so a feature that only needs the
 * origin (copying a recovered link) doesn't require an email provider.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An exact `http(s)://host[:port]` origin; https unless it's localhost. */
export function parseAppOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  // Only an origin: no path, query or fragment (a trailing "/" is fine).
  if (value.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

export function isLocalOrigin(origin: string): boolean {
  return LOCAL_HOSTS.has(new URL(origin).hostname);
}

/** Reads `APP_ORIGIN` (server only); null when missing or invalid. */
export function getAppOrigin(): string | null {
  const raw = process.env.APP_ORIGIN?.trim() ?? "";
  return raw ? parseAppOrigin(raw) : null;
}
