import "server-only";

import { headers } from "next/headers";

/**
 * Origin of the current request, for building absolute links (invite URLs,
 * the signup confirmation redirect).
 *
 * Server Actions reject requests whose `Origin` doesn't match the host, so
 * there `Origin` is the app's own origin. The `Host` fallback covers
 * requests without an `Origin` header. The result is only ever used to build
 * links shown to the same user, or as a redirect target that Supabase Auth
 * checks against its own allow-list.
 */
export async function getRequestOrigin(): Promise<string | null> {
  const requestHeaders = await headers();

  const origin = parseHttpOrigin(requestHeaders.get("origin"));
  if (origin) return origin;

  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) return null;
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : "http";
  return parseHttpOrigin(`${proto}://${host}`);
}

function parseHttpOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
