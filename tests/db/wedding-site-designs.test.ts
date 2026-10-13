import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { toPublishedSite } from "@/lib/wedding-site/sections";

import type { TestUserKey } from "./context";
import { PERMISSION_DENIED, addMember, as, createWedding as createFixtureWedding, sql } from "./support";

// ADR-019 CP4: the wedding website's design (theme) — wedding_site_designs,
// save_wedding_site_design and the theme in get_published_wedding_site —
// exercised as real anon and authenticated users through the Data API. The
// superuser connection only arranges fixtures and reads ground truth.

type Actor = keyof typeof as;
type Theme = "classic" | "editorial" | "minimal" | "romantic" | "tropical";

const THEMES: Theme[] = ["classic", "editorial", "minimal", "romantic", "tropical"];
const RLS_VIOLATION = PERMISSION_DENIED;
const UNIQUE_VIOLATION = "23505";
const INVALID_TEXT = "22P02";
const NO_DATA_FOUND = "P0002";

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

function saveDesign(actor: Actor, weddingId: string, theme: string) {
  return as[actor].rpc("save_wedding_site_design", {
    target_wedding_id: weddingId,
    new_theme: theme as Theme,
  });
}

function designs(actor: Actor) {
  return as[actor].from("wedding_site_designs");
}

async function designRows(weddingId: string) {
  return sql<{ theme_key: Theme; created_at: Date; updated_at: Date }>(
    "select theme_key, created_at, updated_at from public.wedding_site_designs where wedding_id = $1",
    [weddingId],
  );
}

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
  it("holds only the wedding, the theme and timestamps", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'wedding_site_designs' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["wedding_id", "theme_key", "created_at", "updated_at"]);
    const theme = rows.find((r) => r.column_name === "theme_key");
    expect(theme).toMatchObject({ data_type: "USER-DEFINED", is_nullable: "NO", column_default: "'classic'::wedding_site_theme" });
  });

  it("themes are exactly the five curated keys, in order", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.wedding_site_theme'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(THEMES);
  });

  it("clients may write only the theme (and the wedding on insert), never delete", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'wedding_site_designs'
         and grantee in ('anon', 'authenticated') order by 1, 2, 3`,
    );
    const columns = (privilege: string) =>
      rows.filter((r) => r.grantee === "authenticated" && r.privilege_type === privilege).map((r) => r.column_name);
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(columns("SELECT")).toEqual(["created_at", "theme_key", "updated_at", "wedding_id"]);
    expect(columns("INSERT")).toEqual(["theme_key", "wedding_id"]);
    expect(columns("UPDATE")).toEqual(["theme_key"]);
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
