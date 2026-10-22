import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import { PERMISSION_DENIED, addMember, as, createWedding as createFixtureWedding, serviceRole, sql } from "./support";

// UX-01B (ADR-022): wedding-site photos exercised as real anon and
// authenticated users through the Data API and the Storage API of the LOCAL
// stack: RLS and cross-wedding isolation, the storage policies, quotas and
// concurrent reservations, completion, cover and block rules, the public read
// and the service_role-only origin claim. The superuser connection only
// arranges fixtures and reads ground truth.

type Actor = keyof typeof as;

const BUCKET = "wedding-photos";
const CHECK_VIOLATION = "23514";
const NO_DATA_FOUND = "P0002";

const createdWeddings: string[] = [];
let slugCounter = 0;
let webp: Uint8Array;

beforeAll(async () => {
  webp = new Uint8Array(
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "#88aacc" } }).webp().toBuffer(),
  );
});

afterAll(async () => {
  // Objects first (rows are needed by nothing here: the superuser may delete storage rows explicitly).
  await sql(
    `do $$ begin
       perform set_config('storage.allow_delete_query', 'true', true);
       delete from storage.objects o
       where o.bucket_id = 'wedding-photos'
         and not exists (select 1 from public.wedding_photos p where o.name like p.id::text || '/%');
     end $$;`,
  );
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
  await sql(
    `do $$ begin
       perform set_config('storage.allow_delete_query', 'true', true);
       delete from storage.objects o
       where o.bucket_id = 'wedding-photos'
         and not exists (select 1 from public.wedding_photos p where o.name like p.id::text || '/%');
     end $$;`,
  );
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** Wedding A (ownerA + collabA) and wedding B (ownerB). */
async function twoWeddings() {
  const a = await fixtureWedding("ownerA", "Boda fotos A");
  await addMember(a, "collabA", "collaborator");
  const b = await fixtureWedding("ownerB", "Boda fotos B");
  return { a, b };
}

async function publishFixture(weddingId: string): Promise<string> {
  const slug = `fotos-${Date.now().toString(36)}-${++slugCounter}`;
  await sql("insert into public.wedding_publications (wedding_id, slug, published_at) values ($1, $2, now())", [
    weddingId,
    slug,
  ]);
  return slug;
}

function reserve(actor: Actor, weddingId: string) {
  return as[actor].rpc("create_wedding_photo", { target_wedding_id: weddingId });
}

async function reserved(actor: Actor, weddingId: string): Promise<string> {
  const { data, error } = await reserve(actor, weddingId);
  if (error || !data) throw new Error(`create_wedding_photo failed: ${error?.message}`);
  return data;
}

function upload(actor: Actor, name: string, options: { upsert?: boolean } = {}) {
  return as[actor].storage.from(BUCKET).upload(name, webp, { contentType: "image/webp", upsert: options.upsert ?? false });
}

function complete(actor: Actor, photoId: string, width = 64, height = 48) {
  return as[actor].rpc("complete_wedding_photo", {
    target_photo_id: photoId,
    rendition_width: width,
    rendition_height: height,
  });
}

/** A ready photo uploaded the real way (reserve → two objects → complete) by `actor`. */
async function readyPhoto(actor: Actor, weddingId: string): Promise<string> {
  const id = await reserved(actor, weddingId);
  for (const rendition of ["1600", "640"]) {
    const { error } = await upload(actor, `${id}/${rendition}.webp`);
    if (error) throw new Error(`upload failed: ${error.message}`);
  }
  const { error } = await complete(actor, id);
  if (error) throw new Error(`complete failed: ${error.message}`);
  return id;
}

/** Fixture: ready rows without objects (quota tests only). */
async function fakeReadyRows(weddingId: string, count: number, bytes = 300_000): Promise<void> {
  await sql(
    `insert into public.wedding_photos (wedding_id, state, width, height, bytes)
     select $1, 'ready', 1600, 1067, $3 from generate_series(1, $2)`,
    [weddingId, count, bytes],
  );
}

async function photoRow(id: string) {
  const [row] = await sql<{ state: string; bytes: string | null; block_id: string | null }>(
    "select state, bytes, block_id from public.wedding_photos where id = $1",
    [id],
  );
  return row ?? null;
}

async function objectNames(photoId: string): Promise<string[]> {
  const rows = await sql<{ name: string }>(
    "select name from storage.objects where bucket_id = 'wedding-photos' and name like $1 order by name",
    [`${photoId}/%`],
  );
  return rows.map((row) => row.name);
}

// ------------------------------------------------------------------ setup

describe("schema and grants", () => {
  it("creates a private, WebP-only, 1 MB bucket", async () => {
    const [bucket] = await sql<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      "select public, file_size_limit::text, allowed_mime_types from storage.buckets where id = 'wedding-photos'",
    );
    expect(bucket).toEqual({ public: false, file_size_limit: "1048576", allowed_mime_types: ["image/webp"] });
  });

  it("enables RLS on every new table", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       where c.oid in ('public.wedding_photos'::regclass, 'public.wedding_site_photo_blocks'::regclass,
                       'public.wedding_photo_origin_usage'::regclass, 'private.wedding_photo_upload_days'::regclass)`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("gives clients no access to the origin meter and no direct photo inserts", async () => {
    for (const actor of ["anon", "ownerA"] as const) {
      const { data, error } = await as[actor].from("wedding_photo_origin_usage").select("month");
      expect(error?.code ?? (data ?? []).length).toBeTruthy();
      expect(data ?? []).toEqual([]);
    }
    const { a } = await twoWeddings();
    const { error } = await as.ownerA.from("wedding_photos").insert({ wedding_id: a });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("lets only service_role execute the origin claim", async () => {
    for (const actor of ["anon", "ownerA"] as const) {
      const { error } = await as[actor].rpc("claim_published_wedding_photo", {
        site_slug: "x-y-z",
        target_photo_id: crypto.randomUUID(),
        rendition: "640",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    const { error } = await serviceRole.rpc("claim_published_wedding_photo", {
      site_slug: "no-existe",
      target_photo_id: crypto.randomUUID(),
      rendition: "640",
    });
    expect(error).toBeNull();
  });
});

// ------------------------------------------------------------ RLS matrix

describe("membership and cross-wedding isolation", () => {
  it("lets owners and collaborators reserve, and nobody else", async () => {
    const { a, b } = await twoWeddings();
    expect((await reserve("ownerA", a)).error).toBeNull();
    expect((await reserve("collabA", a)).error).toBeNull();
    for (const actor of ["ownerB", "outsider"] as const) {
      const { error } = await reserve(actor, a);
      expect(error?.message).toBe("wedding_not_found");
      expect(error?.code).toBe(NO_DATA_FOUND);
    }
    expect((await reserve("anon", a)).error?.code).toBe(PERMISSION_DENIED);
    expect((await reserve("ownerA", b)).error?.message).toBe("wedding_not_found");
    expect((await reserve("ownerA", crypto.randomUUID())).error?.message).toBe("wedding_not_found");
  });

  it("shows photos and blocks to members of their wedding only", async () => {
    const { a } = await twoWeddings();
    const photo = await readyPhoto("ownerA", a);
    await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "gallery", variant: "grid" });

    for (const actor of ["ownerA", "collabA"] as const) {
      const photos = await as[actor].from("wedding_photos").select("id").eq("wedding_id", a);
      expect(photos.data?.map((row) => row.id)).toEqual([photo]);
      const blocks = await as[actor].from("wedding_site_photo_blocks").select("id").eq("wedding_id", a);
      expect(blocks.data).toHaveLength(1);
    }
    for (const actor of ["ownerB", "outsider", "anon"] as const) {
      const photos = await as[actor].from("wedding_photos").select("id").eq("wedding_id", a);
      expect(photos.data ?? []).toEqual([]);
      const blocks = await as[actor].from("wedding_site_photo_blocks").select("id").eq("wedding_id", a);
      expect(blocks.data ?? []).toEqual([]);
    }
  });

  it("refuses edits, deletes and block inserts from outsiders", async () => {
    const { a, b } = await twoWeddings();
    const photo = await readyPhoto("ownerA", a);

    const edit = await as.ownerB.from("wedding_photos").update({ alt_text: "hack" }).eq("id", photo).select("id");
    expect(edit.data ?? []).toEqual([]);
    const removed = await as.outsider.from("wedding_photos").delete().eq("id", photo).select("id");
    expect(removed.data ?? []).toEqual([]);
    expect(await photoRow(photo)).not.toBeNull();

    const insert = await as.ownerB.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "gallery", variant: "grid" });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);

    // A block of another wedding can't hold this wedding's photo (composite FK).
    const other = await as.ownerB
      .from("wedding_site_photo_blocks")
      .insert({ wedding_id: b, kind: "gallery", variant: "grid" })
      .select("id")
      .single();
    const cross = await as.ownerA.from("wedding_photos").update({ block_id: other.data!.id }).eq("id", photo);
    expect(cross.error?.code).toBe("23503");
  });

  it("never lets members move a photo to another wedding or change its state or size", async () => {
    const { a, b } = await twoWeddings();
    const photo = await readyPhoto("ownerA", a);
    for (const change of [{ wedding_id: b }, { state: "pending" as const }, { bytes: 1 }, { width: 1 }]) {
      const { error } = await as.ownerA.from("wedding_photos").update(change).eq("id", photo);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });
});

// ---------------------------------------------------------- storage policies

describe("storage policies", () => {
  it("accepts exactly the two rendition names of the caller's own fresh pending photo", async () => {
    const { a } = await twoWeddings();
    const id = await reserved("ownerA", a);

    expect((await upload("ownerA", `${id}/1600.webp`)).error).toBeNull();
    // Another name for the same photo, an original, a path traversal or a foreign id: refused.
    for (const name of [`${id}/original.jpg`, `${id}/2400.webp`, `${a}/1600.webp`, `../${id}/640.webp`, `${crypto.randomUUID()}/640.webp`]) {
      expect((await upload("ownerA", name)).error).not.toBeNull();
    }
    // A collaborator can't write into the owner's pending upload; outsiders and anon can't write at all.
    expect((await upload("collabA", `${id}/640.webp`)).error).not.toBeNull();
    expect((await upload("ownerB", `${id}/640.webp`)).error).not.toBeNull();
    expect((await upload("anon", `${id}/640.webp`)).error).not.toBeNull();
    // No overwrite, even by the uploader.
    expect((await upload("ownerA", `${id}/1600.webp`, { upsert: true })).error).not.toBeNull();
    expect((await upload("ownerA", `${id}/1600.webp`)).error).not.toBeNull();
    expect(await objectNames(id)).toEqual([`${id}/1600.webp`]);
  });

  it("refuses uploads to a ready photo or a stale pending one", async () => {
    const { a } = await twoWeddings();
    const ready = await readyPhoto("ownerA", a);
    expect((await upload("ownerA", `${ready}/640.webp`, { upsert: true })).error).not.toBeNull();

    const stale = await reserved("ownerA", a);
    await sql("update public.wedding_photos set created_at = now() - interval '16 minutes' where id = $1", [stale]);
    expect((await upload("ownerA", `${stale}/1600.webp`)).error).not.toBeNull();
  });

  it("refuses non-WebP content types and objects over 1 MB", async () => {
    const { a } = await twoWeddings();
    const id = await reserved("ownerA", a);
    const jpeg = await as.ownerA.storage
      .from(BUCKET)
      .upload(`${id}/1600.webp`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { contentType: "image/jpeg" });
    expect(jpeg.error).not.toBeNull();
    const big = await as.ownerA.storage
      .from(BUCKET)
      .upload(`${id}/1600.webp`, new Uint8Array(1024 * 1024 + 10), { contentType: "image/webp" });
    expect(big.error).not.toBeNull();
  });

  it("lets members read and delete their wedding's objects, and nobody else", async () => {
    const { a } = await twoWeddings();
    const id = await readyPhoto("ownerA", a);
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await as[actor].storage.from(BUCKET).download(`${id}/640.webp`);
      expect(error).toBeNull();
      expect(data?.size).toBe(webp.byteLength);
    }
    for (const actor of ["ownerB", "outsider", "anon"] as const) {
      const { data } = await as[actor].storage.from(BUCKET).download(`${id}/640.webp`);
      expect(data).toBeNull();
      await as[actor].storage.from(BUCKET).remove([`${id}/640.webp`]);
    }
    expect(await objectNames(id)).toHaveLength(2);
    // No public URL works on a private bucket.
    const publicUrl = as.anon.storage.from(BUCKET).getPublicUrl(`${id}/640.webp`).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);

    await as.collabA.storage.from(BUCKET).remove([`${id}/640.webp`, `${id}/1600.webp`]);
    expect(await objectNames(id)).toEqual([]);
  });
});

// ------------------------------------------------------------ completion

describe("complete_wedding_photo", () => {
  it("needs both objects, reads their sizes from storage and only for the uploader", async () => {
    const { a } = await twoWeddings();
    const id = await reserved("ownerA", a);
    expect((await complete("ownerA", id)).error?.message).toBe("wedding_photo_incomplete");
    await upload("ownerA", `${id}/1600.webp`);
    expect((await complete("ownerA", id)).error?.message).toBe("wedding_photo_incomplete");
    await upload("ownerA", `${id}/640.webp`);

    expect((await complete("collabA", id)).error?.message).toBe("wedding_photo_not_found");
    expect((await complete("ownerB", id)).error?.message).toBe("wedding_photo_not_found");
    expect((await complete("ownerA", id, 0, 10)).error?.message).toBe("wedding_photo_invalid");
    expect((await complete("ownerA", id, 1601, 10)).error?.message).toBe("wedding_photo_invalid");

    expect((await complete("ownerA", id, 64, 48)).error).toBeNull();
    expect(await photoRow(id)).toEqual({ state: "ready", bytes: String(webp.byteLength * 2), block_id: null });
    // Completing twice is refused (no longer pending).
    expect((await complete("ownerA", id)).error?.message).toBe("wedding_photo_not_found");
  });

  it("re-checks the 40 MB budget with the real sizes", async () => {
    const { a } = await twoWeddings();
    const id = await reserved("ownerA", a);
    await upload("ownerA", `${id}/1600.webp`);
    await upload("ownerA", `${id}/640.webp`);
    await sql(
      "insert into public.wedding_photos (wedding_id, state, width, height, bytes) values ($1, 'ready', 10, 10, $2)",
      [a, 40 * 1024 * 1024 - webp.byteLength],
    );
    const { error } = await complete("ownerA", id);
    expect(error?.message).toBe("wedding_photo_storage_limit");
    expect(error?.code).toBe(CHECK_VIOLATION);
  });
});

// ---------------------------------------------------------------- quotas

describe("quotas and breakers", () => {
  it("refuses the 21st photo, pending uploads included", async () => {
    const { a } = await twoWeddings();
    await fakeReadyRows(a, 19);
    await reserved("ownerA", a);
    const { error } = await reserve("ownerA", a);
    expect(error?.message).toBe("wedding_photo_limit");
  });

  it("allows at most three uploads in flight, even when requested concurrently", async () => {
    const { a } = await twoWeddings();
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve("ownerA", a)));
    expect(results.filter((r) => r.error === null)).toHaveLength(3);
    expect(results.filter((r) => r.error?.message === "wedding_photo_busy")).toHaveLength(3);
  });

  it("sweeps stale pending rows before counting", async () => {
    const { a } = await twoWeddings();
    const ids = [await reserved("ownerA", a), await reserved("ownerA", a), await reserved("ownerA", a)];
    expect((await reserve("ownerA", a)).error?.message).toBe("wedding_photo_busy");
    await sql("update public.wedding_photos set created_at = now() - interval '20 minutes' where id = any($1::uuid[])", [ids]);
    expect((await reserve("ownerA", a)).error).toBeNull();
    const left = await sql("select 1 from public.wedding_photos where id = any($1::uuid[])", [ids]);
    expect(left).toEqual([]);
  });

  it("counts uploads per day, deleted photos included", async () => {
    const { a } = await twoWeddings();
    await sql(
      "insert into private.wedding_photo_upload_days (wedding_id, day, uploads) values ($1, (now() at time zone 'utc')::date, 59)",
      [a],
    );
    const last = await reserved("ownerA", a);
    await as.ownerA.from("wedding_photos").delete().eq("id", last);
    expect((await reserve("ownerA", a)).error?.message).toBe("wedding_photo_daily_limit");
    // The refused attempt didn't count.
    const [row] = await sql<{ uploads: number }>(
      "select uploads from private.wedding_photo_upload_days where wedding_id = $1",
      [a],
    );
    expect(row.uploads).toBe(60);
  });

  it("refuses a new upload when the wedding is near its 40 MB", async () => {
    const { a } = await twoWeddings();
    await fakeReadyRows(a, 1, 39 * 1024 * 1024);
    expect((await reserve("ownerA", a)).error?.message).toBe("wedding_photo_storage_limit");
  });

  it("pauses every upload when the bucket nears the 800 MB breaker", async () => {
    const { a } = await twoWeddings();
    const name = `${crypto.randomUUID()}/1600.webp`;
    await sql(
      `insert into storage.objects (bucket_id, name, metadata) values ('wedding-photos', $1, jsonb_build_object('size', 800 * 1024 * 1024, 'mimetype', 'image/webp'))`,
      [name],
    );
    try {
      expect((await reserve("ownerA", a)).error?.message).toBe("wedding_photos_paused");
    } finally {
      await sql(
        `do $$ begin perform set_config('storage.allow_delete_query', 'true', true);
         delete from storage.objects where bucket_id = 'wedding-photos' and name = '${name}'; end $$;`,
      );
    }
    expect((await reserve("ownerA", a)).error).toBeNull();
  });
});

// ------------------------------------------------------- cover and blocks

describe("cover and blocks", () => {
  it("creates the hidden cover block once and moves the previous cover back to the library", async () => {
    const { a } = await twoWeddings();
    const first = await readyPhoto("ownerA", a);
    const second = await readyPhoto("ownerA", a);

    const set1 = await as.collabA.rpc("set_wedding_cover_photo", { target_wedding_id: a, target_photo_id: first });
    expect(set1).toMatchObject({ error: null, data: null });
    const set2 = await as.ownerA.rpc("set_wedding_cover_photo", { target_wedding_id: a, target_photo_id: second });
    expect(set2.data).toBe(first);

    const blocks = await sql<{ kind: string; is_visible: boolean }>(
      "select kind::text, is_visible from public.wedding_site_photo_blocks where wedding_id = $1",
      [a],
    );
    expect(blocks).toEqual([{ kind: "cover", is_visible: false }]);
    expect((await photoRow(first))?.block_id).toBeNull();
    expect((await photoRow(second))?.block_id).not.toBeNull();

    // A second cover block can't exist; outsiders can't set one.
    const dup = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "cover", variant: "standard" });
    expect(dup.error?.code).toBe("23505");
    const foreign = await as.ownerB.rpc("set_wedding_cover_photo", { target_wedding_id: a, target_photo_id: first });
    expect(foreign.error?.message).toBe("wedding_photo_not_found");
  });

  it("refuses pending photos, a second photo in single-photo blocks and wrong variants", async () => {
    const { a } = await twoWeddings();
    const pending = await reserved("ownerA", a);
    const one = await readyPhoto("ownerA", a);
    const two = await readyPhoto("ownerA", a);
    const block = await as.ownerA
      .from("wedding_site_photo_blocks")
      .insert({ wedding_id: a, kind: "photo_text", variant: "image_start", title: "Nosotros" })
      .select("id")
      .single();
    const blockId = block.data!.id;

    expect((await as.ownerA.from("wedding_photos").update({ block_id: blockId }).eq("id", pending)).error?.code).toBe(CHECK_VIOLATION);
    expect((await as.ownerA.from("wedding_photos").update({ block_id: blockId }).eq("id", one)).error).toBeNull();
    const full = await as.ownerA.from("wedding_photos").update({ block_id: blockId }).eq("id", two);
    expect(full.error?.message).toBe("wedding_photo_block_full");

    for (const bad of [
      { kind: "gallery" as const, variant: "image_start" as const },
      { kind: "carousel" as const, variant: "grid" as const },
      { kind: "gallery" as const, variant: "grid" as const, title: "no" },
    ]) {
      const { error } = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, ...bad });
      expect(error?.code).toBe(CHECK_VIOLATION);
    }
  });

  it("caps a wedding at 12 photo blocks", async () => {
    const { a } = await twoWeddings();
    await sql(
      "insert into public.wedding_site_photo_blocks (wedding_id, kind, variant) select $1, 'gallery', 'grid' from generate_series(1, 12)",
      [a],
    );
    const { error } = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "carousel", variant: "standard" });
    expect(error?.message).toBe("wedding_site_photo_block_limit");
  });

  it("orders photos in a block by appending, and moves swap neighbours", async () => {
    const { a } = await twoWeddings();
    const block = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "gallery", variant: "grid" }).select("id").single();
    const ids = [await readyPhoto("ownerA", a), await readyPhoto("ownerA", a), await readyPhoto("ownerA", a)];
    for (const id of ids) await as.ownerA.from("wedding_photos").update({ block_id: block.data!.id }).eq("id", id);

    const order = async () =>
      (await sql<{ id: string }>("select id from public.wedding_photos where block_id = $1 order by position, id", [block.data!.id])).map((r) => r.id);
    expect(await order()).toEqual(ids);

    expect((await as.collabA.rpc("move_wedding_photo", { target_photo_id: ids[2], direction: "before" })).data).toBe(true);
    expect(await order()).toEqual([ids[0], ids[2], ids[1]]);
    expect((await as.ownerA.rpc("move_wedding_photo", { target_photo_id: ids[0], direction: "before" })).data).toBe(false);
    // Outsiders can't move it (RLS hides the row).
    expect((await as.ownerB.rpc("move_wedding_photo", { target_photo_id: ids[0], direction: "after" })).error?.message).toBe(
      "wedding_photo_not_found",
    );
  });
});

// -------------------------------------------- public read and origin claim

describe("publication gate", () => {
  async function publicFixture() {
    const { a, b } = await twoWeddings();
    const visible = await readyPhoto("ownerA", a);
    const noAlt = await readyPhoto("ownerA", a);
    const hiddenPhoto = await readyPhoto("ownerA", a);
    const library = await readyPhoto("ownerA", a);
    const pending = await reserved("ownerA", a);
    const foreign = await readyPhoto("ownerB", b);

    const shown = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "gallery", variant: "masonry", anchor: "ceremony" }).select("id").single();
    const hidden = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: a, kind: "carousel", variant: "standard" }).select("id").single();
    await as.ownerA.from("wedding_photos").update({ block_id: shown.data!.id, alt_text: "Ana y Luis en la playa", caption: "Puntarenas" }).eq("id", visible);
    await as.ownerA.from("wedding_photos").update({ block_id: shown.data!.id }).eq("id", noAlt);
    await as.ownerA.from("wedding_photos").update({ block_id: hidden.data!.id, alt_text: "Oculta" }).eq("id", hiddenPhoto);
    await as.ownerA.from("wedding_site_photo_blocks").update({ is_visible: true }).eq("id", shown.data!.id);
    return { a, b, visible, noAlt, hiddenPhoto, library, pending, foreign, shownBlock: shown.data!.id };
  }

  function claim(slug: string, photoId: string, rendition = "640") {
    return serviceRole.rpc("claim_published_wedding_photo", { site_slug: slug, target_photo_id: photoId, rendition });
  }

  it("returns nothing for an unpublished wedding", async () => {
    const f = await publicFixture();
    await sql("insert into public.wedding_publications (wedding_id, slug) values ($1, $2)", [f.a, `borrador-${++slugCounter}`]);
    const [{ slug }] = await sql<{ slug: string }>("select slug from public.wedding_publications where wedding_id = $1", [f.a]);
    expect((await as.anon.rpc("get_published_wedding_site", { site_slug: slug })).data).toEqual([]);
    expect((await claim(slug, f.visible)).data).toBeNull();
  });

  it("shows only ready, described photos in visible blocks, with no internals", async () => {
    const f = await publicFixture();
    const slug = await publishFixture(f.a);
    const { data, error } = await as.anon.rpc("get_published_wedding_site", { site_slug: slug });
    expect(error).toBeNull();
    const photos = data?.[0]?.site_photos;
    expect(photos).toEqual([
      {
        kind: "gallery",
        variant: "masonry",
        anchor: "ceremony",
        title: null,
        body: null,
        photos: [{ id: f.visible, width: 64, height: 48, alt: "Ana y Luis en la playa", caption: "Puntarenas", focalX: 5000, focalY: 5000 }],
      },
    ]);
    const text = JSON.stringify(photos);
    for (const secret of [f.a, f.noAlt, f.hiddenPhoto, f.library, f.pending, f.shownBlock, "wedding_id", "bytes", "created", ".webp"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("claims only public renditions of the slug's wedding, and meters them", async () => {
    const f = await publicFixture();
    const slug = await publishFixture(f.a);
    const month = await sql<{ origin_bytes: string }>(
      "select origin_bytes::text from public.wedding_photo_origin_usage where month = date_trunc('month', now() at time zone 'utc')::date",
    );
    const before = BigInt(month[0]?.origin_bytes ?? "0");

    expect((await claim(slug, f.visible, "640")).data).toBe(`${f.visible}/640.webp`);
    expect((await claim(slug, f.visible, "1600")).data).toBe(`${f.visible}/1600.webp`);
    for (const [photo, rendition] of [
      [f.noAlt, "640"],
      [f.hiddenPhoto, "640"],
      [f.library, "640"],
      [f.pending, "640"],
      [f.foreign, "640"],
      [crypto.randomUUID(), "640"],
      [f.visible, "2400"],
      [f.visible, "original"],
    ] as const) {
      expect((await claim(slug, photo, rendition)).data).toBeNull();
    }
    expect((await claim("otra-boda", f.visible)).data).toBeNull();

    const [after] = await sql<{ origin_bytes: string }>(
      "select origin_bytes::text from public.wedding_photo_origin_usage where month = date_trunc('month', now() at time zone 'utc')::date",
    );
    expect(BigInt(after.origin_bytes) - before).toBe(BigInt(webp.byteLength * 2));
  });

  it("stops serving at once when unpublished, hidden or deleted", async () => {
    const f = await publicFixture();
    const slug = await publishFixture(f.a);
    expect((await claim(slug, f.visible)).data).not.toBeNull();

    await as.ownerA.from("wedding_site_photo_blocks").update({ is_visible: false }).eq("id", f.shownBlock);
    expect((await claim(slug, f.visible)).data).toBeNull();
    await as.ownerA.from("wedding_site_photo_blocks").update({ is_visible: true }).eq("id", f.shownBlock);

    await sql("update public.wedding_publications set published_at = null where wedding_id = $1", [f.a]);
    expect((await claim(slug, f.visible)).data).toBeNull();
    await sql("update public.wedding_publications set published_at = now() where wedding_id = $1", [f.a]);

    await as.ownerA.from("wedding_photos").update({ alt_text: null }).eq("id", f.visible);
    expect((await claim(slug, f.visible)).data).toBeNull();
    await as.ownerA.from("wedding_photos").update({ alt_text: "De nuevo" }).eq("id", f.visible);

    await as.ownerA.storage.from(BUCKET).remove([`${f.visible}/640.webp`, `${f.visible}/1600.webp`]);
    await as.ownerA.from("wedding_photos").delete().eq("id", f.visible);
    expect((await claim(slug, f.visible)).data).toBeNull();
  });

  it("stops new origin downloads when the monthly budget is spent", async () => {
    const f = await publicFixture();
    const slug = await publishFixture(f.a);
    const month = "date_trunc('month', now() at time zone 'utc')::date";
    const [saved] = await sql<{ origin_bytes: string }>(
      `insert into public.wedding_photo_origin_usage (month) values (${month}) on conflict (month) do update set month = excluded.month returning origin_bytes::text`,
    );
    try {
      await sql(`update public.wedding_photo_origin_usage set origin_bytes = 3::bigint * 1024 * 1024 * 1024 - 10 where month = ${month}`);
      expect((await claim(slug, f.visible)).data).toBeNull();
    } finally {
      await sql(`update public.wedding_photo_origin_usage set origin_bytes = $1 where month = ${month}`, [saved.origin_bytes]);
    }
    expect((await claim(slug, f.visible)).data).not.toBeNull();
  });
});

// --------------------------------------------------------------- cleanup

describe("cleanup", () => {
  it("cascades rows with the wedding and leaves objects for the operator reconcile", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda fotos borrada");
    const photo = await readyPhoto("ownerA", wedding);
    await sql("delete from public.weddings where id = $1", [wedding]);
    expect(await photoRow(photo)).toBeNull();
    // The reconcile query (docs/operations/WEDDING-PHOTOS.md) lists them.
    const orphans = await sql<{ name: string }>(
      `select o.name from storage.objects o
       where o.bucket_id = 'wedding-photos'
         and not exists (select 1 from public.wedding_photos p where p.id::text = split_part(o.name, '/', 1))
         and o.name like $1`,
      [`${photo}/%`],
    );
    expect(orphans.map((row) => row.name).sort()).toEqual([`${photo}/1600.webp`, `${photo}/640.webp`]);
  });
});
