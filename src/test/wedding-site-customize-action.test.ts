import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
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

const { saveCustomizationAction } = await import("@/app/app/weddings/[weddingId]/site/actions");
const { getMessages } = await import("@/lib/i18n");

// "Personalizar" (ADR-019, CP6): the browser sends the wedding id, the theme
// the controls were drawn for, one closed value per field and an intent. The
// caller and membership come from the server (the services); only the
// theme's own options are accepted; previewing never writes; resets act on
// the stored design and never change the theme.

const WEDDING_ID = "8d0f6b8e-0000-4000-8000-000000000001";
const copy = getMessages().site;
const PREVIEW = `/app/weddings/${WEDDING_ID}/site/preview`;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const editorialChoices = {
  weddingId: WEDDING_ID,
  theme: "editorial",
  palette: "parchment",
  typography: "mixed",
  headingScale: "display",
  hero: "editorial",
  width: "narrow",
  density: "regular",
  alignment: "center",
  sectionStyle: "editorial",
};

describe("saveCustomizationAction", () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    revalidatePath.mockReset();
    navigation.redirect.mockClear();
    requireUser.mockClear();
  });

  it("saves the theme and the chosen values through the one design write", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({
      ok: true,
      design: { themeKey: "editorial", customization: { palette: "parchment", typography: "mixed", density: "regular" } },
    });
    const state = await saveCustomizationAction(
      null,
      form({ ...editorialChoices, intent: "save", role: "owner", customization: '{"schemaVersion":1}', color: "#ff0000" }),
    );
    expect(requireUser).toHaveBeenCalledWith(`/app/weddings/${WEDDING_ID}/site`);
    // Every field the form sent, as a document; unknown form fields never reach it.
    expect(service.saveWeddingSiteDesign).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, "editorial", {
      schemaVersion: 1,
      palette: { kind: "preset", key: "parchment" },
      typography: { pairing: "mixed", headingScale: "display" },
      hero: { variant: "editorial" },
      layout: { width: "narrow", density: "regular", alignment: "center", sectionStyle: "editorial" },
    });
    for (const [name, fn] of Object.entries(service)) {
      if (name !== "saveWeddingSiteDesign") expect(fn, name).not.toHaveBeenCalled();
    }
    expect(state).toMatchObject({ ok: true, data: { message: "Guardamos la personalización de «Editorial»." } });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/weddings/${WEDDING_ID}/site`, "layout");
  });

  it("preview never writes: it opens the preview with closed values only (defaults left out)", async () => {
    await expect(saveCustomizationAction(null, form({ ...editorialChoices, intent: "preview" }))).rejects.toThrow(
      `NEXT_REDIRECT ${PREVIEW}?theme=editorial&customize=1&palette=parchment&typography=mixed&density=regular`,
    );
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["a palette of another theme", { palette: "rose" }],
    ["a hero the theme doesn't offer", { hero: "banner" }],
    ["a hex color", { palette: "#ff0000" }],
    ["CSS", { width: "url(https://x.test)" }],
    ["markup", { sectionStyle: "<script>" }],
  ])("%s is refused before any preview", async (_label, override) => {
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, ...override, intent: "preview" }));
    expect(state).toEqual({ ok: false, formError: copy.customize.invalid });
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("an invalid save is a fixed message", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: false, reason: "invalid" });
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, palette: "rose", intent: "save" }));
    expect(state).toEqual({ ok: false, formError: copy.customize.invalid });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([["palette"], ["typography"], ["hero"], ["layout"]] as const)("reset:%s resets that group of the stored design", async (group) => {
    service.resetWeddingSiteCustomization.mockResolvedValue({ ok: true, design: { themeKey: "editorial", customization: {} } });
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, intent: `reset:${group}` }));
    // Only the group: the form's other values play no part.
    expect(service.resetWeddingSiteCustomization).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, group);
    expect(service.saveWeddingSiteDesign).not.toHaveBeenCalled();
    expect(state).toMatchObject({ ok: true, data: { message: expect.stringContaining(copy.customize.groups[group]) } });
  });

  it("reset:all keeps the stored theme", async () => {
    service.resetWeddingSiteCustomization.mockResolvedValue({ ok: true, design: { themeKey: "tropical", customization: {} } });
    const state = await saveCustomizationAction(null, form({ weddingId: WEDDING_ID, theme: "tropical", intent: "reset:all" }));
    expect(service.resetWeddingSiteCustomization).toHaveBeenCalledExactlyOnceWith(userClient, WEDDING_ID, "all");
    expect(state).toMatchObject({ ok: true, data: { message: expect.stringContaining("«Tropical»") } });
    expect(service.saveWeddingSiteTheme).not.toHaveBeenCalled();
  });

  it.each([["delete"], ["reset:fonts"], ["reset"], [""], ["save:all"]])("an unknown intent %j does nothing", async (intent) => {
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, intent }));
    expect(state).toEqual({ ok: false, formError: copy.customize.invalid });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("an unknown theme does nothing", async () => {
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, theme: "neon", intent: "save" }));
    expect(state).toEqual({ ok: false, formError: copy.customize.invalid });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("an outsider gets the same 404 as a missing wedding", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(saveCustomizationAction(null, form({ ...editorialChoices, intent: "save" }))).rejects.toThrow("NEXT_NOT_FOUND");
    service.resetWeddingSiteCustomization.mockResolvedValue({ ok: false, reason: "not_found" });
    await expect(saveCustomizationAction(null, form({ ...editorialChoices, intent: "reset:all" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a signed-out caller is sent to log in before anything else", async () => {
    requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    await expect(saveCustomizationAction(null, form({ ...editorialChoices, intent: "save" }))).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("saveCustomizationAction: custom colors (CP7)", () => {
  const colors = {
    colorBackground: "#f3f7f6",
    colorSurface: "#ffffff",
    colorText: "#10201d",
    colorMuted: "#4a5b57",
    colorAccent: "#0f5c55",
    colorAccentText: "#ffffff",
  };
  const stored = { background: "#f3f7f6", surface: "#ffffff", text: "#10201d", muted: "#4a5b57", accent: "#0f5c55", accentText: "#ffffff" };

  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    navigation.redirect.mockClear();
  });

  it("palette=custom sends the six colors and no preset through the one design write", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: true, design: { themeKey: "editorial", customization: { colors: stored } } });
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, palette: "custom", ...colors, intent: "save" }));
    expect(state).toMatchObject({ ok: true });
    const [, , theme, document] = service.saveWeddingSiteDesign.mock.calls[0];
    expect(theme).toBe("editorial");
    expect(document).toMatchObject({ schemaVersion: 1, colors: stored });
    expect(document).not.toHaveProperty("palette");
  });

  it("an uppercase code is lowercased; nothing else is repaired", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: true, design: { themeKey: "editorial", customization: { colors: stored } } });
    await saveCustomizationAction(null, form({ ...editorialChoices, palette: "custom", ...colors, colorSurface: "#FFFFFF", intent: "save" }));
    expect(service.saveWeddingSiteDesign.mock.calls[0][3]).toMatchObject({ colors: stored });
  });

  it("choosing a preset ignores the color fields, so saving clears custom colors", async () => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: true, design: { themeKey: "editorial", customization: { palette: "parchment" } } });
    await saveCustomizationAction(null, form({ ...editorialChoices, ...colors, intent: "save" }));
    const document = service.saveWeddingSiteDesign.mock.calls[0][3];
    expect(document).toMatchObject({ palette: { kind: "preset", key: "parchment" } });
    expect(document).not.toHaveProperty("colors");
  });

  it.each([
    ["invalid_color", copy.customize.invalidColor],
    ["insufficient_contrast", copy.customize.insufficientContrast],
    ["invalid", copy.customize.invalid],
  ])("a %s refusal shows its own closed message", async (reason, message) => {
    service.saveWeddingSiteDesign.mockResolvedValue({ ok: false, reason });
    const state = await saveCustomizationAction(null, form({ ...editorialChoices, palette: "custom", ...colors, intent: "save" }));
    expect(state).toEqual({ ok: false, formError: message });
  });

  it("preview opens fixed color parameters and never writes", async () => {
    await expect(
      saveCustomizationAction(null, form({ ...editorialChoices, palette: "custom", ...colors, intent: "preview" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    const target = new URL(navigation.redirect.mock.calls[0][0] as string, "http://x.test");
    expect(target.pathname).toBe(PREVIEW);
    expect(target.searchParams.get("palette")).toBe("custom");
    for (const [name, value] of Object.entries(colors)) expect(target.searchParams.get(name)).toBe(value);
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed color", { colorText: " #10201d" }, copy.customize.invalidColor],
    ["a missing color", { colorMuted: "" }, copy.customize.invalidColor],
    ["CSS in a color", { colorAccent: "#000;background:url(x)" }, copy.customize.invalidColor],
    ["low contrast", { colorText: "#eeeeee" }, copy.customize.insufficientContrast],
  ])("%s is refused before any preview", async (_label, override, message) => {
    const state = await saveCustomizationAction(
      null,
      form({ ...editorialChoices, palette: "custom", ...colors, ...override, intent: "preview" }),
    );
    expect(state).toEqual({ ok: false, formError: message });
    expect(navigation.redirect).not.toHaveBeenCalled();
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("reset:colors resets the stored custom colors only", async () => {
    service.resetWeddingSiteCustomization.mockResolvedValue({ ok: true, design: { themeKey: "editorial", customization: {} } });
    const state = await saveCustomizationAction(null, form({ weddingId: WEDDING_ID, theme: "editorial", intent: "reset:colors" }));
    expect(service.resetWeddingSiteCustomization).toHaveBeenCalledWith(userClient, WEDDING_ID, "colors");
    expect(state).toMatchObject({ ok: true, data: { message: copy.customize.resetDone.replace("{group}", copy.customize.groups.colors) } });
  });
});
