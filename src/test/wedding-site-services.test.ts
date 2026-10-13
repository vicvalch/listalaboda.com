import { createHash } from "node:crypto";

import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

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
const { getGuestPartySiteSlug } = await import("@/lib/rsvp/service");

// Application-layer tests: a real supabase-js client against a fake HTTP
// backend, asserting exactly what is sent and how failures are normalized.
// RLS, the publication functions and the public read boundary are tested
// against local Supabase in tests/db/wedding-site*.test.ts.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  noSession?: boolean;
  /** Keyed by "METHOD /path". */
  replies?: Record<string, Reply>;
  networkDown?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStorage(): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>([
    [
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    ],
  ]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function clientFor(backend: Backend) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    const key = `${method} ${url.pathname}`;

    if (url.pathname === "/auth/v1/user") {
      if (backend.noSession) return json({ message: "invalid JWT" }, 401);
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (key === "GET /rest/v1/wedding_memberships") {
      return json(backend.role ? [{ id: MY_MEMBERSHIP, role: backend.role }] : []);
    }
    if (backend.networkDown === key) throw new TypeError("network down");
    const reply = backend.replies?.[key];
    if (reply) return json(reply.body, reply.status);
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}

const rpcCalls = (requests: Recorded[]) => requests.filter((r) => r.url.pathname.startsWith("/rest/v1/rpc/"));

const pgError = (code: string, message: string): Reply => ({ status: 400, body: { code, message } });

const intro = { kind: "intro" as const, title: null, body: "Hola", isVisible: true };

// ---------------------------------------------------------------- sections

describe("saveContentSection", () => {
  it("any member saves by (authorized wedding, kind); no role, user or row id is sent", async () => {
    for (const role of ["owner", "collaborator"] as const) {
      const { supabase, requests } = clientFor({
        role,
        replies: { "POST /rest/v1/rpc/save_wedding_site_section": { status: 200, body: null } },
      });
      expect(await saveContentSection(supabase, WEDDING_ID, { ...intro, title: "Hola" })).toEqual({ ok: true });
      expect(rpcCalls(requests).map((r) => r.body)).toEqual([
        {
          target_wedding_id: WEDDING_ID,
          section_kind: "intro",
          section_title: "Hola",
          section_body: "Hola",
          section_visible: true,
        },
      ]);
    }
  });

  it("sends empty strings for 'none' (stored as null)", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: { "POST /rest/v1/rpc/save_wedding_site_section": { status: 200, body: null } },
    });
    await saveContentSection(supabase, WEDDING_ID, { kind: "rsvp", title: null, body: null, isVisible: false });
    expect(rpcCalls(requests)[0]?.body).toMatchObject({ section_title: "", section_body: "" });
  });

  it("non-members, malformed ids and missing sessions write nothing", async () => {
    const outsider = clientFor({ role: null });
    expect(await saveContentSection(outsider.supabase, WEDDING_ID, intro)).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(outsider.requests)).toEqual([]);
    const malformed = clientFor({ role: "owner" });
    expect(await saveContentSection(malformed.supabase, "../other", intro)).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(malformed.requests)).toEqual([]);
    const signedOut = clientFor({ noSession: true });
    expect(await saveContentSection(signedOut.supabase, WEDDING_ID, intro)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("normalizes database failures", async () => {
    const cases: [Reply | "down", string][] = [
      [pgError("23514", 'new row violates check constraint "content_sections_body_valid"'), "invalid"],
      [pgError("42501", "new row violates row-level security policy"), "not_found"],
      [pgError("XX000", "boom"), "error"],
      ["down", "error"],
    ];
    for (const [reply, reason] of cases) {
      const { supabase } = clientFor({
        role: "collaborator",
        ...(reply === "down"
          ? { networkDown: "POST /rest/v1/rpc/save_wedding_site_section" }
          : { replies: { "POST /rest/v1/rpc/save_wedding_site_section": reply } }),
      });
      expect(await saveContentSection(supabase, WEDDING_ID, intro)).toEqual({ ok: false, reason });
    }
  });
});

// ------------------------------------------------------------------ design

const DESIGN_READ = "GET /rest/v1/wedding_site_designs";
const DESIGN_SAVE = "POST /rest/v1/rpc/save_wedding_site_design";

