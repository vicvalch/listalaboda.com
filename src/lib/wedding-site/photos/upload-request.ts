import { PHOTO_LIMITS } from "@/lib/wedding-site/photos/model";

/**
 * The upload request's own checks (ADR-022 §13.1), before any session or
 * database work. Server Actions verify that a POST comes from the app's own
 * origin; this route does the same explicitly: `Origin` must be present and
 * name the request's host (and, when the browser says so, the fetch must be
 * same-origin). The session cookies are `SameSite=Lax`, so another site's
 * form can't carry them either. Pure; exported for tests.
 */
export function isSameOriginUpload(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!origin || !host) return false;
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host === host;
  } catch {
    return false;
  }
}

/** A declared body larger than the transport limit is refused before it is read. */
export function isAcceptableUploadLength(headers: Headers): boolean {
  const declared = headers.get("content-length");
  if (declared === null) return false;
  if (!/^\d{1,9}$/.test(declared)) return false;
  return Number(declared) > 0 && Number(declared) <= PHOTO_LIMITS.requestBytes;
}
