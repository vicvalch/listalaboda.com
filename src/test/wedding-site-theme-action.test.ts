import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => navigation);
const requireUser = vi.hoisted(() => vi.fn(async () => ({ id: "user" })));
vi.mock("@/lib/auth/session", () => ({ requireUser }));

const userClient = vi.hoisted(() => ({ kind: "user-session-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => userClient) }));

const service = vi.hoisted(() => ({
  saveWeddingSiteTheme: vi.fn(),
  saveWeddingSiteDesign: vi.fn(),
  resetWeddingSiteCustomization: vi.fn(),
  saveContentSection: vi.fn(),
  setWeddingSiteSlug: vi.fn(),
  publishWeddingSite: vi.fn(),
  unpublishWeddingSite: vi.fn(),
}));
vi.mock("@/lib/wedding-site/service", () => service);

const { saveThemeAction } = await import("@/app/app/weddings/[weddingId]/site/actions");
const { getMessages } = await import("@/lib/i18n");

// "Usar este estilo" (ADR-019, CP5): the browser sends the wedding id and a
// theme key. The caller and membership come from the server (the service),
// only exact theme keys reach it, and it never publishes or touches content.

const WEDDING_ID = "8d0f6b8e-0000-4000-8000-000000000001";
const copy = getMessages().site;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("saveThemeAction", () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    revalidatePath.mockReset();
    navigation.notFound.mockClear();
    requireUser.mockClear();
  });

  it("saves through the CP4 service with only the wedding id and the key", async () => {
    service.saveWeddingSiteTheme.mockResolvedValue({ ok: true, themeKey: "romantic", dropped: [] });
    const state = await saveThemeAction(
      null,
      form({ weddingId: WEDDING_ID, theme: "romantic", role: "owner", published: "true", theme_key: "neon" }),
    );
    expect(requireUser).toHaveBeenCalledWith(`/app/weddings/${WEDDING_ID}/site`);
    expect(service.saveWeddingSiteTheme).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, "romantic");
    // Nothing else: no publication or content call.
    for (const [name, fn] of Object.entries(service)) {
      if (name !== "saveWeddingSiteTheme") expect(fn, name).not.toHaveBeenCalled();
    }
    expect(state).toMatchObject({ ok: true, data: { message: "Guardamos el estilo «Romántico»." } });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/weddings/${WEDDING_ID}/site`, "layout");
  });

  it("says when the new theme dropped saved customization choices", async () => {
    service.saveWeddingSiteTheme.mockResolvedValue({ ok: true, themeKey: "minimal", dropped: ["palette", "hero"] });
    const state = await saveThemeAction(null, form({ weddingId: WEDDING_ID, theme: "minimal" }));
    expect(state).toMatchObject({
      ok: true,
      data: { message: `Guardamos el estilo «Minimalista». ${copy.design.dropped}` },
    });
  });

  it.each([["neon"], ["Editorial"], [""], ["classic "], ["__proto__"]])(
    "a forged theme %j never reaches the service",
    async (theme) => {
      const state = await saveThemeAction(null, form({ weddingId: WEDDING_ID, theme }));
      expect(state).toEqual({ ok: false, formError: copy.design.invalid });
      expect(service.saveWeddingSiteTheme).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("a missing theme never reaches the service", async () => {
    expect(await saveThemeAction(null, form({ weddingId: WEDDING_ID }))).toEqual({
      ok: false,
      formError: copy.design.invalid,
    });
    expect(service.saveWeddingSiteTheme).not.toHaveBeenCalled();
  });

  it("an outsider (not a member) gets the same 404 as a missing wedding", async () => {
    service.saveWeddingSiteTheme.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(saveThemeAction(null, form({ weddingId: WEDDING_ID, theme: "minimal" }))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a signed-out caller is sent to log in before anything else", async () => {
    requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(saveThemeAction(null, form({ weddingId: WEDDING_ID, theme: "minimal" }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(service.saveWeddingSiteTheme).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", copy.design.invalid],
    ["error", copy.errors.failed],
  ] as const)("a %s result is a fixed message, never a raw error", async (reason, message) => {
    service.saveWeddingSiteTheme.mockResolvedValue({ ok: false, reason });
    expect(await saveThemeAction(null, form({ weddingId: WEDDING_ID, theme: "tropical" }))).toEqual({
      ok: false,
      formError: message,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