describe("saveWeddingSiteTheme", () => {
  it("any member saves by authorized wedding: the wedding id, the theme and the carried-over customization", async () => {
    for (const role of ["owner", "collaborator"] as const) {
      const { supabase, requests } = clientFor({
        role,
        replies: {
          [DESIGN_READ]: { status: 200, body: null },
          [DESIGN_SAVE]: { status: 200, body: "romantic" },
        },
      });
      expect(await saveWeddingSiteTheme(supabase, WEDDING_ID, "romantic")).toEqual({
        ok: true,
        themeKey: "romantic",
        dropped: [],
      });
      expect(rpcCalls(requests).map((r) => r.body)).toEqual([
        { target_wedding_id: WEDDING_ID, new_theme: "romantic", new_customization: {} },
      ]);
    }
  });

  it("keeps the overrides the new theme offers and drops (and reports) the rest", async () => {
    // Romantic with a framed hero is the default; this Romantic has an
    // editorial hero, the wine palette, regular density and plain sections.
    const stored = {
      theme_key: "romantic",
      customization: {
        schemaVersion: 1,
        palette: { kind: "preset", key: "wine" },
        hero: { variant: "editorial" },
        typography: { pairing: "serif" },
        layout: { density: "regular", sectionStyle: "plain" },
      },
    };
    const { supabase, requests } = clientFor({
      role: "collaborator",
      replies: { [DESIGN_READ]: { status: 200, body: stored }, [DESIGN_SAVE]: { status: 200, body: "minimal" } },
    });
    const result = await saveWeddingSiteTheme(supabase, WEDDING_ID, "minimal");
    // Minimal offers neither the wine palette nor an editorial hero.
    expect(result).toEqual({ ok: true, themeKey: "minimal", dropped: ["palette", "hero"] });
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([
      {
        target_wedding_id: WEDDING_ID,
        new_theme: "minimal",
        new_customization: {
          schemaVersion: 1,
          typography: { pairing: "serif" },
          layout: { density: "regular", sectionStyle: "plain" },
        },
      },
    ]);
  });

  it("non-members, malformed ids and missing sessions write nothing", async () => {
    const outsider = clientFor({ role: null });
    expect(await saveWeddingSiteTheme(outsider.supabase, WEDDING_ID, "minimal")).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(outsider.requests)).toEqual([]);
    const malformed = clientFor({ role: "owner" });
    expect(await saveWeddingSiteTheme(malformed.supabase, "../other", "minimal")).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(malformed.requests)).toEqual([]);
    const signedOut = clientFor({ noSession: true });
    expect(await saveWeddingSiteTheme(signedOut.supabase, WEDDING_ID, "minimal")).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("a failed read of the current design writes nothing", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: { [DESIGN_READ]: { status: 500, body: { message: "boom" } } },
    });
    expect(await saveWeddingSiteTheme(supabase, WEDDING_ID, "minimal")).toEqual({ ok: false, reason: "error" });
    expect(rpcCalls(requests)).toEqual([]);
  });

  it("normalizes database failures", async () => {
    const cases: [Reply | "down", string][] = [
      [pgError("22P02", 'invalid input value for enum wedding_site_theme: "neon"'), "invalid"],
      [pgError("22023", "wedding_site_theme_required"), "invalid"],
      [pgError("22023", "wedding_site_customization_invalid"), "invalid"],
      [pgError("23514", "new row violates check constraint"), "invalid"],
      [pgError("P0002", "wedding_not_found"), "not_found"],
      [pgError("42501", "new row violates row-level security policy"), "not_found"],
      [pgError("XX000", "boom"), "error"],
      ["down", "error"],
    ];
    for (const [reply, reason] of cases) {
      const { supabase } = clientFor({
        role: "collaborator",
        ...(reply === "down"
          ? { networkDown: DESIGN_SAVE, replies: { [DESIGN_READ]: { status: 200, body: null } } }
          : { replies: { [DESIGN_READ]: { status: 200, body: null }, [DESIGN_SAVE]: reply } }),
      });
      expect(await saveWeddingSiteTheme(supabase, WEDDING_ID, "editorial")).toEqual({ ok: false, reason });
    }
  });
});

