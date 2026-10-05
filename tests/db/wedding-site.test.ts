import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  sql,
  shapedEnvelope,
} from "./support";

// LB-10: the wedding website — ContentSection, explicit owner-only
// publication and the public read boundary — exercised as real anon and
// authenticated users through the Data API. The superuser connection only
// arranges fixtures and reads ground truth.

type Kind = "intro" | "ceremony" | "reception" | "schedule" | "dress_code" | "faq" | "rsvp";
type Actor = keyof typeof as;

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
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

/** A slug unique to this run, so reruns never collide with leftovers. */
function uniqueSlug(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}-${++slugCounter}`;
}

function save(
  actor: Actor,
  weddingId: string,
  kind: Kind,
  fields: { title?: string; body?: string; visible?: boolean },
) {
  return as[actor].rpc("save_wedding_site_section", {
    target_wedding_id: weddingId,
    section_kind: kind,
    section_title: fields.title ?? "",
    section_body: fields.body ?? "",
    section_visible: fields.visible ?? false,
  });
}

function setSlug(actor: Actor, weddingId: string, slug: string) {
  return as[actor].rpc("set_wedding_site_slug", { target_wedding_id: weddingId, new_slug: slug });
}

function publish(actor: Actor, weddingId: string) {
  return as[actor].rpc("publish_wedding_site", { target_wedding_id: weddingId });
}

function unpublish(actor: Actor, weddingId: string) {
  return as[actor].rpc("unpublish_wedding_site", { target_wedding_id: weddingId });
}

function publicSite(actor: Actor, slug: string) {
  return as[actor].rpc("get_published_wedding_site", { site_slug: slug });
}

async function publicationRow(weddingId: string) {
  const rows = await sql<{ slug: string; published_at: Date | null }>(
    "select slug, published_at from public.wedding_publications where wedding_id = $1",
    [weddingId],
  );
  return rows[0] ?? null;
}

async function sectionRows(weddingId: string) {
  return sql<{ kind: Kind; title: string | null; body: string | null; is_visible: boolean }>(
    "select kind, title, body, is_visible from public.content_sections where wedding_id = $1 order by kind",
    [weddingId],
  );
}

/** A wedding with a slug and one visible section, published by its owner. */
async function publishedWedding(owner: TestUserKey, name: string) {
  const weddingId = await fixtureWedding(owner, name);
  const slug = uniqueSlug("publicada");
  expect((await save(owner, weddingId, "intro", { body: "Hola a todos", visible: true })).error).toBeNull();
  expect((await setSlug(owner, weddingId, slug)).error).toBeNull();
  expect((await publish(owner, weddingId)).error).toBeNull();
  return { weddingId, slug };
}

// ---------------------------------------------------------------- schema

describe("wedding site schema", () => {
  it("sections and publications hold only content and publication state", async () => {
    const rows = await sql<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('content_sections', 'wedding_publications')
       order by table_name, ordinal_position`,
    );
    const columns = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name);
    expect(columns("content_sections")).toEqual([
      "id",
      "wedding_id",
      "kind",
      "title",
      "body",
      "is_visible",
      "created_at",
      "updated_at",
    ]);
    expect(columns("wedding_publications")).toEqual([
      "wedding_id",
      "slug",
      "published_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("section kinds are exactly the Constitution's website sections, in display order", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.content_section_kind'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "intro",
      "ceremony",
      "reception",
      "schedule",
      "dress_code",
      "faq",
      "rsvp",
    ]);
  });

  it("clients can't write publications directly; content has no delete", async () => {
    const writes = await sql<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee in ('anon', 'authenticated') and table_schema = 'public'
         and table_name in ('wedding_publications', 'content_sections')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       union
       select table_name, privilege_type from information_schema.column_privileges
       where grantee in ('anon', 'authenticated') and table_schema = 'public'
         and table_name = 'wedding_publications' and privilege_type <> 'SELECT'`,
    );
    expect(writes).toEqual([]);
    const contentUpdate = await sql<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_schema = 'public' and table_name = 'content_sections' order by column_name`,
    );
    expect(contentUpdate.map((r) => r.column_name)).toEqual(["body", "is_visible", "title"]);
  });
});

// --------------------------------------------------- content (private RLS)

