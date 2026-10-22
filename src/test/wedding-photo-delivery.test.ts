import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * UX-01B (ADR-022 §4, §13.6): the photo routes' HTTP behaviour with the
 * origin and member reader replaced. Every failure is the same uncached 404;
 * a query string is a 404; the public response carries exactly the approved
 * headers and no cookies; the member response is never cached.
 */

const origin = vi.hoisted(() => ({
  configured: true,
  calls: [] as Array<[string, string, string]>,
  bytes: null as Uint8Array | null,
}));
const member = vi.hoisted(() => ({ calls: [] as Array<[string, string, string]>, bytes: null as Uint8Array | null }));

vi.mock("@/lib/wedding-site/photo-origin", () => ({
  getPhotoOrigin: () =>
    origin.configured
      ? {
          fetchPublishedPhoto: async (slug: string, photoId: string, rendition: string) => {
            origin.calls.push([slug, photoId, rendition]);
            return origin.bytes;
          },
        }
      : null,
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@/lib/wedding-site/photos/service", () => ({
  readMemberPhoto: async (_client: unknown, weddingId: string, photoId: string, rendition: string) => {
    member.calls.push([weddingId, photoId, rendition]);
    return member.bytes;
  },
}));

const { GET: publicGet } = await import("@/app/boda/[slug]/fotos/[photoId]/[rendition]/route");
const { GET: memberGet } = await import("@/app/app/weddings/[weddingId]/site/photos/[photoId]/[rendition]/route");
const { isAcceptableUploadLength, isSameOriginUpload } = await import("@/lib/wedding-site/photos/upload-request");

const PHOTO = "5b0c3b2e-8f1a-4c2d-9e3f-0a1b2c3d4e5f";
const WEDDING = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
const BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

function publicRequest(path: string, params: { slug: string; photoId: string; rendition: string }) {
  return publicGet(new Request(`https://listalaboda.com${path}`), { params: Promise.resolve(params) } as never);
}

function memberRequest(path: string, params: { weddingId: string; photoId: string; rendition: string }) {
  return memberGet(new Request(`https://listalaboda.com${path}`), { params: Promise.resolve(params) } as never);
}

beforeEach(() => {
  vi.stubEnv("WEDDING_SITE_PHOTOS", "on");
  origin.configured = true;
  origin.calls = [];
  origin.bytes = BYTES;
  member.calls = [];
  member.bytes = BYTES;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("vercel-cdn-cache-control")).toBeNull();
  expect(await response.text()).toBe("");
}

describe("public photo route", () => {
  it("serves a published photo with the approved headers and no cookies", async () => {
    const response = await publicRequest(`/boda/ana-y-luis/fotos/${PHOTO}/640`, { slug: "ana-y-luis", photoId: PHOTO, rendition: "640" });
    expect(response.status).toBe(200);
    expect(origin.calls).toEqual([["ana-y-luis", PHOTO, "640"]]);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/webp",
      "content-length": String(BYTES.byteLength),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cross-origin-resource-policy": "same-origin",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "public, max-age=600",
      "vercel-cdn-cache-control": "public, max-age=2592000",
      "vercel-cache-tag": `lb-photo-${PHOTO}`,
    });
  });

  it("is a 404 with the flag off, without reaching the origin", async () => {
    vi.stubEnv("WEDDING_SITE_PHOTOS", "");
    await expectNotFound(await publicRequest(`/boda/a/fotos/${PHOTO}/640`, { slug: "ana-y-luis", photoId: PHOTO, rendition: "640" }));
    vi.stubEnv("WEDDING_SITE_PHOTOS", "true");
    await expectNotFound(await publicRequest(`/boda/a/fotos/${PHOTO}/640`, { slug: "ana-y-luis", photoId: PHOTO, rendition: "640" }));
    expect(origin.calls).toEqual([]);
  });

  it("refuses any query string, unknown renditions and malformed ids before the origin", async () => {
    for (const path of [`/boda/ana-y-luis/fotos/${PHOTO}/640?v=2`, `/boda/ana-y-luis/fotos/${PHOTO}/640?`]) {
      await expectNotFound(await publicRequest(path, { slug: "ana-y-luis", photoId: PHOTO, rendition: "640" }));
    }
    for (const [photoId, rendition] of [
      [PHOTO, "2400"],
      [PHOTO, "original"],
      [PHOTO.toUpperCase(), "640"],
      ["../../etc", "640"],
    ]) {
      await expectNotFound(
        await publicRequest(`/boda/ana-y-luis/fotos/${photoId}/${rendition}`, { slug: "ana-y-luis", photoId, rendition }),
      );
    }
    expect(origin.calls).toEqual([]);
  });

  it("is the same 404 for an unpublished, hidden, foreign or over-budget photo, or no origin", async () => {
    origin.bytes = null;
    await expectNotFound(await publicRequest(`/boda/x/fotos/${PHOTO}/1600`, { slug: "ana-y-luis", photoId: PHOTO, rendition: "1600" }));
    origin.configured = false;
    await expectNotFound(await publicRequest(`/boda/x/fotos/${PHOTO}/1600`, { slug: "ana-y-luis", photoId: PHOTO, rendition: "1600" }));
  });
});