describe("saveWeddingSiteDesign", () => {
  it("sends the theme and the normalized document (defaults dropped, overrides only)", async () => {
    const { supabase, requests } = clientFor({
      role: "collaborator",
      replies: { [DESIGN_SAVE]: { status: 200, body: "editorial" } },
    });
    const document = {
      schemaVersion: 1,
      palette: { kind: "preset", key: "parchment" },
      // Editorial's default density: not an override, so not stored.
      layout: { density: "airy", width: "regular" },
    };
    expect(await saveWeddingSiteDesign(supabase, WEDDING_ID, "editorial", document)).toEqual({
      ok: true,
      design: { themeKey: "editorial", customization: { palette: "parchment", width: "regular" } },
    });
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([
      {
        target_wedding_id: WEDDING_ID,
        new_theme: "editorial",
        new_customization: { schemaVersion: 1, palette: { kind: "preset", key: "parchment" }, layout: { width: "regular" } },
      },
    ]);
  });

  it.each([
    ["a palette of another theme", { schemaVersion: 1, palette: { kind: "preset", key: "rose" } }],
    ["a hero the theme doesn't offer", { schemaVersion: 1, hero: { variant: "banner" } }],
    ["an unknown group", { schemaVersion: 1, colors: { background: "#ff0000" } }],
    ["a wrong version", { schemaVersion: 2 }],
    ["CSS in a value", { schemaVersion: 1, layout: { width: "url(https://x.test)" } }],
  ])("%s never reaches the database", async (_label, document) => {
    const { supabase, requests } = clientFor({ role: "owner", replies: { [DESIGN_SAVE]: { status: 200, body: "editorial" } } });
    expect(await saveWeddingSiteDesign(supabase, WEDDING_ID, "editorial", document)).toEqual({ ok: false, reason: "invalid" });
    expect(rpcCalls(requests)).toEqual([]);
  });

  it("non-members write nothing", async () => {
    const { supabase, requests } = clientFor({ role: null });
    expect(await saveWeddingSiteDesign(supabase, WEDDING_ID, "editorial", {})).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(requests)).toEqual([]);
  });
});

describe("resetWeddingSiteCustomization", () => {
  const stored = {
    theme_key: "tropical",
    customization: {
      schemaVersion: 1,
      palette: { kind: "preset", key: "sunset" },
      layout: { density: "airy" },
    },
  };

  it("resets one group of the stored design and keeps its theme", async () => {
    const { supabase, requests } = clientFor({
      role: "collaborator",
      replies: { [DESIGN_READ]: { status: 200, body: stored }, [DESIGN_SAVE]: { status: 200, body: "tropical" } },
    });
    expect(await resetWeddingSiteCustomization(supabase, WEDDING_ID, "palette")).toEqual({
      ok: true,
      design: { themeKey: "tropical", customization: { density: "airy" } },
    });
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([
      { target_wedding_id: WEDDING_ID, new_theme: "tropical", new_customization: { schemaVersion: 1, layout: { density: "airy" } } },
    ]);
  });

  it("reset all keeps the theme (never Classic) and stores {}", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: { [DESIGN_READ]: { status: 200, body: stored }, [DESIGN_SAVE]: { status: 200, body: "tropical" } },
    });
    expect(await resetWeddingSiteCustomization(supabase, WEDDING_ID, "all")).toEqual({
      ok: true,
      design: { themeKey: "tropical", customization: {} },
    });
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([
      { target_wedding_id: WEDDING_ID, new_theme: "tropical", new_customization: {} },
    ]);
  });
});

// ------------------------------------------------------------- publication