describe("content sections", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda sitio A");
    weddingB = await fixtureWedding("ownerB", "Boda sitio B");
    await addMember(weddingA, "collabA", "collaborator");
  });

  it("owners and collaborators save sections; one row per kind, updated in place", async () => {
    expect((await save("ownerA", weddingA, "ceremony", { body: "A las cinco." })).error).toBeNull();
    expect(
      (await save("collabA", weddingA, "ceremony", { title: "La ceremonia", body: "A las seis.", visible: true }))
        .error,
    ).toBeNull();
    expect((await save("collabA", weddingA, "faq", { body: "¿Hay estacionamiento?\nSí." })).error).toBeNull();

    const rows = await sectionRows(weddingA);
    expect(rows.filter((r) => r.kind === "ceremony")).toEqual([
      { kind: "ceremony", title: "La ceremonia", body: "A las seis.", is_visible: true },
    ]);
    // Line breaks are kept.
    expect(rows.find((r) => r.kind === "faq")?.body).toBe("¿Hay estacionamiento?\nSí.");

    const dup = await as.ownerA.from("content_sections").insert({ wedding_id: weddingA, kind: "ceremony" });
    expect(dup.error?.code).toBe(UNIQUE_VIOLATION);
  });

  it("members read the sections; outsiders, other weddings' owners and anon see nothing", async () => {
    await save("ownerA", weddingA, "schedule", { body: "Programa privado" });
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await as[actor]
        .from("content_sections")
        .select("kind, body")
        .eq("wedding_id", weddingA)
        .eq("kind", "schedule");
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([{ kind: "schedule", body: "Programa privado" }]);
    }
    for (const actor of ["outsider", "ownerB"] as const) {
      const { data } = await as[actor].from("content_sections").select("kind").eq("wedding_id", weddingA);
      expect(data ?? [], actor).toEqual([]);
    }
    const anon = await as.anon.from("content_sections").select("kind").eq("wedding_id", weddingA);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
  });

  it("outsiders, other weddings' owners and anon can't write a wedding's sections", async () => {
    for (const actor of ["outsider", "ownerB"] as const) {
      const { error } = await save(actor, weddingA, "intro", { body: "Intruso", visible: true });
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
      const updated = await as[actor]
        .from("content_sections")
        .update({ body: "Intruso" })
        .eq("wedding_id", weddingA)
        .select("id");
      expect(updated.data ?? [], actor).toEqual([]);
    }
    const anon = await save("anon", weddingA, "intro", { body: "Intruso" });
    expect(anon.error).not.toBeNull();
    expect((await sectionRows(weddingA)).some((r) => r.body === "Intruso")).toBe(false);
  });

  it("a member of A can't write B's sections by naming B (no cross-wedding content)", async () => {
    await save("ownerB", weddingB, "intro", { body: "Contenido de B" });
    const { error } = await save("ownerA", weddingB, "intro", { body: "Desde A" });
    expect(error?.code).toBe(PERMISSION_DENIED);
    const direct = await as.ownerA
      .from("content_sections")
      .insert({ wedding_id: weddingB, kind: "faq", body: "Desde A" });
    expect(direct.error?.code).toBe(PERMISSION_DENIED);
    expect(await sectionRows(weddingB)).toEqual([
      { kind: "intro", title: null, body: "Contenido de B", is_visible: false },
    ]);
  });

  it("sections never move between weddings or change kind, and are never deleted", async () => {
    await save("ownerA", weddingA, "reception", { body: "Fija" });
    const move = await as.ownerA
      .from("content_sections")
      .update({ wedding_id: weddingB })
      .eq("wedding_id", weddingA)
      .eq("kind", "reception");
    expect(move.error?.code).toBe(PERMISSION_DENIED);
    const rekind = await as.ownerA
      .from("content_sections")
      .update({ kind: "faq" })
      .eq("wedding_id", weddingA)
      .eq("kind", "reception");
    expect(rekind.error?.code).toBe(PERMISSION_DENIED);
    const del = await as.ownerA.from("content_sections").delete().eq("wedding_id", weddingA);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    expect((await sectionRows(weddingA)).find((r) => r.kind === "reception")?.body).toBe("Fija");
  });

  it("titles and bodies are trimmed plain text within limits; blank is null", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda validación sitio");
    expect((await save("ownerA", wedding, "intro", { title: "Bienvenidos 💍", body: "Línea 1\nLínea 2" })).error).toBeNull();
    for (const title of [" Espacio", "a".repeat(121), "Con\nsalto", "Tab\t"]) {
      const { error } = await save("ownerA", wedding, "intro", { title, body: "x" });
      expect(error?.code, JSON.stringify(title)).toBe(CHECK_VIOLATION);
    }
    for (const body of [" x", "x\n", "a".repeat(5001), "con\rretorno", "con\ttab", "nul\u0001"]) {
      const { error } = await save("ownerA", wedding, "intro", { body });
      expect(error?.code, JSON.stringify(body.slice(0, 10))).toBe(CHECK_VIOLATION);
    }
    expect((await save("ownerA", wedding, "intro", { body: "a".repeat(5000) })).error).toBeNull();
    // Blank title and body are stored as null.
    expect((await save("ownerA", wedding, "intro", { title: "", body: "" })).error).toBeNull();
    expect((await sectionRows(wedding))[0]).toMatchObject({ title: null, body: null });
  });

  it("a visible section needs user-written content, except RSVP (which shows fixed guidance)", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda visible sitio");
    for (const kind of ["intro", "ceremony", "reception", "schedule", "dress_code", "faq"] as const) {
      const empty = await save("ownerA", wedding, kind, { visible: true });
      expect(empty.error?.code, kind).toBe(CHECK_VIOLATION);
      expect(empty.error?.message, kind).toContain("content_sections_visible_needs_body");
      // Whitespace is not content either (it never reaches storage as "empty").
      const spaces = await as.ownerA.from("content_sections").insert({ wedding_id: wedding, kind, body: "   ", is_visible: true });
      expect(spaces.error?.code, kind).toBe(CHECK_VIOLATION);
      // Hidden sections may be blank.
      expect((await save("ownerA", wedding, kind, { visible: false })).error, kind).toBeNull();
    }
    expect((await save("ownerA", wedding, "rsvp", { visible: true })).error).toBeNull();
    // The product default is never stored as the couple's content.
    expect((await sectionRows(wedding)).find((r) => r.kind === "rsvp")).toEqual({
      kind: "rsvp",
      title: null,
      body: null,
      is_visible: true,
    });
  });

  it("HTML-looking text is stored verbatim as text", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda texto plano");
    const body = '<script>alert("x")</script> <b>negrita</b> https://example.test';
    expect((await save("ownerA", wedding, "faq", { body })).error).toBeNull();
    expect((await sectionRows(wedding))[0]?.body).toBe(body);
  });
});

