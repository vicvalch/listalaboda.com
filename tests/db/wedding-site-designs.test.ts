import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/supabase/database.types";
import { contrastRatio, parseSiteColors, SITE_COLOR_ROLES, type SiteColors } from "@/lib/wedding-site/design/colors";
import { FIELD_LOCATION, MAX_CUSTOMIZATION_BYTES } from "@/lib/wedding-site/design/customization";
import {
  CUSTOMIZABLE_FIELDS,
  FIELD_VOCABULARY,
  THEME_REGISTRY,
  WEDDING_SITE_THEME_KEYS,
  type CustomizableField,
} from "@/lib/wedding-site/design/themes";
import { toPublishedSite } from "@/lib/wedding-site/sections";

import type { TestUserKey } from "./context";
import { PERMISSION_DENIED, addMember, as, createWedding as createFixtureWedding, sql } from "./support";

// ADR-019 CP4/CP6/CP7: the wedding website's design (theme and customization) —
// wedding_site_designs, its CHECK, save_wedding_site_design and the design in
// get_published_wedding_site — exercised as real anon and authenticated users
// through the Data API. The superuser connection only arranges fixtures,
// probes the private validator and reads ground truth.

type Actor = keyof typeof as;
type Theme = "classic" | "editorial" | "minimal" | "romantic" | "tropical";

const THEMES: Theme[] = ["classic", "editorial", "minimal", "romantic", "tropical"];
const RLS_VIOLATION = PERMISSION_DENIED;
const UNIQUE_VIOLATION = "23505";
const INVALID_TEXT = "22P02";
const NO_DATA_FOUND = "P0002";
const INVALID_PARAMETER = "22023";
const CHECK_VIOLATION = "23514";

const createdWeddings: string[] = [];
let slugCounter = 0;

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** Wedding A (ownerA + collabA) and wedding B (ownerB). */
async function twoWeddings() {
  const a = await fixtureWedding("ownerA", "Boda diseño A");
  await addMember(a, "collabA", "collaborator");
  const b = await fixtureWedding("ownerB", "Boda diseño B");
  return { a, b };
}

function saveDesign(actor: Actor, weddingId: string, theme: string, customization: unknown = {}) {
  return as[actor].rpc("save_wedding_site_design", {
    target_wedding_id: weddingId,
    new_theme: theme as Theme,
    new_customization: customization as Json,
  });
}

function designs(actor: Actor) {
  return as[actor].from("wedding_site_designs");
}

async function designRows(weddingId: string) {
  return sql<{ theme_key: Theme; customization: unknown; created_at: Date; updated_at: Date }>(
    "select theme_key, customization, created_at, updated_at from public.wedding_site_designs where wedding_id = $1",
    [weddingId],
  );
}

/** The private validator's verdict (superuser probe). */
async function isValid(theme: Theme, document: unknown): Promise<boolean> {
  const [row] = await sql<{ valid: boolean }>(
    "select private.wedding_site_customization_is_valid($1::public.wedding_site_theme, $2::jsonb) as valid",
    [theme, JSON.stringify(document)],
  );
  return row.valid;
}

const doc = (groups: Record<string, unknown>) => ({ schemaVersion: 1, ...groups });