describe("owner-only publication", () => {
  it("collaborators are refused before any publication call", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator" });
    expect(await setWeddingSiteSlug(supabase, WEDDING_ID, "ana-y-luis")).toEqual({ ok: false, reason: "forbidden" });
    expect(await publishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: false, reason: "forbidden" });
    expect(await unpublishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: false, reason: "forbidden" });
    expect(rpcCalls(requests)).toEqual([]);
  });

  it("non-members get not_found and nothing is called", async () => {
    const { supabase, requests } = clientFor({ role: null });
    expect(await setWeddingSiteSlug(supabase, WEDDING_ID, "ana-y-luis")).toEqual({ ok: false, reason: "not_found" });
    expect(await publishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: false, reason: "not_found" });
    expect(await unpublishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: false, reason: "not_found" });
    expect(rpcCalls(requests)).toEqual([]);
  });

  it("owners send only the wedding id (and slug); never a role or timestamp", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: {
        "POST /rest/v1/rpc/set_wedding_site_slug": { status: 200, body: "ana-y-luis" },
        "POST /rest/v1/rpc/publish_wedding_site": { status: 200, body: "2090-01-01T00:00:00Z" },
        "POST /rest/v1/rpc/unpublish_wedding_site": { status: 200, body: null },
      },
    });
    expect(await setWeddingSiteSlug(supabase, WEDDING_ID, "ana-y-luis")).toEqual({ ok: true, slug: "ana-y-luis" });
    expect(await publishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: true });
    expect(await unpublishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: true });
    expect(rpcCalls(requests).map((r) => [r.url.pathname, r.body])).toEqual([
      ["/rest/v1/rpc/set_wedding_site_slug", { target_wedding_id: WEDDING_ID, new_slug: "ana-y-luis" }],
      ["/rest/v1/rpc/publish_wedding_site", { target_wedding_id: WEDDING_ID }],
      ["/rest/v1/rpc/unpublish_wedding_site", { target_wedding_id: WEDDING_ID }],
    ]);
  });

  it("an invalid slug never reaches the database", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    for (const slug of ["Ana", "rsvp", "a--b", ""]) {
      expect(await setWeddingSiteSlug(supabase, WEDDING_ID, slug)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(rpcCalls(requests)).toEqual([]);
  });

  it("maps slug conflicts and database refusals", async () => {
    const cases: [Reply, string][] = [
      [pgError("23505", 'duplicate key value violates unique constraint "wedding_publications_slug_key"'), "already_used"],
      [pgError("23514", "check constraint"), "invalid"],
      [pgError("42501", "site_publication_owner_only"), "forbidden"],
      [pgError("P0002", "wedding_not_found"), "not_found"],
      [pgError("XX000", "boom"), "error"],
    ];
    for (const [reply, reason] of cases) {
      const { supabase } = clientFor({ role: "owner", replies: { "POST /rest/v1/rpc/set_wedding_site_slug": reply } });
      expect(await setWeddingSiteSlug(supabase, WEDDING_ID, "ana-y-luis")).toEqual({ ok: false, reason });
    }
  });

  it("maps publish preconditions and races", async () => {
    const cases: [Reply, string][] = [
      [pgError("P0001", "wedding_site_slug_required"), "slug_required"],
      [pgError("P0001", "wedding_site_empty"), "empty"],
      [pgError("42501", "site_publication_owner_only"), "forbidden"],
      [pgError("P0002", "wedding_not_found"), "not_found"],
    ];
    for (const [reply, reason] of cases) {
      const { supabase } = clientFor({ role: "owner", replies: { "POST /rest/v1/rpc/publish_wedding_site": reply } });
      expect(await publishWeddingSite(supabase, WEDDING_ID)).toEqual({ ok: false, reason });
    }
    const down = clientFor({ role: "owner", networkDown: "POST /rest/v1/rpc/unpublish_wedding_site" });
    expect(await unpublishWeddingSite(down.supabase, WEDDING_ID)).toEqual({ ok: false, reason: "error" });
  });
});

// ------------------------------------------------------------------ editor