// ------------------------------------------------ publication (owner-only)

describe("publication", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda publicación");
    await addMember(wedding, "collabA", "collaborator");
    await save("collabA", wedding, "intro", { body: "Bienvenidos a nuestra boda", visible: true });
  });

  it("only owners set the address; collaborators, outsiders and anon are refused", async () => {
    const slug = uniqueSlug("solo-owner");
    const collab = await setSlug("collabA", wedding, slug);
    expect(collab.error?.code).toBe(PERMISSION_DENIED);
    expect(collab.error?.message).toBe("site_publication_owner_only");
    const outsider = await setSlug("outsider", wedding, slug);
    expect(outsider.error?.code).toBe(NO_DATA_FOUND);
    expect(outsider.error?.message).toBe("wedding_not_found");
    const otherOwner = await setSlug("ownerB", wedding, slug);
    expect(otherOwner.error?.message).toBe("wedding_not_found");
    const anon = await setSlug("anon", wedding, slug);
    expect(anon.error).not.toBeNull();
    expect(await publicationRow(wedding)).toBeNull();

    const owner = await setSlug("ownerA", wedding, slug);
    expect(owner.error).toBeNull();
    expect(owner.data).toBe(slug);
    expect(await publicationRow(wedding)).toEqual({ slug, published_at: null });
  });

  it("nobody writes publications directly, not even an owner", async () => {
    const insert = await as.ownerA
      .from("wedding_publications")
      .insert({ wedding_id: wedding, slug: uniqueSlug("directo") });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    for (const actor of ["ownerA", "collabA"] as const) {
      const update = await as[actor]
        .from("wedding_publications")
        .update({ published_at: new Date().toISOString() })
        .eq("wedding_id", wedding);
      expect(update.error?.code, actor).toBe(PERMISSION_DENIED);
      const del = await as[actor].from("wedding_publications").delete().eq("wedding_id", wedding);
      expect(del.error?.code, actor).toBe(PERMISSION_DENIED);
    }
    expect((await publicationRow(wedding))?.published_at).toBeNull();
  });

  it("members read the publication state; outsiders and anon don't", async () => {
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data } = await as[actor].from("wedding_publications").select("slug, published_at").eq("wedding_id", wedding);
      expect(data, actor).toHaveLength(1);
    }
    const outsider = await as.outsider.from("wedding_publications").select("slug").eq("wedding_id", wedding);
    expect(outsider.data ?? []).toEqual([]);
    const anon = await as.anon.from("wedding_publications").select("slug");
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
  });

  it("only owners publish and unpublish; a collaborator's direct call changes nothing", async () => {
    const collabPublish = await publish("collabA", wedding);
    expect(collabPublish.error?.code).toBe(PERMISSION_DENIED);
    expect(collabPublish.error?.message).toBe("site_publication_owner_only");
    expect((await publish("outsider", wedding)).error?.message).toBe("wedding_not_found");
    expect((await publish("anon", wedding)).error).not.toBeNull();
    expect((await publicationRow(wedding))?.published_at).toBeNull();

    const owner = await publish("ownerA", wedding);
    expect(owner.error).toBeNull();
    const publishedAt = (await publicationRow(wedding))?.published_at;
    expect(publishedAt).toBeInstanceOf(Date);

    // Publishing again is a no-op (same timestamp).
    expect((await publish("ownerA", wedding)).error).toBeNull();
    expect((await publicationRow(wedding))?.published_at).toEqual(publishedAt);

    const collabUnpublish = await unpublish("collabA", wedding);
    expect(collabUnpublish.error?.message).toBe("site_publication_owner_only");
    expect((await unpublish("outsider", wedding)).error?.message).toBe("wedding_not_found");
    expect((await publicationRow(wedding))?.published_at).toEqual(publishedAt);

    expect((await unpublish("ownerA", wedding)).error).toBeNull();
    expect((await publicationRow(wedding))?.published_at).toBeNull();
    // Unpublishing twice is fine.
    expect((await unpublish("ownerA", wedding)).error).toBeNull();
  });

  it("publishing needs an address and at least one visible section", async () => {
    const fresh = await fixtureWedding("ownerA", "Boda sin publicar");
    await save("ownerA", fresh, "intro", { body: "Algo", visible: true });
    const noSlug = await publish("ownerA", fresh);
    expect(noSlug.error?.message).toBe("wedding_site_slug_required");

    const empty = await fixtureWedding("ownerA", "Boda vacía");
    await setSlug("ownerA", empty, uniqueSlug("vacia"));
    // Content exists but nothing is visible.
    await save("ownerA", empty, "faq", { body: "Oculta", visible: false });
    const nothing = await publish("ownerA", empty);
    expect(nothing.error?.message).toBe("wedding_site_empty");
    expect((await publicationRow(empty))?.published_at).toBeNull();
  });
});

