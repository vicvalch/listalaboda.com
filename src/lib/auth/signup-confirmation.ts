import { isWellFormedRecoveryTokenHash, AUTH_CALLBACK_PATH } from "@/lib/auth/recovery";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/redirect";

/**
 * Signup email confirmation through Supabase Auth's own verification
 * (Batch 3), on the same scanner-safe pattern as AUTH-RECOVERY-02.
 *
 * `signUp` → the "Confirm signup" email links to the app's
 * `/auth/confirm/prepare?token_hash={{ .TokenHash }}&redirect_to={{ .RedirectTo }}`,
 * which only moves the token into a short-lived httpOnly cookie →
 * `/auth/confirm` → the person presses "Confirmar mi cuenta" →
 * `verifyOtp({ token_hash, type: "email" })` (a POST, the only step that
 * consumes the token) → the continuation. The token hash needs no PKCE
 * verifier, so the link works in any browser or device; a link scanner's
 * GETs change nothing.
 *
 * Links sent with the previous template (`{{ .ConfirmationURL }}` →
 * Supabase verify → the shared `/auth/callback` PKCE exchange) keep working
 * where they always did. No custom tokens, nothing stored by the app. Pure
 * and dependency-free.
 */

/** The emailed link's entry point (a GET that never verifies anything). */
export const SIGNUP_CONFIRM_PREPARE_PATH = "/auth/confirm/prepare";
/** The explicit confirmation page; its button verifies the token. */
export const SIGNUP_CONFIRM_PATH = "/auth/confirm";

/** Supabase's email token hash: the same shape for signup and recovery links. */
export function isWellFormedSignupTokenHash(value: unknown): value is string {
  return isWellFormedRecoveryTokenHash(value);
}

/**
 * The `emailRedirectTo` for `signUp`: the shared code exchange carrying the
 * continuation. Supabase Auth checks it against its allow-list and exposes it
 * to the template as `{{ .RedirectTo }}`; the new template passes it back to
 * the prepare route (`continuationFromRedirectTo`), a link sent with the
 * previous template still returns through it. `origin` must be the trusted
 * app origin (`APP_ORIGIN`).
 */
export function signupRedirectUrl(origin: string, next?: string): string {
  const safe = safeNextPath(next);
  const query = safe === DEFAULT_NEXT_PATH ? "" : `?${new URLSearchParams({ next: safe }).toString()}`;
  return `${origin}${AUTH_CALLBACK_PATH}${query}`;
}

/**
 * The continuation inside the email's `redirect_to` (the `{{ .RedirectTo }}`
 * that `signupRedirectUrl` built): its `/auth/callback` `next`, validated.
 * Anything else (missing, malformed, Supabase's fallback to the Site URL
 * when the redirect wasn't allowed, another path) is the default `/app`.
 * Only a path is ever taken from it, never an origin, so the link can't
 * redirect anywhere else.
 */
export function continuationFromRedirectTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return DEFAULT_NEXT_PATH;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.pathname !== AUTH_CALLBACK_PATH) return DEFAULT_NEXT_PATH;
  return safeNextPath(url.searchParams.get("next"));
}

function withNext(path: string, next: string | undefined, extra: Record<string, string> = {}): string {
  const safe = safeNextPath(next);
  const query = new URLSearchParams({ ...(safe === DEFAULT_NEXT_PATH ? {} : { next: safe }), ...extra }).toString();
  return query ? `${path}?${query}` : path;
}

/** `/auth/confirm`, carrying a validated continuation when it isn't the default. */
export function signupConfirmPath(next?: string): string {
  return withNext(SIGNUP_CONFIRM_PATH, next);
}

/**
 * Where a refused confirmation goes: the login page with a "link used or no
 * longer valid" notice that says what to do whether or not the account is
 * already confirmed (the same words either way: nothing about the account is
 * revealed). Someone already signed in there simply continues.
 */
export function signupConfirmFailurePath(next?: string): string {
  return withNext("/login", next, { error: "confirm" });
}