describe("getWeddingSiteEditor", () => {
  const access = { weddingId: WEDDING_ID, userId: USER_ID, membershipId: MY_MEMBERSHIP, role: "collaborator" as const };

  it("loads publication, sections and design in three bounded reads", async () => {
    const { supabase, requests } = clientFor({
      replies: {
        "GET /rest/v1/wedding_publications": { status: 200, body: { slug: "ana-y-luis", published_at: null } },
        "GET /rest/v1/content_sections": {
          status: 200,
          body: [{ kind: "faq", title: null, body: "Preguntas", is_visible: true }],
        },
        "GET /rest/v1/wedding_site_designs": {
          status: 200,
          body: { theme_key: "romantic", customization: { schemaVersion: 1, palette: { kind: "preset", key: "wine" } } },
        },
      },
    });
    const editor = await getWeddingSiteEditor(supabase, access);
    expect(editor?.publication).toEqual({ slug: "ana-y-luis", publishedAt: null });
    expect(editor?.sections).toHaveLength(7);
    expect(editor?.sections[5]).toEqual({ kind: "faq", title: null, body: "Preguntas", isVisible: true });
    expect(editor?.design).toEqual({ themeKey: "romantic", customization: { palette: "wine" } });
    const reads = requests.filter((r) => r.url.pathname.startsWith("/rest/v1/"));
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.method).toBe("GET");
      expect(read.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    }
    expect(reads.find((r) => r.url.pathname.endsWith("/wedding_site_designs"))?.url.searchParams.get("select")).toBe(
      "theme_key,customization",
    );
  });

  it.each([
    ["no design row", null],
    ["an unknown stored value", { theme_key: "neon" }],
    ["an unknown theme with a customization", { theme_key: "neon", customization: { schemaVersion: 1, palette: { kind: "preset", key: "wine" } } }],
    ["a malformed customization", { theme_key: "classic", customization: "<script>" }],
  ])("%s is uncustomized Classic, and reading writes nothing", async (_label, body) => {
    const { supabase, requests } = clientFor({
      replies: {
        "GET /rest/v1/wedding_publications": { status: 200, body: null },
        "GET /rest/v1/content_sections": { status: 200, body: [] },
        "GET /rest/v1/wedding_site_designs": { status: 200, body },
      },
    });
    const editor = await getWeddingSiteEditor(supabase, access);
    expect(editor?.design).toEqual({ themeKey: "classic", customization: {} });
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("a failed design read fails the editor (never a silent Classic)", async () => {
    const { supabase } = clientFor({
      replies: {
        "GET /rest/v1/wedding_publications": { status: 200, body: null },
        "GET /rest/v1/content_sections": { status: 200, body: [] },
        "GET /rest/v1/wedding_site_designs": { status: 500, body: { message: "boom" } },
      },
    });
    expect(await getWeddingSiteEditor(supabase, access)).toBeNull();
  });

  it("returns null on failure", async () => {
    const { supabase } = clientFor({
      replies: { "GET /rest/v1/wedding_publications": { status: 200, body: null } },
    });
    expect(await getWeddingSiteEditor(supabase, access)).toBeNull();
  });
});

// ------------------------------------------------------------------ public

describe("getPublishedWeddingSite", () => {
  it("malformed slugs never reach the database", async () => {
    const { supabase, requests } = clientFor({});
    for (const slug of ["", "Ana", "../app", "a".repeat(81), "rsvp"]) {
      expect(await getPublishedWeddingSite(supabase, slug)).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(requests.filter((r) => r.url.pathname.startsWith("/rest/"))).toEqual([]);
  });

  it("sends only the slug and shapes the safe DTO (a reply without a theme is Classic)", async () => {
    const { supabase, requests } = clientFor({
      replies: {
        "POST /rest/v1/rpc/get_published_wedding_site": {
          status: 200,
          body: [
            {
              wedding_name: "Boda de prueba",
              wedding_date: null,
              wedding_city: "Ciudad",
              section_kind: "intro",
              section_title: null,
              section_body: "Hola",
            },
          ],
        },
      },
    });
    expect(await getPublishedWeddingSite(supabase, "ana-y-luis")).toEqual({
      ok: true,
      site: {
        slug: "ana-y-luis",
        name: "Boda de prueba",
        weddingDate: null,
        city: "Ciudad",
        sections: [{ kind: "intro", title: "Bienvenidos", body: "Hola" }],
      },
      // The reply above is the pre-theme row shape (no site_theme): what a
      // database without the CP4 migration returns. It reads as Classic.
      design: { themeKey: "classic", customization: {} },
    });
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([{ site_slug: "ana-y-luis" }]);
  });

  it("returns the chosen theme next to the content, never inside it; anything unknown is Classic", async () => {
    const row = {
      wedding_name: "Boda de prueba",
      wedding_date: null,
      wedding_city: null,
      section_kind: "intro",
      section_title: null,
      section_body: "Hola",
    };
    const cases: [unknown, string][] = [
      ["classic", "classic"],
      ["editorial", "editorial"],
      ["minimal", "minimal"],
      ["romantic", "romantic"],
      ["tropical", "tropical"],
      [null, "classic"],
      ["neon", "classic"],
      ["Romantic", "classic"],
      ["__proto__", "classic"],
      [42, "classic"],
    ];
    for (const [siteTheme, themeKey] of cases) {
      const { supabase } = clientFor({
        replies: {
          "POST /rest/v1/rpc/get_published_wedding_site": { status: 200, body: [{ ...row, site_theme: siteTheme }] },
        },
      });
      const result = await getPublishedWeddingSite(supabase, "ana-y-luis");
      expect(result.ok && result.design, String(siteTheme)).toEqual({ themeKey, customization: {} });
      expect(result.ok && Object.keys(result.site).sort(), String(siteTheme)).toEqual([
        "city",
        "name",
        "sections",
        "slug",
        "weddingDate",
      ]);
    }
  });

  it("returns the customization re-read against the theme: invalid fields fall back, junk is ignored", async () => {
    const row = {
      wedding_name: "Boda de prueba",
      wedding_date: null,
      wedding_city: null,
      section_kind: "intro",
      section_title: null,
      section_body: "Hola",
      site_theme: "editorial",
    };
    const cases: [unknown, object][] = [
      [{ schemaVersion: 1, palette: { kind: "preset", key: "parchment" }, layout: { width: "regular" } }, { palette: "parchment", width: "regular" }],
      // Field by field: the unknown values fall back, the valid one stays.
      [{ schemaVersion: 1, palette: { kind: "preset", key: "rose" }, layout: { width: "regular", density: "url(x)" } }, { width: "regular" }],
      [{ schemaVersion: 2, palette: { kind: "preset", key: "parchment" } }, {}],
      ["{\"schemaVersion\":1}", {}],
      [[{ schemaVersion: 1 }], {}],
      [null, {}],
      [undefined, {}],
    ];
    for (const [customization, expected] of cases) {
      const { supabase } = clientFor({
        replies: {
          "POST /rest/v1/rpc/get_published_wedding_site": {
            status: 200,
            body: [{ ...row, ...(customization === undefined ? {} : { site_customization: customization }) }],
          },
        },
      });
      const result = await getPublishedWeddingSite(supabase, "ana-y-luis");
      expect(result.ok && result.design, JSON.stringify(customization)).toEqual({ themeKey: "editorial", customization: expected });
    }
  });

  it("no rows is unavailable; failures are errors", async () => {
    const empty = clientFor({
      replies: { "POST /rest/v1/rpc/get_published_wedding_site": { status: 200, body: [] } },
    });
    expect(await getPublishedWeddingSite(empty.supabase, "ana-y-luis")).toEqual({ ok: false, reason: "unavailable" });
    const broken = clientFor({ networkDown: "POST /rest/v1/rpc/get_published_wedding_site" });
    expect(await getPublishedWeddingSite(broken.supabase, "ana-y-luis")).toEqual({ ok: false, reason: "error" });
  });
});

// ------------------------------------------------------------ RSVP context

describe("getGuestPartySiteSlug", () => {
  it("sends only the token hash; a malformed token is never sent", async () => {
    const { supabase, requests } = clientFor({
      replies: { "POST /rest/v1/rpc/get_guest_invitation_site_slug": { status: 200, body: "ana-y-luis" } },
    });
    expect(await getGuestPartySiteSlug(supabase, TOKEN)).toBe("ana-y-luis");
    expect(rpcCalls(requests).map((r) => r.body)).toEqual([{ invitation_token_hash: TOKEN_HASH }]);
    expect(JSON.stringify(requests.map((r) => [r.url.toString(), r.body]))).not.toContain(TOKEN);

    expect(await getGuestPartySiteSlug(supabase, "short")).toBeNull();
    expect(rpcCalls(requests)).toHaveLength(1);
  });

  it("unpublished, unusable links and errors are all null", async () => {
    const none = clientFor({
      replies: { "POST /rest/v1/rpc/get_guest_invitation_site_slug": { status: 200, body: null } },
    });
    expect(await getGuestPartySiteSlug(none.supabase, TOKEN)).toBeNull();
    const down = clientFor({ networkDown: "POST /rest/v1/rpc/get_guest_invitation_site_slug" });
    expect(await getGuestPartySiteSlug(down.supabase, TOKEN)).toBeNull();
  });
});