function uniqueSlug(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}-${++slugCounter}`;
}

/** A wedding with one visible section and a slug; published unless asked otherwise. */
async function siteWedding(name: string, { publish = true } = {}) {
  const weddingId = await fixtureWedding("ownerA", name);
  const slug = uniqueSlug("diseno");
  expect(
    (
      await as.ownerA.rpc("save_wedding_site_section", {
        target_wedding_id: weddingId,
        section_kind: "intro",
        section_title: "",
        section_body: "Hola a todos",
        section_visible: true,
      })
    ).error,
  ).toBeNull();
  expect((await as.ownerA.rpc("set_wedding_site_slug", { target_wedding_id: weddingId, new_slug: slug })).error).toBeNull();
  if (publish) {
    expect((await as.ownerA.rpc("publish_wedding_site", { target_wedding_id: weddingId })).error).toBeNull();
  }
  return { weddingId, slug };
}

function publicSite(actor: Actor, slug: string) {
  return as[actor].rpc("get_published_wedding_site", { site_slug: slug });
}

/** A fingerprint of a wedding's content and publication rows (every column). */
async function contentAndPublicationHash(weddingId: string) {
  const rows = await sql<{ sections: string | null; publication: string | null }>(
    `select
       (select md5(string_agg(row_to_json(s)::text, '|' order by s.kind))
          from public.content_sections s where s.wedding_id = $1) as sections,
       (select md5(row_to_json(p)::text)
          from public.wedding_publications p where p.wedding_id = $1) as publication`,
    [weddingId],
  );
  return rows[0];
}

// ---------------------------------------------------------------- schema

describe("wedding site design schema", () => {
  it("holds only the wedding, the theme, the customization and timestamps", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'wedding_site_designs' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["wedding_id", "theme_key", "created_at", "updated_at", "customization"]);
    const theme = rows.find((r) => r.column_name === "theme_key");
    expect(theme).toMatchObject({ data_type: "USER-DEFINED", is_nullable: "NO", column_default: "'classic'::wedding_site_theme" });
    const customization = rows.find((r) => r.column_name === "customization");
    expect(customization).toMatchObject({ data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" });
    const checks = await sql<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.wedding_site_designs'::regclass and contype = 'c'`,
    );
    expect(checks).toEqual([
      {
        name: "wedding_site_designs_customization_valid",
        definition: "CHECK (private.wedding_site_customization_is_valid(theme_key, customization))",
      },
    ]);
  });

  it("themes are exactly the five curated keys, in order", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.wedding_site_theme'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(THEMES);
  });

  it("clients may write only the theme and customization (and the wedding on insert), never delete", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'wedding_site_designs'
         and grantee in ('anon', 'authenticated') order by 1, 2, 3`,
    );
    const columns = (privilege: string) =>
      rows.filter((r) => r.grantee === "authenticated" && r.privilege_type === privilege).map((r) => r.column_name);
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(columns("SELECT")).toEqual(["created_at", "customization", "theme_key", "updated_at", "wedding_id"]);
    expect(columns("INSERT")).toEqual(["customization", "theme_key", "wedding_id"]);
    expect(columns("UPDATE")).toEqual(["customization", "theme_key"]);
    const tableGrants = await sql(
      `select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'wedding_site_designs'
         and grantee in ('anon', 'authenticated') and privilege_type in ('DELETE', 'TRUNCATE')`,
    );
    expect(tableGrants).toEqual([]);
  });
});

// ------------------------------------------------------------- table RLS

describe("wedding_site_designs access", () => {
  it("owners and collaborators read, insert and update their wedding's design", async () => {
    for (const [actor, first, next] of [
      ["ownerA", "editorial", "minimal"],
      ["collabA", "romantic", "tropical"],
    ] as const) {
      const { a } = await twoWeddings();
      const inserted = await designs(actor).insert({ wedding_id: a, theme_key: first }).select("wedding_id, theme_key");
      expect(inserted.error, actor).toBeNull();
      expect(inserted.data, actor).toEqual([{ wedding_id: a, theme_key: first }]);

      const read = await designs(actor).select("theme_key").eq("wedding_id", a);
      expect(read.data, actor).toEqual([{ theme_key: first }]);

      const updated = await designs(actor).update({ theme_key: next }).eq("wedding_id", a).select("theme_key");
      expect(updated.error, actor).toBeNull();
      expect(updated.data, actor).toEqual([{ theme_key: next }]);
      expect((await designRows(a)).map((r) => r.theme_key), actor).toEqual([next]);
    }
  });

  it("outsiders can't read, insert or update a design", async () => {
    const { a } = await twoWeddings();
    expect((await saveDesign("ownerA", a, "editorial")).error).toBeNull();

    expect((await designs("outsider").select("theme_key").eq("wedding_id", a)).data).toEqual([]);
    const inserted = await designs("outsider").insert({ wedding_id: a, theme_key: "minimal" });
    expect(inserted.error?.code).toBe(RLS_VIOLATION);
    const updated = await designs("outsider").update({ theme_key: "minimal" }).eq("wedding_id", a).select("theme_key");
    expect(updated.data).toEqual([]);
    expect((await designRows(a)).map((r) => r.theme_key)).toEqual(["editorial"]);
  });

  it("a member of another wedding can't name this wedding's id", async () => {
    const { a, b } = await twoWeddings();
    // ownerB belongs to wedding B only.
    expect((await designs("ownerB").insert({ wedding_id: a, theme_key: "tropical" })).error?.code).toBe(RLS_VIOLATION);
    expect((await saveDesign("ownerB", a, "tropical")).error?.message).toBe("wedding_not_found");
    expect((await designs("ownerB").select("theme_key").eq("wedding_id", a)).data).toEqual([]);
    expect(await designRows(a)).toEqual([]);
    // Their own wedding works.
    expect((await saveDesign("ownerB", b, "tropical")).data).toBe("tropical");
  });

  it("anon has no access to the table at all", async () => {
    const { a } = await twoWeddings();
    expect((await designs("anon").select("theme_key")).error?.code).toBe(PERMISSION_DENIED);
    expect((await designs("anon").insert({ wedding_id: a, theme_key: "minimal" })).error?.code).toBe(PERMISSION_DENIED);
    expect((await designs("anon").update({ theme_key: "minimal" }).eq("wedding_id", a)).error?.code).toBe(PERMISSION_DENIED);
    expect(await designRows(a)).toEqual([]);
  });

  it("one row per wedding, valid themes only", async () => {
    const { a } = await twoWeddings();
    expect((await designs("ownerA").insert({ wedding_id: a, theme_key: "editorial" })).error).toBeNull();
    expect((await designs("collabA").insert({ wedding_id: a, theme_key: "minimal" })).error?.code).toBe(UNIQUE_VIOLATION);
    const invalid = await designs("ownerA")
      .update({ theme_key: "neon" as Theme })
      .eq("wedding_id", a);
    expect(invalid.error?.code).toBe(INVALID_TEXT);
    expect((await designRows(a)).map((r) => r.theme_key)).toEqual(["editorial"]);
  });

  it("no member can delete a design or move it to another wedding", async () => {
    const { a, b } = await twoWeddings();
    await addMember(b, "ownerA", "owner");
    expect((await saveDesign("ownerA", a, "romantic")).error).toBeNull();

    for (const actor of ["ownerA", "collabA"] as const) {
      expect((await designs(actor).delete().eq("wedding_id", a)).error?.code, actor).toBe(PERMISSION_DENIED);
    }
    // ownerA is a member of both weddings, and still can't move it.
    expect((await designs("ownerA").update({ wedding_id: b }).eq("wedding_id", a)).error?.code).toBe(PERMISSION_DENIED);
    expect((await designRows(a)).map((r) => r.theme_key)).toEqual(["romantic"]);
    expect(await designRows(b)).toEqual([]);
  });

  it("deleting the wedding deletes its design", async () => {
    const weddingId = await createFixtureWedding("ownerA", "Boda diseño borrada");
    expect((await saveDesign("ownerA", weddingId, "minimal")).error).toBeNull();
    await sql("delete from public.weddings where id = $1", [weddingId]);
    expect(await designRows(weddingId)).toEqual([]);
  });
});

// ------------------------------------------------------------------- RPC

describe("save_wedding_site_design", () => {
  it("members upsert: the first save inserts, later saves update the same row", async () => {
    const { a } = await twoWeddings();
    expect(await designRows(a)).toEqual([]);

    expect(await saveDesign("ownerA", a, "editorial")).toMatchObject({ data: "editorial", error: null });
    const [first] = await designRows(a);
    expect(first.theme_key).toBe("editorial");

    expect(await saveDesign("collabA", a, "tropical")).toMatchObject({ data: "tropical", error: null });
    // Back to the original look = choosing Classic (there is no delete).
    expect(await saveDesign("ownerA", a, "classic")).toMatchObject({ data: "classic", error: null });

    const rows = await designRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].theme_key).toBe("classic");
    expect(rows[0].created_at).toEqual(first.created_at);
    expect(rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(first.updated_at.getTime());
  });

  it("outsiders, unauthenticated callers and invalid themes write nothing", async () => {
    const { a } = await twoWeddings();
    expect(await saveDesign("outsider", a, "minimal")).toMatchObject({ data: null, error: { code: NO_DATA_FOUND, message: "wedding_not_found" } });
    expect((await saveDesign("anon", a, "minimal")).error?.code).toBe(PERMISSION_DENIED);
    expect((await saveDesign("ownerA", a, "neon")).error?.code).toBe(INVALID_TEXT);
    expect((await saveDesign("ownerA", "00000000-0000-4000-8000-000000000000", "minimal")).error?.message).toBe(
      "wedding_not_found",
    );
    expect(await designRows(a)).toEqual([]);
  });

  it("changing the theme never touches content, publication or activity", async () => {
    const { weddingId } = await siteWedding("Boda diseño intacta");
    const before = await contentAndPublicationHash(weddingId);
    const activity = async () =>
      (await sql<{ n: number }>("select count(*)::int as n from public.wedding_activity where wedding_id = $1", [weddingId]))[0].n;
    const activityBefore = await activity();

    for (const theme of THEMES) expect((await saveDesign("ownerA", weddingId, theme)).error).toBeNull();

    expect(await contentAndPublicationHash(weddingId)).toEqual(before);
    expect(await activity()).toBe(activityBefore);
  });

  it("a collaborator's theme change doesn't publish an unpublished site", async () => {
    const { weddingId, slug } = await siteWedding("Boda diseño sin publicar", { publish: false });
    await addMember(weddingId, "collabA", "collaborator");
    expect((await saveDesign("collabA", weddingId, "romantic")).error).toBeNull();
    expect((await publicSite("anon", slug)).data).toEqual([]);
    expect(await sql("select published_at from public.wedding_publications where wedding_id = $1", [weddingId])).toEqual([
      { published_at: null },
    ]);
  });
});

// ------------------------------------------------------ public projection

describe("theme in the public read", () => {
  it("no design row is Classic, and reading never writes one", async () => {
    const { weddingId, slug } = await siteWedding("Boda sin diseño");
    const { data, error } = await publicSite("anon", slug);
    expect(error).toBeNull();
    expect(data?.map((r) => r.site_theme)).toEqual(["classic"]);
    expect(await designRows(weddingId)).toEqual([]);
  });

  it("each saved theme is the public theme", async () => {
    const { weddingId, slug } = await siteWedding("Boda con diseño");
    for (const theme of THEMES) {
      expect((await saveDesign("ownerA", weddingId, theme)).error).toBeNull();
      const { data } = await publicSite("anon", slug);
      expect(data?.map((r) => r.site_theme), theme).toEqual([theme]);
    }
  });

  it("every row of a site carries the same theme, and the theme adds no rows", async () => {
    const { weddingId, slug } = await siteWedding("Boda varias secciones");
    for (const kind of ["ceremony", "faq"] as const) {
      await as.ownerA.rpc("save_wedding_site_section", {
        target_wedding_id: weddingId,
        section_kind: kind,
        section_title: "",
        section_body: `Texto ${kind}`,
        section_visible: true,
      });
    }
    const without = (await publicSite("anon", slug)).data ?? [];
    await saveDesign("ownerA", weddingId, "minimal");
    const withDesign = (await publicSite("anon", slug)).data ?? [];
    expect(withDesign).toHaveLength(without.length);
    expect(withDesign.map((r) => r.site_theme)).toEqual(["minimal", "minimal", "minimal"]);
    // Apart from the theme, the rows are exactly what they were.
    const content = (rows: typeof without) =>
      rows.map((r) => [r.wedding_name, r.wedding_date, r.wedding_city, r.section_kind, r.section_title, r.section_body]);
    expect(content(withDesign)).toEqual(content(without));
  });

  it("an unpublished site returns nothing, whatever its theme", async () => {
    const { weddingId, slug } = await siteWedding("Boda diseño privada", { publish: false });
    for (const theme of THEMES) {
      await saveDesign("ownerA", weddingId, theme);
      for (const actor of ["anon", "outsider", "ownerA"] as const) {
        expect((await publicSite(actor, slug)).data, `${theme} ${actor}`).toEqual([]);
      }
    }
    // Published, then unpublished again: nothing again.
    await as.ownerA.rpc("publish_wedding_site", { target_wedding_id: weddingId });
    expect((await publicSite("anon", slug)).data?.map((r) => r.site_theme)).toEqual(["tropical"]);
    await as.ownerA.rpc("unpublish_wedding_site", { target_wedding_id: weddingId });
    expect((await publicSite("anon", slug)).data).toEqual([]);
  });

  it("exposes only the theme key: no ids, timestamps or design metadata", async () => {
    const { weddingId, slug } = await siteWedding("Boda diseño segura");
    await saveDesign("ownerA", weddingId, "romantic");
    const [design] = await designRows(weddingId);
    const { data } = await publicSite("anon", slug);
    expect(Object.keys(data?.[0] ?? {}).sort()).toEqual([
      "section_body",
      "section_kind",
      "section_title",
      "site_customization",
      // UX-01B (ADR-022): public photos only (no ids of weddings, paths or sizes); tested in wedding-photos.test.ts.
      "site_photos",
      "site_theme",
      "wedding_city",
      "wedding_date",
      "wedding_name",
    ]);
    const payload = JSON.stringify(data);
    for (const secret of [
      weddingId,
      design.created_at.toISOString(),
      design.updated_at.toISOString(),
      "created_at",
      "updated_at",
      "wedding_id",
      "theme_key",
    ]) {
      expect(payload).not.toContain(secret);
    }
  });
});

// -------------------------------------------------------------- deploy skew

describe("deploy skew", () => {
  it("new database, old app: the pre-theme content shaping reads the new rows unchanged", async () => {
    // The app before CP4 passed the rows straight to toPublishedSite (unchanged
    // by CP4) and ignored any other column. The extra site_theme column must
    // not change the site it builds.
    const { weddingId, slug } = await siteWedding("Boda desfase");
    const before = (await publicSite("anon", slug)).data ?? [];
    await saveDesign("ownerA", weddingId, "editorial");
    const after = (await publicSite("anon", slug)).data ?? [];
    expect(after.map((r) => r.site_theme)).toEqual(["editorial"]);

    const withoutTheme = after.map((r) => ({
      wedding_name: r.wedding_name,
      wedding_date: r.wedding_date,
      wedding_city: r.wedding_city,
      section_kind: r.section_kind,
      section_title: r.section_title,
      section_body: r.section_body,
    }));
    expect(toPublishedSite(slug, after)).toEqual(toPublishedSite(slug, withoutTheme));
    expect(toPublishedSite(slug, after)).toEqual(toPublishedSite(slug, before));
  });
});

// ----------------------------------------------------- customization (CP6)

describe("customization validator", () => {
  it.each([
    ["empty {}", "editorial", {}],
    ["schemaVersion 1 only", "editorial", { schemaVersion: 1 }],
    ["one override", "editorial", doc({ palette: { kind: "preset", key: "parchment" } })],
    [
      "multiple overrides",
      "tropical",
      doc({
        palette: { kind: "preset", key: "sunset" },
        typography: { pairing: "serif", headingScale: "regular" },
        hero: { variant: "simple" },
        layout: { width: "wide", density: "airy", alignment: "center", sectionStyle: "plain" },
      }),
    ],
    ["a default value written explicitly", "minimal", doc({ layout: { alignment: "start" } })],
  ] as const)("accepts %s", async (_label, theme, document) => {
    expect(await isValid(theme, document)).toBe(true);
  });

  it("mirrors the theme registry exactly: every value of every field, for every theme", async () => {
    const probes: { theme: Theme; field: CustomizableField; value: string; document: string }[] = [];
    for (const theme of WEDDING_SITE_THEME_KEYS) {
      for (const field of CUSTOMIZABLE_FIELDS) {
        const { group, key } = FIELD_LOCATION[field];
        for (const value of FIELD_VOCABULARY[field]) {
          const body = group === "palette" ? { kind: "preset", key: value } : { [key]: value };
          probes.push({ theme, field, value, document: JSON.stringify(doc({ [group]: body })) });
        }
      }
    }
    const rows = await sql<{ ordinality: number; valid: boolean }>(
      `select p.ordinality::int, private.wedding_site_customization_is_valid(p.theme, p.document) as valid
       from unnest($1::public.wedding_site_theme[], $2::jsonb[]) with ordinality as p(theme, document, ordinality)
       order by p.ordinality`,
      [probes.map((p) => p.theme), probes.map((p) => p.document)],
    );
    expect(rows).toHaveLength(probes.length);
    const mismatches = rows
      .map((row, index) => ({ ...probes[index], valid: row.valid }))
      .filter(({ theme, field, value, valid }) =>
        valid !== (THEME_REGISTRY[theme].options[field] as readonly string[]).includes(value),
      )
      .map(({ theme, field, value, valid }) => `${theme} ${field}=${value} database=${valid}`);
    expect(mismatches).toEqual([]);
  });

  it.each([
    ["an unknown top-level key", "editorial", doc({ colors: { background: "red" } })],
    ["a wrong schemaVersion", "editorial", { schemaVersion: 2 }],
    ["schemaVersion as a string", "editorial", { schemaVersion: "1" }],
    ["a missing schemaVersion on a non-empty document", "editorial", { palette: { kind: "preset", key: "parchment" } }],
    ["an invalid palette key", "editorial", doc({ palette: { kind: "preset", key: "neon" } })],
    ["another theme's palette", "editorial", doc({ palette: { kind: "preset", key: "rose" } })],
    ["a palette without kind", "editorial", doc({ palette: { key: "parchment" } })],
    ["a palette of another kind", "editorial", doc({ palette: { kind: "custom", key: "parchment" } })],
    ["an invalid typography", "editorial", doc({ typography: { pairing: "comic" } })],
    ["an invalid hero for the theme", "minimal", doc({ hero: { variant: "framed" } })],
    ["an invalid layout value", "editorial", doc({ layout: { width: "full" } })],
    ["an extra nested key", "editorial", doc({ layout: { width: "regular", gap: "2rem" } })],
    ["an extra palette key", "editorial", doc({ palette: { kind: "preset", key: "parchment", hex: "#fff" } })],
    ["an empty group", "editorial", doc({ hero: {} })],
    ["an array instead of an object", "editorial", doc({ layout: ["regular"] })],
    ["a string instead of an object", "editorial", doc({ hero: "simple" })],
    ["null instead of an object", "editorial", doc({ hero: null })],
    ["null instead of a value", "editorial", doc({ hero: { variant: null } })],
    ["a number instead of a value", "editorial", doc({ layout: { width: 3 } })],
    ["an array document", "editorial", [doc({})]],
    ["a string document", "editorial", "{}"],
    ["a JSON null document", "editorial", null],
    ["oversized JSON", "editorial", doc({ layout: { width: "regular" }, pad: "x".repeat(1100) })],
    ["oversized JSON of valid-looking keys", "editorial", doc({ layout: { width: "regular".padEnd(1100, " ") } })],
    ["CSS-looking strings", "editorial", doc({ layout: { width: "max-width: 100vw; color: red" } })],
    ["url(...)", "editorial", doc({ layout: { sectionStyle: "url(https://evil.test/x.png)" } })],
    ["<script>", "editorial", doc({ hero: { variant: "<script>alert(1)</script>" } })],
    ["an arbitrary hex", "editorial", doc({ palette: { kind: "preset", key: "#ff00aa" } })],
  ] as const)("refuses %s", async (_label, theme, document) => {
    expect(await isValid(theme, document)).toBe(false);
  });

  it("is not callable through the Data API", async () => {
    for (const actor of ["anon", "ownerA"] as const) {
      const { error } = await (as[actor] as unknown as {
        rpc: (fn: string, args: object) => Promise<{ error: { code?: string } | null }>;
      }).rpc("wedding_site_customization_is_valid", { theme: "editorial", doc: {} });
      expect(error, actor).not.toBeNull();
    }
  });
});

describe("saving a customization", () => {
  const EDITORIAL = doc({ palette: { kind: "preset", key: "parchment" }, typography: { pairing: "mixed" }, layout: { density: "regular" } });

  it("owners and collaborators save theme + customization together", async () => {
    const { a } = await twoWeddings();
    expect(await saveDesign("ownerA", a, "editorial", EDITORIAL)).toMatchObject({ data: "editorial", error: null });
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([["editorial", EDITORIAL]]);

    const tropical = doc({ palette: { kind: "preset", key: "forest" } });
    expect(await saveDesign("collabA", a, "tropical", tropical)).toMatchObject({ data: "tropical", error: null });
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([["tropical", tropical]]);

    // Reset all: the theme stays, the customization is {}.
    expect(await saveDesign("collabA", a, "tropical", {})).toMatchObject({ data: "tropical", error: null });
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([["tropical", {}]]);
  });

  it("outsiders and anon can't save", async () => {
    const { a } = await twoWeddings();
    expect((await saveDesign("outsider", a, "editorial", EDITORIAL)).error?.message).toBe("wedding_not_found");
    expect((await saveDesign("ownerB", a, "editorial", EDITORIAL)).error?.message).toBe("wedding_not_found");
    expect((await saveDesign("anon", a, "editorial", EDITORIAL)).error?.code).toBe(PERMISSION_DENIED);
    const update = await designs("outsider").update({ customization: EDITORIAL as NonNullable<Json> }).eq("wedding_id", a).select("wedding_id");
    expect(update.data).toEqual([]);
    expect(await designRows(a)).toEqual([]);
  });

  it("an invalid customization is refused and writes nothing", async () => {
    const { a } = await twoWeddings();
    expect((await saveDesign("ownerA", a, "editorial", EDITORIAL)).error).toBeNull();
    for (const bad of [
      doc({ hero: { variant: "banner" } }),
      doc({ palette: { kind: "preset", key: "#ff0000" } }),
      { schemaVersion: 2 },
      [],
      "url(x)",
      null,
    ]) {
      const { error } = await saveDesign("ownerA", a, "editorial", bad);
      expect(error?.code, JSON.stringify(bad)).toBe(INVALID_PARAMETER);
    }
    // A theme that doesn't offer the stored choices is refused with them.
    expect((await saveDesign("ownerA", a, "minimal", EDITORIAL)).error?.code).toBe(INVALID_PARAMETER);
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([["editorial", EDITORIAL]]);
  });

  it("the CHECK holds for direct table writes too, including a theme change that leaves an invalid override", async () => {
    const { a } = await twoWeddings();
    const inserted = await designs("collabA").insert({
      wedding_id: a,
      theme_key: "editorial",
      customization: doc({ hero: { variant: "banner" } }) as NonNullable<Json>,
    });
    expect(inserted.error?.code).toBe(CHECK_VIOLATION);
    expect((await saveDesign("collabA", a, "editorial", doc({ hero: { variant: "framed" } }))).error).toBeNull();
    // Minimal has no framed hero: changing only the theme is refused.
    expect((await designs("ownerA").update({ theme_key: "minimal" }).eq("wedding_id", a)).error?.code).toBe(CHECK_VIOLATION);
    expect((await designs("ownerA").update({ customization: "<script>" as NonNullable<Json> }).eq("wedding_id", a)).error?.code).toBe(
      CHECK_VIOLATION,
    );
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([
      ["editorial", doc({ hero: { variant: "framed" } })],
    ]);
    // Normalized together, the change is accepted.
    expect((await designs("ownerA").update({ theme_key: "minimal", customization: {} }).eq("wedding_id", a)).error).toBeNull();
  });

  it("existing rows (CP4) are valid with no customization", async () => {
    const { a } = await twoWeddings();
    expect((await designs("ownerA").insert({ wedding_id: a, theme_key: "romantic" })).error).toBeNull();
    expect((await designRows(a)).map((r) => r.customization)).toEqual([{}]);
  });

  it("saving never alters content, publication or activity, and never publishes", async () => {
    const { weddingId, slug } = await siteWedding("Boda personalizada sin publicar", { publish: false });
    await addMember(weddingId, "collabA", "collaborator");
    const before = await contentAndPublicationHash(weddingId);
    const counts = async () =>
      (
        await sql<{ activity: number; guests: number; parties: number; rsvps: number }>(
          `select (select count(*)::int from public.wedding_activity where wedding_id = $1) as activity,
                  (select count(*)::int from public.guests where wedding_id = $1) as guests,
                  (select count(*)::int from public.guest_invitations where wedding_id = $1) as parties,
                  (select count(*)::int from public.rsvps where wedding_id = $1) as rsvps`,
          [weddingId],
        )
      )[0];
    const countsBefore = await counts();

    for (const [actor, theme, document] of [
      ["collabA", "editorial", EDITORIAL],
      ["ownerA", "romantic", doc({ palette: { kind: "preset", key: "wine" }, hero: { variant: "simple" } })],
      ["collabA", "romantic", {}],
    ] as const) {
      expect((await saveDesign(actor, weddingId, theme, document)).error).toBeNull();
    }

    expect(await contentAndPublicationHash(weddingId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
    expect((await publicSite("anon", slug)).data).toEqual([]);
    expect(await sql("select published_at from public.wedding_publications where wedding_id = $1", [weddingId])).toEqual([
      { published_at: null },
    ]);
  });
});

describe("customization in the public read", () => {
  it("no design row is {}; the saved customization is returned under the publication gate", async () => {
    const { weddingId, slug } = await siteWedding("Boda personalizada publicada");
    expect((await publicSite("anon", slug)).data?.map((r) => r.site_customization)).toEqual([{}]);

    const document = doc({ palette: { kind: "preset", key: "charcoal" }, layout: { width: "regular" } });
    expect((await saveDesign("ownerA", weddingId, "editorial", document)).error).toBeNull();
    const { data } = await publicSite("anon", slug);
    expect(data?.map((r) => [r.site_theme, r.site_customization])).toEqual([["editorial", document]]);

    await as.ownerA.rpc("unpublish_wedding_site", { target_wedding_id: weddingId });
    expect((await publicSite("anon", slug)).data).toEqual([]);
  });

  it("an unpublished wedding returns nothing, whatever its customization", async () => {
    const { weddingId, slug } = await siteWedding("Boda personalizada privada", { publish: false });
    expect((await saveDesign("ownerA", weddingId, "tropical", doc({ palette: { kind: "preset", key: "sunset" } }))).error).toBeNull();
    for (const actor of ["anon", "outsider", "ownerA"] as const) {
      expect((await publicSite(actor, slug)).data, actor).toEqual([]);
    }
  });
});

// ------------------------------------------------------------ custom colors

describe("custom colors validator (CP7)", () => {
  const COLORS: SiteColors = {
    background: "#f3f7f6",
    surface: "#ffffff",
    text: "#10201d",
    muted: "#4a5b57",
    accent: "#0f5c55",
    accentText: "#ffffff",
  };
  const withColor = (role: string, value: unknown) => doc({ colors: { ...COLORS, [role]: value } });

  /** The validator's verdicts for many documents, in one round trip. */
  async function verdicts(theme: Theme, documents: unknown[]): Promise<boolean[]> {
    const rows = await sql<{ valid: boolean }>(
      `select private.wedding_site_customization_is_valid($1::public.wedding_site_theme, d.value) as valid
         from jsonb_array_elements($2::jsonb) with ordinality as d(value, n)
        order by d.n`,
      [theme, JSON.stringify(documents)],
    );
    return rows.map((row) => row.valid);
  }

  it.each(THEMES)("%s accepts a complete accessible palette, and a preset or no colors as before", async (theme) => {
    expect(await isValid(theme, doc({ colors: COLORS }))).toBe(true);
    expect(await isValid(theme, doc({ colors: COLORS, typography: { headingScale: "regular" } }))).toBe(true);
    expect(await isValid(theme, doc({ palette: { kind: "preset", key: THEME_REGISTRY[theme].options.palette[1] } }))).toBe(true);
    expect(await isValid(theme, {})).toBe(true);
  });

  it.each([
    ["3-digit hex", withColor("text", "#111")],
    ["8-digit hex", withColor("text", "#111111ff")],
    ["uppercase hex", withColor("background", "#F3F7F6")],
    ["no #", withColor("background", "f3f7f6")],
    ["whitespace", withColor("background", " #f3f7f6")],
    ["a trailing newline", withColor("background", "#f3f7f\n")],
    ["a newline injection", withColor("background", "#f3f7f6\n;x:y")],
    ["a named color", withColor("accent", "teal")],
    ["rgb()", withColor("accent", "rgb(15,92,85)")],
    ["var()", withColor("accent", "var(--x)")],
    ["url()", withColor("accent", "url(x)")],
    ["expression()", withColor("accent", "expression(1)")],
    ["<script>", withColor("accent", "<script>")],
    ["javascript:", withColor("accent", "javascript:x")],
    ["a declaration break-out", withColor("accent", '";background:red')],
    ["a number", withColor("accent", 1)],
    ["null", withColor("accent", null)],
    ["an object", withColor("accent", { hex: "#0f5c55" })],
    ["an array", withColor("accent", ["#0f5c55"])],
    ["non-hex letters", withColor("accent", "#0g5c55")],
    ["an extra role", doc({ colors: { ...COLORS, border: "#cccccc" } })],
    ["a partial palette", doc({ colors: { background: "#ffffff", text: "#000000" } })],
    ["an empty group", doc({ colors: {} })],
    ["a non-object group", doc({ colors: "#ffffff" })],
    ["a preset and colors together", doc({ palette: { kind: "preset", key: "parchment" }, colors: COLORS })],
    ["text vs background", withColor("text", "#8a9a96")],
    ["muted vs surface", withColor("muted", "#9aa8a4")],
    ["accent vs background", withColor("accent", "#7fb5ad")],
    ["accentText vs accent", withColor("accentText", "#2a6a63")],
    ["the largest-looking oversized document", doc({ colors: COLORS, pad: "x".repeat(MAX_CUSTOMIZATION_BYTES) })],
  ])("refuses %s", async (_label, document) => {
    expect(await isValid("editorial", document)).toBe(false);
  });

  it("enforces 4.5:1 at the boundary exactly as the application does", async () => {
    // #767676 on white is 4.54:1 (passes); #777777 is 4.48:1 (fails).
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    const gray = (muted: string) => doc({ colors: { ...COLORS, background: "#ffffff", surface: "#ffffff", muted } });
    expect(await verdicts("editorial", [gray("#767676"), gray("#777777")])).toEqual([true, false]);
  });

  it("agrees with the application parser on thousands of palettes (same formula, pairs and threshold)", async () => {
    // A deterministic generator biased toward borderline contrast.
    let seed = 20261024;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const channel = (low: number, high: number) => Math.floor(low + next() * (high - low + 1));
    const hex = (low: number, high: number) =>
      `#${[0, 1, 2].map(() => channel(low, high).toString(16).padStart(2, "0")).join("")}`;
    const palettes = Array.from({ length: 3000 }, () => ({
      background: hex(200, 255),
      surface: hex(200, 255),
      text: hex(0, 90),
      muted: hex(60, 130),
      accent: hex(30, 130),
      accentText: next() < 0.5 ? hex(200, 255) : hex(0, 60),
    }));
    const app = palettes.map((colors) => parseSiteColors(colors).ok);
    const database = await verdicts("tropical", palettes.map((colors) => doc({ colors })));
    expect(database).toEqual(app);
    // Both outcomes are well represented.
    expect(app.filter(Boolean).length).toBeGreaterThan(300);
    expect(app.filter((ok) => !ok).length).toBeGreaterThan(300);
  });

  it("validates the roles the application defines, and no others", () => {
    expect([...SITE_COLOR_ROLES].sort()).toEqual(["accent", "accentText", "background", "muted", "surface", "text"]);
  });

  it("is still not callable through the Data API, and keeps its privileges", async () => {
    for (const actor of ["anon", "ownerA"] as const) {
      const { error } = await (as[actor] as unknown as {
        rpc: (fn: string, args: object) => Promise<{ error: { code?: string } | null }>;
      }).rpc("wedding_site_customization_is_valid", { theme: "editorial", doc: doc({ colors: COLORS }) });
      expect(error, actor).not.toBeNull();
    }
    const [row] = await sql<{ anon: boolean; authenticated: boolean; volatility: string }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              p.provolatile as volatility
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'wedding_site_customization_is_valid'`,
    );
    expect(row).toEqual({ anon: false, authenticated: true, volatility: "i" });
  });
});

describe("saving custom colors (CP7)", () => {
  const COLORS = { background: "#1d1b2e", surface: "#2a2740", text: "#f4f1ff", muted: "#c3bddb", accent: "#f2c46d", accentText: "#1d1b2e" };
  const CUSTOM = doc({ colors: COLORS, layout: { width: "regular" } });

  it("owners and collaborators save; outsiders and anon can't", async () => {
    const { a } = await twoWeddings();
    expect(await saveDesign("collabA", a, "editorial", CUSTOM)).toMatchObject({ data: "editorial", error: null });
    expect((await designRows(a)).map((r) => [r.theme_key, r.customization])).toEqual([["editorial", CUSTOM]]);
    const preset = doc({ palette: { kind: "preset", key: "parchment" } });
    expect(await saveDesign("ownerA", a, "editorial", preset)).toMatchObject({ error: null });

    expect((await saveDesign("outsider", a, "editorial", CUSTOM)).error?.message).toBe("wedding_not_found");
    expect((await saveDesign("ownerB", a, "editorial", CUSTOM)).error?.message).toBe("wedding_not_found");
    expect((await saveDesign("anon", a, "editorial", CUSTOM)).error?.code).toBe(PERMISSION_DENIED);
    const update = await designs("outsider").update({ customization: CUSTOM as NonNullable<Json> }).eq("wedding_id", a).select("wedding_id");
    expect(update.data).toEqual([]);
    expect((await designRows(a)).map((r) => r.customization)).toEqual([preset]);
  });

  it("refuses malformed and low-contrast palettes through the RPC and direct writes alike", async () => {
    const { a } = await twoWeddings();
    expect((await saveDesign("ownerA", a, "minimal", CUSTOM)).error).toBeNull();
    const lowContrast = doc({ colors: { ...COLORS, muted: "#4a4766" } });
    const malformed = doc({ colors: { ...COLORS, accent: "#F2C46D" } });
    for (const bad of [lowContrast, malformed, doc({ colors: { background: "#000000" } })]) {
      expect((await saveDesign("ownerA", a, "minimal", bad)).error?.code, JSON.stringify(bad)).toBe(INVALID_PARAMETER);
      // A member's direct table write is refused by the CHECK.
      expect((await designs("collabA").update({ customization: bad as NonNullable<Json> }).eq("wedding_id", a)).error?.code).toBe(
        CHECK_VIOLATION,
      );
    }
    expect((await designRows(a)).map((r) => r.customization)).toEqual([CUSTOM]);
  });

  it("a theme change keeps valid custom colors (every theme accepts them)", async () => {
    const { a } = await twoWeddings();
    expect((await saveDesign("ownerA", a, "classic", doc({ colors: COLORS }))).error).toBeNull();
    for (const theme of THEMES) {
      expect((await designs("ownerA").update({ theme_key: theme }).eq("wedding_id", a)).error, theme).toBeNull();
    }
  });

  it("saving changes only the design: no content, publication, activity or guest change, never publishes", async () => {
    const { weddingId, slug } = await siteWedding("Boda colores sin publicar", { publish: false });
    await addMember(weddingId, "collabA", "collaborator");
    const before = await contentAndPublicationHash(weddingId);
    const counts = async () =>
      (
        await sql<{ activity: number; guests: number; parties: number; rsvps: number }>(
          `select (select count(*)::int from public.wedding_activity where wedding_id = $1) as activity,
                  (select count(*)::int from public.guests where wedding_id = $1) as guests,
                  (select count(*)::int from public.guest_invitations where wedding_id = $1) as parties,
                  (select count(*)::int from public.rsvps where wedding_id = $1) as rsvps`,
          [weddingId],
        )
      )[0];
    const countsBefore = await counts();
    expect((await saveDesign("collabA", weddingId, "romantic", CUSTOM)).error).toBeNull();
    expect((await saveDesign("ownerA", weddingId, "romantic", doc({ layout: { width: "regular" } }))).error).toBeNull();
    expect(await contentAndPublicationHash(weddingId)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
    expect((await publicSite("anon", slug)).data).toEqual([]);
  });

  it("the public read returns the stored colors under the unchanged publication gate", async () => {
    const { weddingId, slug } = await siteWedding("Boda colores publicada");
    expect((await saveDesign("ownerA", weddingId, "tropical", CUSTOM)).error).toBeNull();
    expect((await publicSite("anon", slug)).data?.map((r) => [r.site_theme, r.site_customization])).toEqual([["tropical", CUSTOM]]);
    await as.ownerA.rpc("unpublish_wedding_site", { target_wedding_id: weddingId });
    expect((await publicSite("anon", slug)).data).toEqual([]);
  });
});
