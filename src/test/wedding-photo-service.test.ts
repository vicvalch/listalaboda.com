import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const purged = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("next/cache", () => ({ revalidateTag: (tag: string, profile: unknown) => purged.push([tag, profile]) }));

/**
 * UX-01B (ADR-022 §3, §13): the upload orchestration with the database and
 * storage replaced by a recording fake. Order: authorize → signature → sweep
 * → reserve → process → two uploads (member session) → complete. Any failure
 * after the reservation removes the objects and the row. Flag off: nothing
 * runs. Deletion removes objects BEFORE the row, then purges the CDN tag.
 */

const access = vi.hoisted(() => ({ result: { ok: true as boolean, reason: "not_found" } }));

vi.mock("@/lib/authz/wedding", () => ({
  requireWeddingMembership: async () =>
    access.result.ok
      ? { ok: true, access: { weddingId: WEDDING, userId: "u", membershipId: "m", role: "collaborator" } }
      : { ok: false, reason: access.result.reason },
}));

const WEDDING = "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c";
const PHOTO = "5b0c3b2e-8f1a-4c2d-9e3f-0a1b2c3d4e5f";

type Call = string;

function fakeClient(options: { reserve?: { data?: unknown; error?: { message: string } }; uploadFails?: boolean; complete?: { data?: unknown; error?: { message: string } } } = {}) {
  const calls: Call[] = [];
  const query = (table: string) => {
    const chain: Record<string, unknown> = {};
    let op = "select";
    const self = new Proxy(chain, {
      get(_target, prop: string) {
        if (prop === "then") {
          calls.push(`${op}:${table}`);
          const data = op === "select" ? (table === "wedding_photos" ? [{ id: PHOTO }] : []) : [{ id: PHOTO }];
          return (resolve: (value: unknown) => void) => resolve({ data, error: null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => {
            calls.push(`${op}:${table}`);
            return { data: { id: PHOTO }, error: null };
          };
        }
        if (prop === "delete" || prop === "update" || prop === "insert") {
          return () => {
            op = prop;
            return self;
          };
        }
        return () => self;
      },
    });
    return self;
  };
  return {
    calls,
    client: {
      from: (table: string) => query(table),
      rpc: async (name: string) => {
        calls.push(`rpc:${name}`);
        if (name === "create_wedding_photo") return options.reserve ?? { data: PHOTO, error: null };
        if (name === "complete_wedding_photo") return options.complete ?? { data: true, error: null };
        return { data: null, error: null };
      },
      storage: {
        from: () => ({
          upload: async (name: string) => {
            calls.push(`upload:${name}`);
            return options.uploadFails ? { data: null, error: { message: "denied" } } : { data: {}, error: null };
          },
          remove: async (names: string[]) => {
            calls.push(`remove:${names.join(",")}`);
            return { data: [], error: null };
          },
        }),
      },
    },
  };
}

const { deleteWeddingPhoto, photoFailure, uploadWeddingPhoto } = await import("@/lib/wedding-site/photos/service");

let jpeg: Uint8Array;

beforeEach(async () => {
  vi.stubEnv("WEDDING_SITE_PHOTOS", "on");
  access.result = { ok: true, reason: "not_found" };
  purged.length = 0;
  const pixels = Buffer.alloc(900 * 700 * 3, 120);
  jpeg ??= new Uint8Array(await sharp(pixels, { raw: { width: 900, height: 700, channels: 3 } }).jpeg().toBuffer());
});

afterEach(() => vi.unstubAllEnvs());

describe("uploadWeddingPhoto", () => {
  it("reserves before processing and uploads both renditions with the member's client", async () => {
    const fake = fakeClient();
    const result = await uploadWeddingPhoto(fake.client as never, WEDDING, jpeg);
    expect(result).toEqual({ ok: true, value: PHOTO });
    expect(fake.calls).toEqual([
      "select:wedding_photos",
      `remove:${PHOTO}/1600.webp,${PHOTO}/640.webp`,
      "rpc:create_wedding_photo",
      `upload:${PHOTO}/1600.webp`,
      `upload:${PHOTO}/640.webp`,
      "rpc:complete_wedding_photo",
    ]);
  });

  it("does nothing at all with the flag off or for a non-member", async () => {
    vi.stubEnv("WEDDING_SITE_PHOTOS", "");
    const off = fakeClient();
    expect(await uploadWeddingPhoto(off.client as never, WEDDING, jpeg)).toEqual({ ok: false, reason: "disabled" });
    expect(off.calls).toEqual([]);

    vi.stubEnv("WEDDING_SITE_PHOTOS", "on");
    access.result = { ok: false, reason: "not_found" };
    const outsider = fakeClient();
    expect(await uploadWeddingPhoto(outsider.client as never, WEDDING, jpeg)).toEqual({ ok: false, reason: "not_found" });
    expect(outsider.calls).toEqual([]);
  });

  it("refuses a wrong signature before reserving anything", async () => {
    const fake = fakeClient();
    const result = await uploadWeddingPhoto(fake.client as never, WEDDING, new TextEncoder().encode("GIF89a not allowed"));
    expect(result).toEqual({ ok: false, reason: "unsupported" });
    expect(fake.calls).toEqual([]);
  });

  it("maps quota refusals and leaves nothing behind when processing fails", async () => {
    const limited = fakeClient({ reserve: { error: { message: "wedding_photo_limit" } } });
    expect(await uploadWeddingPhoto(limited.client as never, WEDDING, jpeg)).toEqual({ ok: false, reason: "limit" });
    expect(limited.calls.some((call) => call.startsWith("upload:"))).toBe(false);

    const truncated = jpeg.subarray(0, 200);
    const broken = fakeClient();
    const result = await uploadWeddingPhoto(broken.client as never, WEDDING, truncated);
    expect(result.ok).toBe(false);
    expect(broken.calls.slice(-2)).toEqual([`remove:${PHOTO}/1600.webp,${PHOTO}/640.webp`, "delete:wedding_photos"]);
  });

  it("cleans up when an upload or the completion fails", async () => {
    const denied = fakeClient({ uploadFails: true });
    expect(await uploadWeddingPhoto(denied.client as never, WEDDING, jpeg)).toEqual({ ok: false, reason: "error" });
    expect(denied.calls.slice(-2)).toEqual([`remove:${PHOTO}/1600.webp,${PHOTO}/640.webp`, "delete:wedding_photos"]);

    const over = fakeClient({ complete: { error: { message: "wedding_photo_storage_limit" } } });
    expect(await uploadWeddingPhoto(over.client as never, WEDDING, jpeg)).toEqual({ ok: false, reason: "storage_limit" });
    expect(over.calls.slice(-2)).toEqual([`remove:${PHOTO}/1600.webp,${PHOTO}/640.webp`, "delete:wedding_photos"]);
  });
});

describe("deleteWeddingPhoto", () => {
  it("removes the objects first, then the row, then purges the CDN copy", async () => {
    const fake = fakeClient();
    expect(await deleteWeddingPhoto(fake.client as never, WEDDING, PHOTO)).toEqual({ ok: true });
    expect(fake.calls).toEqual(["select:wedding_photos", `remove:${PHOTO}/1600.webp,${PHOTO}/640.webp`, "delete:wedding_photos"]);
    expect(purged).toEqual([[`lb-photo-${PHOTO}`, { expire: 0 }]]);
  });
});

describe("photoFailure", () => {
  it("maps every named refusal to a closed reason and hides everything else", () => {
    expect(photoFailure({ message: "wedding_photo_busy" })).toBe("busy");
    expect(photoFailure({ message: "wedding_photo_daily_limit" })).toBe("daily_limit");
    expect(photoFailure({ message: "wedding_photos_paused" })).toBe("paused");
    expect(photoFailure({ message: "wedding_photo_block_full" })).toBe("block_full");
    expect(photoFailure({ message: "wedding_site_photo_block_limit" })).toBe("block_limit");
    expect(photoFailure({ message: "wedding_not_found" })).toBe("not_found");
    expect(photoFailure({ code: "42501", message: "new row violates row-level security policy" })).toBe("not_found");
    expect(photoFailure({ code: "XX000", message: "storage bucket wedding-photos internal" })).toBe("error");
  });
});
