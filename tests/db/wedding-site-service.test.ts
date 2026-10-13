import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
/** LB-13: the server's (fake, test-only) link-encryption key. */
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const {
  getWeddingSiteEditor,
  publishWeddingSite,
  resetWeddingSiteCustomization,
  saveContentSection,
  saveWeddingSiteDesign,
  saveWeddingSiteTheme,
  setWeddingSiteSlug,
  unpublishWeddingSite,
} = await import("@/lib/wedding-site/service");
const { getPublishedWeddingSite } = await import("@/lib/wedding-site/public");
const { toPreviewSite } = await import("@/lib/wedding-site/preview");
const { getWeddingDetail } = await import("@/lib/weddings/service");
const { createGuestParty } = await import("@/lib/guests/service");
const { getGuestPartyByToken, getGuestPartySiteSlug } = await import("@/lib/rsvp/service");

// LB-10 services (what the Server Actions and public pages call) against the
// real local stack: organizer identity from the real Auth server, authority
// from real memberships, RLS and the publication functions underneath; the
// public as a plain anon client.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

async function sessionClient(user: TestUserKey) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return supabase;
}

function anonClient() {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function uniqueSlug(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

async function editorOf(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  const editor = await getWeddingSiteEditor(supabase, access.access);
  if (!editor) throw new Error("editor failed to load");
  return editor;
}

const section = (
  kind: "intro" | "ceremony" | "reception" | "schedule" | "dress_code" | "faq" | "rsvp",
  body: string | null,
  isVisible = true,
  title: string | null = null,
) => ({ kind, title, body, isVisible });

describe("organizer site services", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda servicio sitio");
    await addMember(wedding, "collabA", "collaborator");
  });

  it("a new wedding's editor has seven blank hidden sections and no address", async () => {
    const editor = await editorOf("ownerA", wedding);
    expect(editor.publication).toBeNull();
    expect(editor.sections.map((s) => [s.kind, s.title, s.body, s.isVisible])).toEqual([
      ["intro", null, null, false],
      ["ceremony", null, null, false],
      ["reception", null, null, false],
      ["schedule", null, null, false],
      ["dress_code", null, null, false],
      ["faq", null, null, false],
      ["rsvp", null, null, false],
    ]);
    // Opening the editor writes nothing.
    expect(await sql("select 1 from public.content_sections where wedding_id = $1", [wedding])).toEqual([]);
  });

  it("owners and collaborators both edit content; each sees the other's work", async () => {
    const owner = await sessionClient("ownerA");
    const collab = await sessionClient("collabA");
    expect(await saveContentSection(owner, wedding, section("intro", "Bienvenidos", true, "Hola"))).toEqual({ ok: true });
    expect(await saveContentSection(collab, wedding, section("schedule", "17:00 Ceremonia\n19:00 Cena"))).toEqual({
      ok: true,
    });
    const seen = await editorOf("ownerA", wedding);
    expect(seen.sections.find((s) => s.kind === "schedule")).toEqual({
      kind: "schedule",
      title: null,
      body: "17:00 Ceremonia\n19:00 Cena",
      isVisible: true,
    });
    expect((await editorOf("collabA", wedding)).sections[0]).toEqual({
      kind: "intro",
      title: "Hola",
      body: "Bienvenidos",
      isVisible: true,
    });
  });

  it("collaborators can't set the address, publish or unpublish (forbidden), and nothing changes", async () => {
    const collab = await sessionClient("collabA");
    const slug = uniqueSlug("colabora");
    expect(await setWeddingSiteSlug(collab, wedding, slug)).toEqual({ ok: false, reason: "forbidden" });
    expect(await publishWeddingSite(collab, wedding)).toEqual({ ok: false, reason: "forbidden" });
    expect(await unpublishWeddingSite(collab, wedding)).toEqual({ ok: false, reason: "forbidden" });
    expect((await editorOf("collabA", wedding)).publication).toBeNull();
  });

  it("outsiders and malformed ids get not_found everywhere", async () => {
    const outsider = await sessionClient("outsider");
    for (const id of [wedding, "not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      expect(await saveContentSection(outsider, id, section("intro", "x"))).toEqual({ ok: false, reason: "not_found" });
      expect(await setWeddingSiteSlug(outsider, id, uniqueSlug("fuera"))).toEqual({ ok: false, reason: "not_found" });
      expect(await publishWeddingSite(outsider, id)).toEqual({ ok: false, reason: "not_found" });
      expect(await unpublishWeddingSite(outsider, id)).toEqual({ ok: false, reason: "not_found" });
    }
    expect(await saveContentSection(anonClient(), wedding, section("intro", "x"))).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("owner flow: address, publish, unpublish, republish; failures are explicit", async () => {
    const owner = await sessionClient("ownerA");
    const fresh = await fixtureWedding("ownerA", "Boda flujo dueño");
    expect(await publishWeddingSite(owner, fresh)).toEqual({ ok: false, reason: "slug_required" });
    const slug = uniqueSlug("flujo");
    expect(await setWeddingSiteSlug(owner, fresh, slug)).toEqual({ ok: true, slug });
    expect(await publishWeddingSite(owner, fresh)).toEqual({ ok: false, reason: "empty" });
    expect(await saveContentSection(owner, fresh, section("rsvp", null))).toEqual({ ok: true });
    expect(await publishWeddingSite(owner, fresh)).toEqual({ ok: true });
    expect((await editorOf("ownerA", fresh)).publication).toMatchObject({ slug, publishedAt: expect.any(String) });

    expect(await unpublishWeddingSite(owner, fresh)).toEqual({ ok: true });
    expect((await editorOf("ownerA", fresh)).publication).toEqual({ slug, publishedAt: null });
    expect(await publishWeddingSite(owner, fresh)).toEqual({ ok: true });
  });

  it("a slug taken by another wedding is already_used; invalid ones never reach the database", async () => {
    const other = await fixtureWedding("ownerB", "Boda con dirección");
    const slug = uniqueSlug("tomada");
    expect(await setWeddingSiteSlug(await sessionClient("ownerB"), other, slug)).toEqual({ ok: true, slug });
    const owner = await sessionClient("ownerA");
    expect(await setWeddingSiteSlug(owner, wedding, slug)).toEqual({ ok: false, reason: "already_used" });
    for (const bad of ["Ana-y-Luis", "rsvp", "a", " ana "]) {
      expect(await setWeddingSiteSlug(owner, wedding, bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("a visible section without content is refused (invalid) by the database too", async () => {
    const owner = await sessionClient("ownerA");
    expect(await saveContentSection(owner, wedding, section("faq", null, true))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("theme selector and preview data (ADR-019 CP5)", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda servicio estilo");
    await addMember(wedding, "collabA", "collaborator");
    const owner = await sessionClient("ownerA");
    await saveContentSection(owner, wedding, section("intro", "Bienvenidos al estilo"));
    await saveContentSection(owner, wedding, section("ceremony", "Ceremonia oculta", false));
    await saveContentSection(owner, wedding, section("rsvp", null));
  });

  /** Everything a theme save must leave alone, as one comparable value. */
  const untouched = async (id: string) =>
    sql(
      `select (select md5(coalesce(string_agg(t::text, '|' order by t.kind), '')) from public.content_sections t where t.wedding_id = $1) as content,
              (select md5(coalesce(string_agg(p::text, '|'), '')) from public.wedding_publications p where p.wedding_id = $1) as publication,
              (select md5(coalesce(string_agg(w::text, '|'), '')) from public.weddings w where w.id = $1) as wedding`,
      [id],
    );
  const designRows = (id: string) =>
    sql<{ theme_key: string }>("select theme_key from public.wedding_site_designs where wedding_id = $1", [id]);

  it("no design row: both members' editors show Classic, and reading writes none", async () => {
    expect((await editorOf("ownerA", wedding)).design).toEqual({ themeKey: "classic", customization: {} });
    expect((await editorOf("collabA", wedding)).design).toEqual({ themeKey: "classic", customization: {} });
    expect(await designRows(wedding)).toEqual([]);
  });

  it("owner and collaborator save; the editor shows it; only the theme changes and nothing publishes", async () => {
    const before = await untouched(wedding);
    expect(await saveWeddingSiteTheme(await sessionClient("ownerA"), wedding, "editorial")).toEqual({
      ok: true,
      themeKey: "editorial",
      dropped: [],
    });
    expect((await editorOf("collabA", wedding)).design).toEqual({ themeKey: "editorial", customization: {} });
    expect(await saveWeddingSiteTheme(await sessionClient("collabA"), wedding, "romantic")).toEqual({
      ok: true,
      themeKey: "romantic",
      dropped: [],
    });
    expect((await editorOf("ownerA", wedding)).design).toEqual({ themeKey: "romantic", customization: {} });
    expect(await designRows(wedding)).toEqual([{ theme_key: "romantic" }]);
    expect(await untouched(wedding)).toEqual(before);
    expect((await editorOf("ownerA", wedding)).publication).toBeNull();
    // Back to Classic.
    expect(await saveWeddingSiteTheme(await sessionClient("collabA"), wedding, "classic")).toMatchObject({ ok: true });
    expect((await editorOf("ownerA", wedding)).design).toEqual({ themeKey: "classic", customization: {} });
  });

  it("customization (CP6): saved with the theme, carried over on a theme change minus what the new theme lacks, reset by group or all", async () => {
    const before = await untouched(wedding);
    const collab = await sessionClient("collabA");
    const document = {
      schemaVersion: 1,
      palette: { kind: "preset", key: "wine" },
      typography: { pairing: "serif" },
      hero: { variant: "editorial" },
      layout: { density: "regular", sectionStyle: "plain" },
    };
    expect(await saveWeddingSiteDesign(collab, wedding, "romantic", document)).toEqual({
      ok: true,
      design: {
        themeKey: "romantic",
        customization: { palette: "wine", typography: "serif", hero: "editorial", density: "regular", sectionStyle: "plain" },
      },
    });
    expect((await editorOf("ownerA", wedding)).design.customization).toMatchObject({ palette: "wine", hero: "editorial" });

    // Romantic → Minimal: no wine palette, no editorial hero there.
    expect(await saveWeddingSiteTheme(await sessionClient("ownerA"), wedding, "minimal")).toEqual({
      ok: true,
      themeKey: "minimal",
      dropped: ["palette", "hero"],
    });
    const stored = await sql<{ theme_key: string; customization: unknown }>(
      "select theme_key, customization from public.wedding_site_designs where wedding_id = $1",
      [wedding],
    );
    expect(stored).toEqual([
      {
        theme_key: "minimal",
        customization: { schemaVersion: 1, typography: { pairing: "serif" }, layout: { density: "regular", sectionStyle: "plain" } },
      },
    ]);

    expect(await resetWeddingSiteCustomization(collab, wedding, "typography")).toEqual({
      ok: true,
      design: { themeKey: "minimal", customization: { density: "regular", sectionStyle: "plain" } },
    });
    expect(await resetWeddingSiteCustomization(collab, wedding, "all")).toEqual({
      ok: true,
      design: { themeKey: "minimal", customization: {} },
    });
    expect(await designRows(wedding)).toEqual([{ theme_key: "minimal" }]);
    expect(await untouched(wedding)).toEqual(before);

    // An outsider can neither save nor reset.
    const outsider = await sessionClient("outsider");
    expect(await saveWeddingSiteDesign(outsider, wedding, "minimal", {})).toEqual({ ok: false, reason: "not_found" });
    expect(await resetWeddingSiteCustomization(outsider, wedding, "all")).toEqual({ ok: false, reason: "not_found" });
    await saveWeddingSiteTheme(collab, wedding, "classic");
  });

  it("outsiders, anon and forged keys are refused and write nothing", async () => {
    const before = await designRows(wedding);
    expect(await saveWeddingSiteTheme(await sessionClient("outsider"), wedding, "minimal")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await requireWeddingMembership(await sessionClient("outsider"), wedding)).toMatchObject({ ok: false });
    expect(await saveWeddingSiteTheme(anonClient(), wedding, "minimal")).toEqual({ ok: false, reason: "unauthenticated" });
    const forged = "neon" as unknown as "minimal";
    expect(await saveWeddingSiteTheme(await sessionClient("ownerA"), wedding, forged)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await designRows(wedding)).toEqual(before);
  });

  it("the preview data equals the published page's, before and after publishing, and never shows hidden sections", async () => {
    const owner = await sessionClient("ownerA");
    const access = await requireWeddingMembership(owner, wedding);
    if (!access.ok) throw new Error("no access");
    const detail = await getWeddingDetail(owner, wedding);
    if (!detail) throw new Error("no wedding");
    const slug = uniqueSlug("vista");
    expect(await setWeddingSiteSlug(owner, wedding, slug)).toEqual({ ok: true, slug });

    // Unpublished: the member still previews; the public sees nothing.
    const unpublished = toPreviewSite(detail, (await editorOf("collabA", wedding)).sections, slug);
    expect(unpublished.sections.map((s) => s.kind)).toEqual(["intro", "rsvp"]);
    expect(JSON.stringify(unpublished)).not.toContain("Ceremonia oculta");
    expect(await getPublishedWeddingSite(anonClient(), slug)).toEqual({ ok: false, reason: "unavailable" });

    await saveWeddingSiteTheme(owner, wedding, "tropical");
    expect(await publishWeddingSite(owner, wedding)).toEqual({ ok: true });
    const editor = await editorOf("collabA", wedding);
    const published = await getPublishedWeddingSite(anonClient(), slug);
    expect(published).toEqual({ ok: true, site: toPreviewSite(detail, editor.sections, slug), design: editor.design });
    expect(published).toMatchObject({ design: { themeKey: "tropical" } });
  });
});

describe("public site service", () => {
  it("published: safe DTO with defaults, canonical order, no hidden sections", async () => {
    const owner = await sessionClient("ownerA");
    const wedding = await fixtureWedding("ownerA", "Boda pública servicio");
    await sql("update public.weddings set wedding_date = '2090-03-04', time_zone = 'Europe/Madrid' where id = $1", [
      wedding,
    ]);
    const slug = uniqueSlug("publica");
    await saveContentSection(owner, wedding, section("faq", "¿Niños?\nSí, bienvenidos."));
    await saveContentSection(owner, wedding, section("intro", "Los esperamos"));
    await saveContentSection(owner, wedding, section("dress_code", "Oculto", false));
    await saveContentSection(owner, wedding, section("rsvp", null));
    await setWeddingSiteSlug(owner, wedding, slug);
    await publishWeddingSite(owner, wedding);

    const result = await getPublishedWeddingSite(anonClient(), slug);
    expect(result).toEqual({
      ok: true,
      site: {
        slug,
        name: "Boda pública servicio",
        weddingDate: "2090-03-04",
        city: null,
        sections: [
          { kind: "intro", title: "Bienvenidos", body: "Los esperamos" },
          { kind: "faq", title: "Preguntas frecuentes", body: "¿Niños?\nSí, bienvenidos." },
          {
            kind: "rsvp",
            title: "Confirmación de asistencia",
            body: "Para confirmar asistencia, usa el enlace personal que recibiste con tu invitación.",
          },
        ],
      },
      // No design row: Classic (ADR-019 CP4), uncustomized (CP6).
      design: { themeKey: "classic", customization: {} },
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(wedding);
    expect(payload).not.toContain("Europe/Madrid");
    expect(payload).not.toContain("Oculto");

    await unpublishWeddingSite(owner, wedding);
    expect(await getPublishedWeddingSite(anonClient(), slug)).toEqual({ ok: false, reason: "unavailable" });
    // A signed-in member of the wedding gets nothing more than anon.
    expect(await getPublishedWeddingSite(owner, slug)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a blank visible RSVP shows only the product default; a custom RSVP text replaces it", async () => {
    const owner = await sessionClient("ownerA");
    const wedding = await fixtureWedding("ownerA", "Boda RSVP pública");
    const slug = uniqueSlug("rsvp-publica");
    expect(await saveContentSection(owner, wedding, section("rsvp", null))).toEqual({ ok: true });
    await setWeddingSiteSlug(owner, wedding, slug);
    await publishWeddingSite(owner, wedding);

    const blank = await getPublishedWeddingSite(anonClient(), slug);
    expect(blank.ok && blank.site.sections).toEqual([
      {
        kind: "rsvp",
        title: "Confirmación de asistencia",
        body: "Para confirmar asistencia, usa el enlace personal que recibiste con tu invitación.",
      },
    ]);
    // The default is applied when read, never written.
    expect(
      await sql("select body from public.content_sections where wedding_id = $1 and kind = 'rsvp'", [wedding]),
    ).toEqual([{ body: null }]);

    await saveContentSection(owner, wedding, section("rsvp", "Confirma antes del 1 de mayo con tu enlace personal."));
    const custom = await getPublishedWeddingSite(anonClient(), slug);
    expect(custom.ok && custom.site.sections).toEqual([
      { kind: "rsvp", title: "Confirmación de asistencia", body: "Confirma antes del 1 de mayo con tu enlace personal." },
    ]);
  });

  it("missing and malformed slugs are unavailable", async () => {
    for (const slug of [uniqueSlug("no-existe"), "NO", "../app", ""]) {
      expect(await getPublishedWeddingSite(anonClient(), slug)).toEqual({ ok: false, reason: "unavailable" });
    }
  });
});

describe("RSVP page context", () => {
  it("a guest link yields the site slug only while published; the link keeps working either way", async () => {
    const owner = await sessionClient("ownerA");
    const wedding = await fixtureWedding("ownerA", "Boda RSVP con sitio");
    const slug = uniqueSlug("rsvp-sitio");
    await saveContentSection(owner, wedding, section("intro", "Hola"));
    await setWeddingSiteSlug(owner, wedding, slug);
    const party = await createGuestParty(owner, wedding, { label: "Familia Prueba", guestNames: ["Uno"] }, "http://localhost:3100", ENCRYPTION);
    if (!party.ok) throw new Error("party failed");
    const token = party.link.split("/").pop() ?? "";

    expect(await getGuestPartySiteSlug(anonClient(), token)).toBeNull();
    await publishWeddingSite(owner, wedding);
    expect(await getGuestPartySiteSlug(anonClient(), token)).toBe(slug);
    await unpublishWeddingSite(owner, wedding);
    expect(await getGuestPartySiteSlug(anonClient(), token)).toBeNull();
    expect((await getGuestPartyByToken(anonClient(), token)).ok).toBe(true);

    expect(await getGuestPartySiteSlug(anonClient(), "not-a-token")).toBeNull();
  });
});