// ----------------------------------------------------------- slug rules

describe("public slug", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda direcciones");
  });

  it("is lowercase ASCII words joined by single hyphens, 3–80 characters", async () => {
    for (const slug of [
      "ab",
      "a".repeat(81),
      "Ana-y-Luis",
      "ana y luis",
      "-ana",
      "ana-",
      "ana--luis",
      "ana_luis",
      "boda-ñandú",
      "ana/luis",
      "",
    ]) {
      const { error } = await setSlug("ownerA", wedding, slug);
      expect(error?.code, JSON.stringify(slug)).toBe(CHECK_VIOLATION);
    }
    for (const slug of [uniqueSlug("ana-y-luis"), `abc${randomBytes(3).toString("hex")}`, `2090-${randomBytes(3).toString("hex")}`]) {
      expect((await setSlug("ownerA", wedding, slug)).error, slug).toBeNull();
    }
    const longest = `${randomBytes(4).toString("hex")}${"a".repeat(72)}`;
    expect(longest).toHaveLength(80);
    expect((await setSlug("ownerA", wedding, longest)).error).toBeNull();
  });

  it("refuses the app's reserved words", async () => {
    for (const slug of ["admin", "api", "app", "auth", "boda", "invite", "login", "rsvp", "signup"]) {
      const { error } = await setSlug("ownerA", wedding, slug);
      expect(error?.code, slug).toBe(CHECK_VIOLATION);
    }
  });

  it("is globally unique: a taken slug fails without revealing its wedding", async () => {
    const other = await fixtureWedding("ownerB", "Boda que ya la tiene");
    const slug = uniqueSlug("ocupada");
    expect((await setSlug("ownerB", other, slug)).error).toBeNull();
    const taken = await setSlug("ownerA", wedding, slug);
    expect(taken.error?.code).toBe(UNIQUE_VIOLATION);
    expect(JSON.stringify(taken.error)).not.toContain(other);
    expect(JSON.stringify(taken.error)).not.toContain("Boda que ya la tiene");
    // Re-saving your own slug is fine.
    expect((await setSlug("ownerB", other, slug)).error).toBeNull();
  });

  it("two weddings racing for the same slug: exactly one wins", async () => {
    const first = await fixtureWedding("ownerA", "Boda carrera 1");
    const second = await fixtureWedding("ownerB", "Boda carrera 2");
    const slug = uniqueSlug("carrera");
    const results = await Promise.all([setSlug("ownerA", first, slug), setSlug("ownerB", second, slug)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === UNIQUE_VIOLATION)).toHaveLength(1);
    expect(await sql("select 1 from public.wedding_publications where slug = $1", [slug])).toHaveLength(1);
  });
});