describe("member photo route", () => {
  it("serves the member's photo, never cached", async () => {
    const response = await memberRequest(`/app/weddings/${WEDDING}/site/photos/${PHOTO}/1600`, {
      weddingId: WEDDING,
      photoId: PHOTO,
      rendition: "1600",
    });
    expect(response.status).toBe(200);
    expect(member.calls).toEqual([[WEDDING, PHOTO, "1600"]]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(response.headers.get("vercel-cache-tag")).toBeNull();
  });

  it("is a 404 for anyone the reader refuses, and for queries", async () => {
    member.bytes = null;
    await expectNotFound(
      await memberRequest(`/app/weddings/${WEDDING}/site/photos/${PHOTO}/640`, { weddingId: WEDDING, photoId: PHOTO, rendition: "640" }),
    );
    member.bytes = BYTES;
    await expectNotFound(
      await memberRequest(`/app/weddings/${WEDDING}/site/photos/${PHOTO}/640?x=1`, { weddingId: WEDDING, photoId: PHOTO, rendition: "640" }),
    );
  });
});

describe("upload request checks", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("accepts only same-origin posts", () => {
    expect(isSameOriginUpload(headers({ origin: "https://listalaboda.com", host: "listalaboda.com" }))).toBe(true);
    expect(
      isSameOriginUpload(headers({ origin: "https://listalaboda.com", host: "x.vercel.app", "x-forwarded-host": "listalaboda.com" })),
    ).toBe(true);
    expect(isSameOriginUpload(headers({ origin: "https://listalaboda.com", host: "listalaboda.com", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginUpload(headers({ host: "listalaboda.com" }))).toBe(false);
    expect(isSameOriginUpload(headers({ origin: "https://evil.example", host: "listalaboda.com" }))).toBe(false);
    expect(isSameOriginUpload(headers({ origin: "null", host: "listalaboda.com" }))).toBe(false);
    expect(
      isSameOriginUpload(headers({ origin: "https://listalaboda.com", host: "listalaboda.com", "sec-fetch-site": "cross-site" })),
    ).toBe(false);
  });

  it("refuses bodies without a length or above 4.5 MB before reading them", () => {
    expect(isAcceptableUploadLength(headers({ "content-length": "3000000" }))).toBe(true);
    expect(isAcceptableUploadLength(headers({}))).toBe(false);
    expect(isAcceptableUploadLength(headers({ "content-length": "0" }))).toBe(false);
    expect(isAcceptableUploadLength(headers({ "content-length": String(5 * 1024 * 1024) }))).toBe(false);
    expect(isAcceptableUploadLength(headers({ "content-length": "1e9" }))).toBe(false);
  });
});
