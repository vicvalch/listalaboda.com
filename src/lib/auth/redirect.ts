/**
 * Internal-redirect validation. Every `next=` value (query string, form field,
 * auth callback) passes through `safeNextPath` before it reaches a redirect,
 * so a crafted link can never send a user to another origin.
 *
 * Pure and dependency-free: safe to import from any runtime.
 */

export const DEFAULT_NEXT_PATH = "/app";

/** Path that resumes a membership invite after authentication. */
export const INVITE_CONTINUE_PATH = "/invite/continue";

// Parsed against a fixed fake origin: anything that resolves elsewhere is
// external, whatever tricks the raw string uses.
const PROBE_ORIGIN = "https://listalaboda.invalid";

const MAX_NEXT_LENGTH = 512;

/**
 * Returns `value` if it is a same-origin, absolute path (e.g. `/app`),
 * otherwise `DEFAULT_NEXT_PATH`. Rejects absolute and protocol-relative URLs,
 * schemes (`javascript:`, `data:`), backslashes, control characters and
 * percent-encoded variants of those tricks.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT_PATH;

  // Must be a rooted path, but not `//host` (protocol-relative).
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_NEXT_PATH;

  // Browsers treat `\` like `/` (`/\evil.example`), and control characters
  // or whitespace are stripped/normalized inconsistently. Check both the raw
  // and the decoded form so `%5C`, `%2F%2F`, `%09` etc. are caught too.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  for (const candidate of [value, decoded]) {
    if (candidate.includes("\\")) return DEFAULT_NEXT_PATH;
    if (hasControlOrSpace(candidate)) return DEFAULT_NEXT_PATH;
    if (candidate.startsWith("//")) return DEFAULT_NEXT_PATH;
  }

  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== PROBE_ORIGIN) return DEFAULT_NEXT_PATH;

  // Validate what we actually return: dot-segment normalization can turn a
  // harmless-looking `/.//evil.example` into the protocol-relative `//evil.example`.
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  if (!normalized.startsWith("/") || normalized.startsWith("//") || normalized.includes("\\")) {
    return DEFAULT_NEXT_PATH;
  }
  return normalized;
}

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(char)) return true;
  }
  return false;
}

/** `/login`, carrying a validated continuation when it isn't the default. */
export function loginPath(next?: string): string {
  return withNext("/login", next);
}

/** `/signup`, carrying a validated continuation when it isn't the default. */
export function signupPath(next?: string): string {
  return withNext("/signup", next);
}

function withNext(path: string, next: string | undefined): string {
  const safe = safeNextPath(next);
  if (safe === DEFAULT_NEXT_PATH) return path;
  return `${path}?${new URLSearchParams({ next: safe }).toString()}`;
}