// ------------------------------------------------------- public read path

describe("public read boundary", () => {
  it("an unpublished wedding exposes nothing, even with a slug and visible content", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda privada");
    const slug = uniqueSlug("privada");
    await save("ownerA", wedding, "intro", { body: "Contenido privado", visible: true });
    await setSlug("ownerA", wedding, slug);
    for (const actor of ["anon", "outsider", "ownerA"] as const) {
      const { data, error } = await publicSite(actor, slug);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([]);
    }
  });

  it("a published wedding returns only the safe projection and its visible sections, in order", async () => {
    const { weddingId, slug } = await publishedWedding("ownerA", "Boda pública de prueba");
    await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad de prueba', time_zone = 'America/Costa_Rica' where id = $1", [
      weddingId,
    ]);
    await save("ownerA", weddingId, "faq", { title: "Dudas", body: "Pregunta\nRespuesta", visible: true });
    await save("ownerA", weddingId, "ceremony", { body: "Ceremonia visible", visible: true });
    await save("ownerA", weddingId, "dress_code", { body: "Oculto: formal", visible: false });
    await save("ownerA", weddingId, "rsvp", { visible: true });

    const { data, error } = await publicSite("anon", slug);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        wedding_name: "Boda pública de prueba",
        wedding_date: "2090-06-01",
        wedding_city: "Ciudad de prueba",
        section_kind: "intro",
        section_title: null,
        section_body: "Hola a todos",
      },
      {
        wedding_name: "Boda pública de prueba",
        wedding_date: "2090-06-01",
        wedding_city: "Ciudad de prueba",
        section_kind: "ceremony",
        section_title: null,
        section_body: "Ceremonia visible",
      },
      {
        wedding_name: "Boda pública de prueba",
        wedding_date: "2090-06-01",
        wedding_city: "Ciudad de prueba",
        section_kind: "faq",
        section_title: "Dudas",
        section_body: "Pregunta\nRespuesta",
      },
      {
        wedding_name: "Boda pública de prueba",
        wedding_date: "2090-06-01",
        wedding_city: "Ciudad de prueba",
        section_kind: "rsvp",
        section_title: null,
        section_body: null,
      },
    ]);
    // Nothing private anywhere in the payload.
    const payload = JSON.stringify(data);
    for (const secret of [weddingId, "America/Costa_Rica", "Oculto", "created_by", "time_zone", "published_at"]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("missing and malformed slugs look exactly like unpublished ones", async () => {
    for (const slug of [uniqueSlug("no-existe"), "NO VALIDA", "", "' or 1=1 --"]) {
      const { data, error } = await publicSite("anon", slug);
      expect(error, slug).toBeNull();
      expect(data, slug).toEqual([]);
    }
  });

  it("a published site with every section hidden shows only its header", async () => {
    const { weddingId, slug } = await publishedWedding("ownerA", "Boda solo encabezado");
    await save("ownerA", weddingId, "intro", { body: "Hola a todos", visible: false });
    const { data } = await publicSite("anon", slug);
    expect(data).toEqual([
      {
        wedding_name: "Boda solo encabezado",
        wedding_date: null,
        wedding_city: null,
        section_kind: null,
        section_title: null,
        section_body: null,
      },
    ]);
  });

  it("visibility, unpublish, republish and slug changes take effect immediately", async () => {
    const { weddingId, slug } = await publishedWedding("ownerA", "Boda cambios");
    await addMember(weddingId, "collabA", "collaborator");
    await save("ownerA", weddingId, "dress_code", { body: "Formal", visible: true });
    const kinds = async (s: string) => ((await publicSite("anon", s)).data ?? []).map((r) => r.section_kind);
    expect(await kinds(slug)).toEqual(["intro", "dress_code"]);

    // A collaborator hides a section: gone from the public site, kept privately.
    await save("collabA", weddingId, "dress_code", { body: "Formal", visible: false });
    expect(await kinds(slug)).toEqual(["intro"]);
    expect((await sectionRows(weddingId)).find((r) => r.kind === "dress_code")?.body).toBe("Formal");
    // An edit to a visible section is public at once.
    await save("collabA", weddingId, "intro", { body: "Hola editado", visible: true });
    expect((await publicSite("anon", slug)).data?.[0]?.section_body).toBe("Hola editado");

    // Unpublish: nothing public; content and address stay.
    await unpublish("ownerA", weddingId);
    expect((await publicSite("anon", slug)).data).toEqual([]);
    expect(await publicationRow(weddingId)).toEqual({ slug, published_at: null });
    expect((await sectionRows(weddingId)).map((r) => r.kind)).toEqual(["intro", "dress_code"]);

    // Republish: same address, same content.
    await publish("ownerA", weddingId);
    expect(await kinds(slug)).toEqual(["intro"]);

    // Changing the address: the old one stops resolving, the new one works.
    const next = uniqueSlug("nueva");
    expect((await setSlug("ownerA", weddingId, next)).error).toBeNull();
    expect((await publicSite("anon", slug)).data).toEqual([]);
    expect(await kinds(next)).toEqual(["intro"]);
    // The old address is free for anyone again.
    const other = await fixtureWedding("ownerB", "Boda que reutiliza");
    expect((await setSlug("ownerB", other, slug)).error).toBeNull();
  });

  it("never returns another wedding's sections", async () => {
    const a = await publishedWedding("ownerA", "Boda pública A");
    const b = await publishedWedding("ownerB", "Boda pública B");
    await save("ownerB", b.weddingId, "faq", { body: "Solo de B", visible: true });
    const { data } = await publicSite("anon", a.slug);
    expect(JSON.stringify(data)).not.toContain("Solo de B");
    expect(new Set((data ?? []).map((r) => r.wedding_name))).toEqual(new Set(["Boda pública A"]));
  });
});

