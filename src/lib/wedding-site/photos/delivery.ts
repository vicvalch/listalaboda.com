import "server-only";

import { isPhotoId, isPhotoRendition, photoCacheTag, type PhotoRendition } from "@/lib/wedding-site/photos/model";

/**
 * The photo routes' HTTP shape (ADR-022 §4, §13.6), shared by the public
 * origin route and the member preview route, so both send exactly these
 * headers. Pure apart from the injected reader.
 *
 * - Fixed `image/webp`, `nosniff`, `default-src 'none'` (nothing in the
 *   response can run), same-origin resource policy, `noindex`.
 * - Public: 10 minutes in browsers, 30 days on Vercel's CDN, tagged
 *   `lb-photo-<id>` so unpublishing, hiding or deleting can purge it.
 * - Member: `private, no-store` (never cached anywhere).
 * - Every failure is the same empty 404, never cached, never explaining why.
 * - Any query string is a 404: the CDN key can't be varied to bypass the cache.
 */

const BASE_HEADERS = {
  "Content-Type": "image/webp",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export const PUBLIC_BROWSER_MAX_AGE = 600;
export const PUBLIC_CDN_MAX_AGE = 2_592_000;

export function notFoundResponse(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function publicPhotoResponse(photoId: string, bytes: Uint8Array): Response {
  return new Response(body(bytes), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": `public, max-age=${PUBLIC_BROWSER_MAX_AGE}`,
      "Vercel-CDN-Cache-Control": `public, max-age=${PUBLIC_CDN_MAX_AGE}`,
      "Vercel-Cache-Tag": photoCacheTag(photoId),
    },
  });
}

export function memberPhotoResponse(bytes: Uint8Array): Response {
  return new Response(body(bytes), {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, no-store" },
  });
}

/** The route's own path parameters, or null (unknown rendition, malformed id, any query string). */
export function readPhotoRequest(
  url: string,
  params: Readonly<{ photoId: string; rendition: string }>,
): Readonly<{ photoId: string; rendition: PhotoRendition }> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.search !== "" || url.includes("?")) return null;
  if (!isPhotoId(params.photoId) || !isPhotoRendition(params.rendition)) return null;
  return { photoId: params.photoId, rendition: params.rendition };
}
