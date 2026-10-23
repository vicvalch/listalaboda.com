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

const { setSectionVisibilityAction } = await import("@/app/app/weddings/[weddingId]/site/actions");
const { insertBlockAction, setBlockVisibilityAction } = await import("@/app/app/weddings/[weddingId]/site/photos/actions");
const { getMessages } = await import("@/lib/i18n");

// UX-01D: the unified editor's own writes. "Agregar sección aquí" creates a
// hidden block of the chosen kind at the chosen slot and opens it; the row
// switches change visibility only, from server-read content.

const WEDDING_ID = access.weddingId;
const BLOCK_ID = "8d0f6b8e-0000-4000-8000-0000000000b1";
const sitePath = `/app/weddings/${WEDDING_ID}/site`;
const copy = getMessages().site;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function sections(overrides: Partial<Record<string, { title: string | null; body: string | null; isVisible: boolean }>> = {}) {
  return ["intro", "ceremony", "reception", "schedule", "dress_code", "faq", "rsvp"].map((kind) => ({
    kind,
    title: null,
    body: null,
    isVisible: false,
    ...overrides[kind],
  }));
}

beforeEach(() => {
  for (const fn of [...Object.values(siteService), ...Object.values(photoService)]) fn.mockReset();
  authz.requireWeddingMembership.mockReset().mockResolvedValue({ ok: true, access });
  revalidatePath.mockReset();
  navigation.redirect.mockClear();
  navigation.notFound.mockClear();
});

describe("insertBlockAction", () => {
  it("creates the kind at the slot's anchor with its default design, hidden, then opens it in the editor", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: true, value: BLOCK_ID });
    await expect(
      insertBlockAction(form({ weddingId: WEDDING_ID, kind: "carousel", anchor: "ceremony", visible: "on", position: "0" })),
    ).rejects.toThrow(`NEXT_REDIRECT ${sitePath}?nueva=${BLOCK_ID}#bloque-${BLOCK_ID}`);
    expect(photoService.createPhotoBlock).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, "carousel", {
      variant: "standard",
      anchor: "ceremony",
      title: null,
      body: null,
    });
    expect(photoService.updatePhotoBlock).not.toHaveBeenCalled();
  });

  it("'top' is the slot right after the cover", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: true, value: BLOCK_ID });
    await expect(insertBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", anchor: "top" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(photoService.createPhotoBlock.mock.calls[0]?.[3]).toMatchObject({ variant: "grid", anchor: null });
  });

  it.each([
    ["cover", "intro"],
    ["slideshow", "intro"],
    ["gallery", "venue"],
  ])("refuses kind %j at %j before the service", async (kind, anchor) => {
    await expect(insertBlockAction(form({ weddingId: WEDDING_ID, kind, anchor }))).rejects.toThrow(
      `NEXT_REDIRECT ${sitePath}?error=invalid#secciones`,
    );
    expect(photoService.createPhotoBlock).not.toHaveBeenCalled();
  });

  it("the block limit comes back as a closed error", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: false, reason: "block_limit" });
    await expect(insertBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", anchor: "faq" }))).rejects.toThrow(
      `NEXT_REDIRECT ${sitePath}?error=block_limit#secciones`,
    );
  });

  it("the flag off is a 404", async () => {
    photoService.createPhotoBlock.mockResolvedValue({ ok: false, reason: "disabled" });
    await expect(insertBlockAction(form({ weddingId: WEDDING_ID, kind: "gallery", anchor: "faq" }))).rejects.toThrow("NEXT_NOT_FOUND");
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

describe("setSectionVisibilityAction", () => {
  it("re-saves the section's own saved title and body with the new visibility (never text from the form)", async () => {
    siteService.getWeddingSiteEditor.mockResolvedValue({
      sections: sections({ ceremony: { title: "La ceremonia", body: "A las 4", isVisible: false } }),
    });
    siteService.saveContentSection.mockResolvedValue({ ok: true });
    const state = await setSectionVisibilityAction(
      null,
      form({ weddingId: WEDDING_ID, kind: "ceremony", visible: "on", title: "forjado", body: "<script>" }),
    );
    expect(siteService.saveContentSection).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, {
      kind: "ceremony",
      title: "La ceremonia",
      body: "A las 4",
      isVisible: true,
    });
    expect(state).toMatchObject({ ok: true, data: { message: "«La ceremonia» ahora es visible." } });
  });

  it("can't show a section without content (RSVP can: it has fixed guidance)", async () => {
    siteService.getWeddingSiteEditor.mockResolvedValue({ sections: sections() });
    expect(await setSectionVisibilityAction(null, form({ weddingId: WEDDING_ID, kind: "faq", visible: "on" }))).toEqual({
      ok: false,
      formError: copy.sections.needsContent,
    });
    expect(siteService.saveContentSection).not.toHaveBeenCalled();
    siteService.saveContentSection.mockResolvedValue({ ok: true });
    expect(await setSectionVisibilityAction(null, form({ weddingId: WEDDING_ID, kind: "rsvp", visible: "on" }))).toMatchObject({ ok: true });
  });

  it("a non-member gets the same 404, and nothing is read or written", async () => {
    authz.requireWeddingMembership.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(setSectionVisibilityAction(null, form({ weddingId: WEDDING_ID, kind: "intro", visible: "off" }))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(siteService.getWeddingSiteEditor).not.toHaveBeenCalled();
    expect(siteService.saveContentSection).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind", async () => {
    expect(await setSectionVisibilityAction(null, form({ weddingId: WEDDING_ID, kind: "venue", visible: "on" }))).toEqual({
      ok: false,
      formError: copy.errors.failed,
    });
  });
});