// ------------------------------------------- published context for guests

describe("guest link → published site", () => {
  function newToken() {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
  }

  async function partyIn(weddingId: string) {
    const { hash } = newToken();
    const { data, error } = await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: weddingId,
      party_label: "Grupo con sitio",
      invitation_token_hash: hash,
      invitation_token_ciphertext: shapedEnvelope(),
      guest_names: ["Invitada"],
    });
    if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
    return { id: data, hash };
  }

  const siteSlugFor = (hash: string) =>
    as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: hash });

  it("returns the slug only while the link is usable AND the site is published", async () => {
    const { weddingId, slug } = await publishedWedding("ownerA", "Boda con enlace");
    const party = await partyIn(weddingId);
    expect((await siteSlugFor(party.hash)).data).toBe(slug);

    // Unpublished: nothing, but the guest link itself still works.
    await unpublish("ownerA", weddingId);
    expect((await siteSlugFor(party.hash)).data).toBeNull();
    const rsvp = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    expect(rsvp.data).toHaveLength(1);

    await publish("ownerA", weddingId);
    expect((await siteSlugFor(party.hash)).data).toBe(slug);

    // A revoked link reveals nothing, even for a published site.
    await as.ownerA.rpc("revoke_guest_invitation_link", { target_wedding_id: weddingId, target_invitation_id: party.id });
    expect((await siteSlugFor(party.hash)).data).toBeNull();
    expect((await siteSlugFor(newToken().hash)).data).toBeNull();
  });

  it("never reveals an unpublished wedding to a link holder", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda sin sitio publicado");
    await save("ownerA", wedding, "intro", { body: "Privado", visible: true });
    await setSlug("ownerA", wedding, uniqueSlug("sin-publicar"));
    const party = await partyIn(wedding);
    expect((await siteSlugFor(party.hash)).data).toBeNull();
  });
});
