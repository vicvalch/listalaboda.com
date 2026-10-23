import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
const requireUser = vi.hoisted(() => vi.fn(async () => ({ id: "user" })));
vi.mock("@/lib/auth/session", () => ({ requireUser }));
const userClient = vi.hoisted(() => ({ kind: "user-session-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => userClient) }));
const access = vi.hoisted(() => ({ weddingId: "8d0f6b8e-0000-4000-8000-000000000001", userId: "user", role: "collaborator" }));
const authz = vi.hoisted(() => ({ requireWeddingMembership: vi.fn() }));
vi.mock("@/lib/authz/wedding", () => authz);

const siteService = vi.hoisted(() => ({
  getWeddingSiteEditor: vi.fn(),
  saveContentSection: vi.fn(),
  saveWeddingSiteTheme: vi.fn(),
  saveWeddingSiteDesign: vi.fn(),
  resetWeddingSiteCustomization: vi.fn(),
  setWeddingSiteSlug: vi.fn(),
  publishWeddingSite: vi.fn(),
  unpublishWeddingSite: vi.fn(),
}));
vi.mock("@/lib/wedding-site/service", () => siteService);
const photoService = vi.hoisted(() => ({
  createPhotoBlock: vi.fn(),
  updatePhotoBlock: vi.fn(),
  purgeWeddingPhotos: vi.fn(),
}));
vi.mock("@/lib/wedding-site/photos/service", () => photoService);

const { createStudioBlockAction, setBlockVisibilityAction } = await import("@/app/app/weddings/[weddingId]/site/photos/actions");
const { getMessages } = await import("@/lib/i18n");

// STUDIO-01: Studio's own writes. "Agregar … aquí" creates a hidden block of
// the chosen kind and design at the chosen slot and returns its id (Studio
// selects it); the visibility switch changes visibility only.

const WEDDING_ID = access.weddingId;
const BLOCK_ID = "8d0f6b8e-0000-4000-8000-0000000000b1";
const sitePath = `/app/weddings/${WEDDING_ID}/site`;
const copy = getMessages().site;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  for (const fn of [...Object.values(siteService), ...Object.values(photoService)]) fn.mockReset();
  authz.requireWeddingMembership.mockReset().mockResolvedValue({ ok: true, access });
  revalidatePath.mockReset();
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
});

describe("createStudioBlockAction", () => {
  it("creates the kind at the slot's anchor with the chosen design, hidden, and returns its id", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: true, value: BLOCK_ID });
    const result = await createStudioBlockAction(
      form({ weddingId: WEDDING_ID, kind: "carousel", variant: "standard", anchor: "ceremony", visible: "on", position: "0" }),
    );
    expect(result).toMatchObject({ ok: true, blockId: BLOCK_ID });
    expect(photoService.createPhotoBlock).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, "carousel", {
      variant: "standard",
      anchor: "ceremony",
      title: null,
      body: null,
    });
    expect(photoService.updatePhotoBlock).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(sitePath, "layout");
  });

  it("'top' is the slot right after the cover; an unknown design falls back to the kind's default", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: true, value: BLOCK_ID });
    await createStudioBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", variant: "neon", anchor: "top" }));
    expect(photoService.createPhotoBlock.mock.calls[0]?.[3]).toMatchObject({ variant: "grid", anchor: null });
  });

  it.each([
    ["cover", "intro"],
    ["slideshow", "intro"],
    ["gallery", "venue"],
  ])("refuses kind %j at %j before the service", async (kind, anchor) => {
    expect(await createStudioBlockAction(form({ weddingId: WEDDING_ID, kind, anchor }))).toEqual({
      ok: false,
      formError: copy.photos.errors.invalid,
    });
    expect(photoService.createPhotoBlock).not.toHaveBeenCalled();
  });

  it("the block limit comes back as its message", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: false, reason: "block_limit" });
    expect(await createStudioBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", anchor: "faq" }))).toEqual({
      ok: false,
      formError: copy.photos.errors.blockLimit,
    });
  });

  it("the flag off or a non-member is a 404", async () => {
    for (const reason of ["disabled", "not_found"] as const) {
      photoService.createPhotoBlock.mockResolvedValue({ ok: false, reason });
      const outcome = createStudioBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", anchor: "faq" }));
      if (reason === "disabled") await expect(outcome).rejects.toThrow("NEXT_NOT_FOUND");
      else expect(await outcome).toEqual({ ok: false, formError: copy.photos.errors.notFound });
    }
  });
});

describe("setBlockVisibilityAction", () => {
  it("changes visibility only", async () => {
    photoService.updatePhotoBlock.mockResolvedValue({ ok: true });
    const state = await setBlockVisibilityAction(
      null,
      form({ weddingId: WEDDING_ID, blockId: BLOCK_ID, visible: "on", name: "Carrusel", anchor: "faq", variant: "masonry" }),
    );
    expect(photoService.updatePhotoBlock).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, BLOCK_ID, { isVisible: true });
    expect(state).toMatchObject({ ok: true, data: { message: "«Carrusel» ahora es visible." } });
  });
});
