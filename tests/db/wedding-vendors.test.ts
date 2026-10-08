import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  shapedEnvelope,
  sql,
  superuser,
  users,
} from "./support";

// LB-21 (ADR-014): wedding vendor engagements. Exercised as real
// anon/authenticated users through the Data API; the superuser connection only
// arranges fixtures and reads ground truth.

type VendorInsert = Database["public"]["Tables"]["wedding_vendors"]["Insert"];

const CHECK_VIOLATION = "23514";
const INVALID_TEXT_REPRESENTATION = "22P02";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Proveedores A");
  weddingB = await fixtureWedding("ownerB", "Boda Proveedores B");
  await addMember(weddingA, "collabA", "collaborator");
});

function insertVendor(actor: keyof typeof as, weddingId: string, fields: Partial<VendorInsert> = {}) {
  return as[actor]
    .from("wedding_vendors")
    .insert({ wedding_id: weddingId, name: "Floristería Las Gardenias", category: "flowers_decor", ...fields })
    .select("id")
    .single();
}

async function createVendor(actor: TestUserKey, weddingId: string, fields: Partial<VendorInsert> = {}): Promise<string> {
  const { data, error } = await insertVendor(actor, weddingId, fields);
  if (error || !data) throw new Error(`vendor insert failed: ${error?.message}`);
  return data.id;
}

type Row = {
  name: string;
  status: string;
  wedding_id: string;
  created_by: string | null;
  quoted_amount_minor: string | null;
  contracted_amount_minor: string | null;
  currency: string | null;
};

async function rowOf(vendorId: string): Promise<Row | undefined> {
  const [row] = await sql<Row>(
    `select name, status::text as status, wedding_id, created_by, quoted_amount_minor::text,
            contracted_amount_minor::text, currency
     from public.wedding_vendors where id = $1`,
    [vendorId],
  );
  return row;
}

/** Inserts as the owner and returns the Postgres error code (null = accepted). */
async function insertCode(fields: Partial<VendorInsert>): Promise<string | null> {
  const { error } = await insertVendor("ownerA", weddingA, fields);
  return error?.code ?? null;
}

// ------------------------------------------------------------------ access

describe("vendor access", () => {
  for (const actor of ["ownerA", "collabA"] as const) {
    it(`${actor} can select, insert, update and delete the wedding's vendors`, async () => {
      const { data: inserted, error } = await insertVendor(actor, weddingA, { name: `Proveedor de ${actor}` });
      expect(error).toBeNull();
      const vendorId = inserted!.id;

      const read = await as[actor].from("wedding_vendors").select("id, name").eq("id", vendorId);
      expect(read.data).toEqual([{ id: vendorId, name: `Proveedor de ${actor}` }]);

      const updated = await as[actor]
        .from("wedding_vendors")
        .update({ status: "booked", currency: "USD", contracted_amount_minor: 350_000 })
        .eq("id", vendorId)
        .select("id, status");
      expect(updated.data).toEqual([{ id: vendorId, status: "booked" }]);

      const deleted = await as[actor].from("wedding_vendors").delete().eq("id", vendorId).select("id");
      expect(deleted.data).toEqual([{ id: vendorId }]);
      expect(await rowOf(vendorId)).toBeUndefined();
    });
  }

  it("a non-member sees nothing and cannot write", async () => {
    const vendorId = await createVendor("ownerA", weddingA, { name: "Proveedor privado", notes: "Nota privada" });
    for (const actor of ["outsider", "ownerB"] as const) {
      expect((await as[actor].from("wedding_vendors").select("id").eq("wedding_id", weddingA)).data).toEqual([]);
      expect((await as[actor].from("wedding_vendors").select("id").eq("id", vendorId)).data).toEqual([]);
      expect((await insertVendor(actor, weddingA, { name: "Intruso" })).error?.code).toBe(PERMISSION_DENIED);

      const update = await as[actor].from("wedding_vendors").update({ name: "Hackeado" }).eq("id", vendorId).select("id");
      expect(update.data).toEqual([]);
      const del = await as[actor].from("wedding_vendors").delete().eq("id", vendorId).select("id");
      expect(del.data).toEqual([]);
    }
    expect((await rowOf(vendorId))?.name).toBe("Proveedor privado");
  });

  it("a non-member's writes are refused by the write policies themselves (no RETURNING to hide behind)", async () => {
    const vendorId = await createVendor("ownerA", weddingA, { name: "Proveedor minimal" });
    for (const actor of ["outsider", "ownerB"] as const) {
      const insert = await as[actor]
        .from("wedding_vendors")
        .insert({ wedding_id: weddingA, name: `Intruso ${actor}`, category: "music" });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      await as[actor].from("wedding_vendors").update({ name: "Hackeado", status: "discarded" }).eq("id", vendorId);
      await as[actor].from("wedding_vendors").delete().eq("id", vendorId);
    }
    expect(await sql("select 1 from public.wedding_vendors where name like 'Intruso %'")).toEqual([]);
    expect(await rowOf(vendorId)).toMatchObject({ name: "Proveedor minimal", status: "considering" });
  });

  it("anon can neither read nor write vendors", async () => {
    const vendorId = await createVendor("ownerA", weddingA, { name: "Proveedor anon" });
    expect((await as.anon.from("wedding_vendors").select("id")).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.anon.from("wedding_vendors").select("id").eq("id", vendorId)).error?.code).toBe(PERMISSION_DENIED);
    expect((await insertVendor("anon", weddingA, { name: "Anon" })).error?.code).toBe(PERMISSION_DENIED);
    const update = await as.anon.from("wedding_vendors").update({ name: "Anon" }).eq("id", vendorId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await as.anon.from("wedding_vendors").delete().eq("id", vendorId);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    expect((await rowOf(vendorId))?.name).toBe("Proveedor anon");
  });
});

// ----------------------------------------------------------------- tenancy

describe("vendor tenancy", () => {
  it("a known vendor id of another wedding is invisible and untouchable", async () => {
    const vendorB = await createVendor("ownerB", weddingB, { name: "Proveedor de B", contact_name: "Contacto B" });
    for (const actor of ["ownerA", "collabA"] as const) {
      expect((await as[actor].from("wedding_vendors").select("*").eq("id", vendorB)).data).toEqual([]);
      const update = await as[actor].from("wedding_vendors").update({ name: "Robado" }).eq("id", vendorB).select("id");
      expect(update.data).toEqual([]);
      const scoped = await as[actor]
        .from("wedding_vendors")
        .update({ name: "Robado" })
        .eq("id", vendorB)
        .eq("wedding_id", weddingA)
        .select("id");
      expect(scoped.data).toEqual([]);
      const del = await as[actor].from("wedding_vendors").delete().eq("id", vendorB).select("id");
      expect(del.data).toEqual([]);
    }
    expect(await rowOf(vendorB)).toMatchObject({ name: "Proveedor de B", wedding_id: weddingB });
  });

  it("a member of A cannot insert into wedding B", async () => {
    for (const actor of ["ownerA", "collabA"] as const) {
      expect((await insertVendor(actor, weddingB, { name: "Plantado en B" })).error?.code).toBe(PERMISSION_DENIED);
    }
    expect(await sql("select 1 from public.wedding_vendors where name = 'Plantado en B'")).toEqual([]);
  });
});

// -------------------------------------------------------------------- name

describe("vendor name", () => {
  it("stores a valid name with database provenance; names may repeat", async () => {
    const first = await createVendor("collabA", weddingA, { name: "Música Viva" });
    const second = await createVendor("ownerA", weddingA, { name: "Música Viva" });
    expect(first).not.toBe(second);
    expect(await rowOf(first)).toMatchObject({
      name: "Música Viva",
      status: "considering",
      wedding_id: weddingA,
      created_by: users.collabA.id,
    });
  });

  it("rejects blank, padded, over-long and control-character names", async () => {
    for (const name of ["", " ", " Flores", "Flores ", "x".repeat(121), "Flo\u0007res", "Flo\nres", "Flo\u0085res"]) {
      expect(await insertCode({ name }), JSON.stringify(name)).toBe(CHECK_VIOLATION);
    }
    expect(await insertCode({ name: "x".repeat(120) })).toBeNull();
    expect(await insertCode({ name: "💐".repeat(120) })).toBeNull();
  });
});

// ---------------------------------------------------------------- category

describe("vendor category", () => {
  it("is exactly the sixteen planned categories", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.wedding_vendor_category'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "venue",
      "catering",
      "photography",
      "video",
      "music",
      "flowers_decor",
      "cake_desserts",
      "beauty",
      "attire",
      "officiant",
      "stationery",
      "transport",
      "lodging",
      "rentals",
      "planning",
      "other",
    ]);
  });

  it("accepts every category (other with a custom category)", async () => {
    const rows = await sql<{ label: Database["public"]["Enums"]["wedding_vendor_category"] }>(
      "select enumlabel as label from pg_enum where enumtypid = 'public.wedding_vendor_category'::regtype",
    );
    for (const { label } of rows) {
      const extra = label === "other" ? { custom_category: "Seguridad" } : {};
      expect(await insertCode({ name: `Categoría ${label}`, category: label, ...extra }), label).toBeNull();
    }
  });

  it("rejects an unknown category", async () => {
    const code = await insertCode({ category: "florist" as VendorInsert["category"] });
    expect(code).toBe(INVALID_TEXT_REPRESENTATION);
  });

  it("requires a custom category exactly for other", async () => {
    expect(await insertCode({ category: "other", custom_category: null })).toBe(CHECK_VIOLATION);
    expect(await insertCode({ category: "photography", custom_category: "Fotos" })).toBe(CHECK_VIOLATION);
    expect(await insertCode({ category: "photography", custom_category: null })).toBeNull();
    expect(await insertCode({ category: "other", custom_category: "Seguridad" })).toBeNull();

    // Switching away from other must clear it, and switching to other must add it.
    const vendorId = await createVendor("ownerA", weddingA, { category: "other", custom_category: "Seguridad" });
    const keep = await as.ownerA.from("wedding_vendors").update({ category: "music" }).eq("id", vendorId);
    expect(keep.error?.code).toBe(CHECK_VIOLATION);
    const both = await as.ownerA.from("wedding_vendors").update({ category: "music", custom_category: null }).eq("id", vendorId);
    expect(both.error).toBeNull();
  });

  it("enforces custom category bounds and plain text", async () => {
    for (const custom of ["", " ", " Seguridad", "Seguridad ", "x".repeat(61), "Segu\u0001ridad", "Segu\tridad"]) {
      expect(await insertCode({ category: "other", custom_category: custom }), JSON.stringify(custom)).toBe(CHECK_VIOLATION);
    }
    expect(await insertCode({ category: "other", custom_category: "x".repeat(60) })).toBeNull();
  });
});

// ------------------------------------------------------------------ status

describe("vendor status", () => {
  it("is exactly the five planned statuses", async () => {
    const rows = await sql<{ label: string }>(
      `select enumlabel as label from pg_enum
       where enumtypid = 'public.wedding_vendor_status'::regtype order by enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["considering", "quoted", "selected", "booked", "discarded"]);
  });

  it("accepts all five statuses and rejects anything else", async () => {
    for (const status of ["considering", "quoted", "selected", "booked", "discarded"] as const) {
      expect(await insertCode({ status }), status).toBeNull();
    }
    for (const status of ["paid", "contacted", "completed", "archived"]) {
      expect(await insertCode({ status: status as VendorInsert["status"] }), status).toBe(INVALID_TEXT_REPRESENTATION);
    }
  });

  it("allows any jump between statuses (no state machine)", async () => {
    const vendorId = await createVendor("ownerA", weddingA, { name: "Saltos" });
    for (const status of ["booked", "considering", "discarded", "selected", "quoted", "booked", "discarded", "considering"] as const) {
      const { error } = await as.collabA.from("wedding_vendors").update({ status }).eq("id", vendorId);
      expect(error, status).toBeNull();
      expect((await rowOf(vendorId))?.status).toBe(status);
    }
  });
});

// ----------------------------------------------------------------- contact

describe("vendor contact", () => {
  it("validates the contact name", async () => {
    expect(await insertCode({ contact_name: "María José Núñez" })).toBeNull();
    for (const name of ["", " Ana", "Ana ", "x".repeat(121), "Ana\u0001"]) {
      expect(await insertCode({ contact_name: name }), JSON.stringify(name)).toBe(CHECK_VIOLATION);
    }
  });

  it("accepts a stored-form email and rejects anything else", async () => {
    expect(await insertCode({ email: "Ventas.Flores+cr@gardenias.co.cr" })).toBeNull();
    for (const email of [
      "sin-arroba",
      "a@b",
      "Ventas@Gardenias.CR", // the domain is stored lowercase
      " a@b.cr",
      "a b@c.cr",
      "ñandú@flores.cr",
      `${"a".repeat(65)}@b.cr`,
      `a@${"b".repeat(250)}.cr`,
    ]) {
      expect(await insertCode({ email }), email).toBe(CHECK_VIOLATION);
    }
  });

  it("accepts conservative phone formats as typed and rejects others", async () => {
    for (const phone of ["8888-1234", "+506 8888 1234", "(506) 2222-3333", "2222", "+1 (555) 010.9999"]) {
      expect(await insertCode({ phone }), phone).toBeNull();
    }
    for (const phone of ["123", "abcd", "+506 8888 1234 ext", " 8888-1234", "8888-", "tel:88881234", "1".repeat(41)]) {
      expect(await insertCode({ phone }), phone).toBe(CHECK_VIOLATION);
    }
  });

  it("stores an Instagram handle without @ and never a URL", async () => {
    expect(await insertCode({ instagram_handle: "floreria.gardenias_cr" })).toBeNull();
    expect(await insertCode({ instagram_handle: "x".repeat(30) })).toBeNull();
    for (const handle of [
      "@floreria",
      "",
      "x".repeat(31),
      "flores cr",
      "flores-cr",
      "https://www.instagram.com/flores/",
      "javascript:alert(1)",
    ]) {
      expect(await insertCode({ instagram_handle: handle }), handle).toBe(CHECK_VIOLATION);
    }
  });
});

// ------------------------------------------------------------------- money

describe("vendor money", () => {
  it("accepts no money at all", async () => {
    expect(await insertCode({ currency: null, quoted_amount_minor: null, contracted_amount_minor: null })).toBeNull();
  });

  it("accepts a quote, a contracted amount, or both, with CRC or USD", async () => {
    const quoted = await createVendor("ownerA", weddingA, { currency: "CRC", quoted_amount_minor: 120_000_000 });
    expect(await rowOf(quoted)).toMatchObject({ currency: "CRC", quoted_amount_minor: "120000000", contracted_amount_minor: null });
    expect(await insertCode({ currency: "USD", contracted_amount_minor: 350_000 })).toBeNull();
    expect(await insertCode({ currency: "USD", quoted_amount_minor: 400_000, contracted_amount_minor: 350_000 })).toBeNull();
  });

  it("requires a currency exactly when an amount exists", async () => {
    expect(await insertCode({ quoted_amount_minor: 100 })).toBe(CHECK_VIOLATION);
    expect(await insertCode({ contracted_amount_minor: 100 })).toBe(CHECK_VIOLATION);
    expect(await insertCode({ currency: "CRC" })).toBe(CHECK_VIOLATION);
    expect(await insertCode({ currency: "USD", quoted_amount_minor: null, contracted_amount_minor: null })).toBe(CHECK_VIOLATION);

    // Clearing the last amount must clear the currency in the same write.
    const vendorId = await createVendor("ownerA", weddingA, { currency: "CRC", quoted_amount_minor: 100 });
    const orphan = await as.ownerA.from("wedding_vendors").update({ quoted_amount_minor: null }).eq("id", vendorId);
    expect(orphan.error?.code).toBe(CHECK_VIOLATION);
    const cleared = await as.ownerA
      .from("wedding_vendors")
      .update({ quoted_amount_minor: null, currency: null })
      .eq("id", vendorId);
    expect(cleared.error).toBeNull();
  });

  it("supports only CRC and USD", async () => {
    for (const currency of ["EUR", "MXN", "crc", "usd", "US$", "₡", ""]) {
      expect(await insertCode({ currency, quoted_amount_minor: 100 }), currency).toBe(CHECK_VIOLATION);
    }
  });

  it("accepts 0 through 99 999 999 999 999 and rejects negatives and larger values", async () => {
    expect(await insertCode({ currency: "CRC", quoted_amount_minor: 0 })).toBeNull();
    expect(await insertCode({ currency: "CRC", contracted_amount_minor: 0 })).toBeNull();
    const max = await createVendor("ownerA", weddingA, { currency: "USD", contracted_amount_minor: 99_999_999_999_999 });
    expect((await rowOf(max))?.contracted_amount_minor).toBe("99999999999999");
    for (const amount of [-1, 100_000_000_000_000]) {
      expect(await insertCode({ currency: "CRC", quoted_amount_minor: amount }), String(amount)).toBe(CHECK_VIOLATION);
      expect(await insertCode({ currency: "CRC", contracted_amount_minor: amount }), String(amount)).toBe(CHECK_VIOLATION);
    }
  });

  it("stores integer minor units (bigint), never decimals", async () => {
    const [column] = await sql<{ quoted: string; contracted: string }>(
      `select format_type(a.atttypid, a.atttypmod) as quoted,
              (select format_type(b.atttypid, b.atttypmod) from pg_attribute b
               where b.attrelid = 'public.wedding_vendors'::regclass and b.attname = 'contracted_amount_minor') as contracted
       from pg_attribute a
       where a.attrelid = 'public.wedding_vendors'::regclass and a.attname = 'quoted_amount_minor'`,
    );
    expect(column).toEqual({ quoted: "bigint", contracted: "bigint" });
    expect(await insertCode({ currency: "CRC", quoted_amount_minor: 1.5 })).toBe(INVALID_TEXT_REPRESENTATION);
  });
});

// ------------------------------------------------------------------- notes

describe("vendor notes", () => {
  it("accepts multiline notes up to 4000 characters", async () => {
    expect(await insertCode({ notes: "Línea 1\nLínea 2\r\n\tLínea 3" })).toBeNull();
    expect(await insertCode({ notes: "x".repeat(4000) })).toBeNull();
  });

  it("rejects blank, padded, over-long and other-control notes", async () => {
    for (const notes of ["", " ", "\nHola", "Hola\n", "x".repeat(4001), "Hola\u0001", "Hola\u000bmundo", "Hola\u0085mundo"]) {
      expect(await insertCode({ notes }), JSON.stringify(notes)).toBe(CHECK_VIOLATION);
    }
  });
});

// -------------------------------------------------------- protected fields

describe("vendor protected fields", () => {
  it("clients can't write ids, the wedding, provenance or timestamps", async () => {
    const vendorId = await createVendor("ownerA", weddingA, { name: "Columnas" });
    const before = await sql<{ updated_at: Date; created_at: Date }>(
      "select created_at, updated_at from public.wedding_vendors where id = $1",
      [vendorId],
    );

    for (const extra of [
      { id: "00000000-0000-4000-8000-000000000001" },
      { created_by: users.collabA.id },
      { created_at: "2000-01-01T00:00:00Z" },
      { updated_at: "2000-01-01T00:00:00Z" },
    ]) {
      const insert = await as.ownerA
        .from("wedding_vendors")
        .insert({ wedding_id: weddingA, name: "X", category: "music", ...extra });
      expect(insert.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
      const update = await as.ownerA.from("wedding_vendors").update(extra).eq("id", vendorId);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    for (const actor of ["ownerA", "collabA"] as const) {
      const move = await as[actor].from("wedding_vendors").update({ wedding_id: weddingB }).eq("id", vendorId);
      expect(move.error?.code).toBe(PERMISSION_DENIED);
    }

    const after = await sql<{ updated_at: Date; created_at: Date }>(
      "select created_at, updated_at from public.wedding_vendors where id = $1",
      [vendorId],
    );
    expect(after).toEqual(before);
    expect(await rowOf(vendorId)).toMatchObject({ wedding_id: weddingA, created_by: users.ownerA.id });
  });

  it("created_by defaults to the caller and updated_at follows edits", async () => {
    const vendorId = await createVendor("collabA", weddingA, { name: "Provenance" });
    expect((await rowOf(vendorId))?.created_by).toBe(users.collabA.id);
    const [before] = await sql<{ updated_at: Date }>("select updated_at from public.wedding_vendors where id = $1", [vendorId]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await as.ownerA.from("wedding_vendors").update({ status: "quoted" }).eq("id", vendorId)).error).toBeNull();
    const [after] = await sql<{ updated_at: Date }>("select updated_at from public.wedding_vendors where id = $1", [vendorId]);
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
    // Provenance is never authority: editing doesn't change it.
    expect((await rowOf(vendorId))?.created_by).toBe(users.collabA.id);
  });
});

// ------------------------------------------------------------------ delete

describe("vendor delete", () => {
  it("a hard delete removes the engagement; discarded is just a status", async () => {
    const discarded = await createVendor("ownerA", weddingA, { name: "Descartado", status: "discarded" });
    expect((await rowOf(discarded))?.status).toBe("discarded");
    const gone = await createVendor("ownerA", weddingA, { name: "Eliminado" });
    expect((await as.collabA.from("wedding_vendors").delete().eq("id", gone).select("id")).data).toEqual([{ id: gone }]);
    expect(await rowOf(gone)).toBeUndefined();
    expect(await rowOf(discarded)).toBeDefined();
  });

  it("deleting a wedding deletes its vendors", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda que se borra");
    const vendorId = await createVendor("ownerA", wedding, { name: "Se va con la boda" });
    await sql("delete from public.weddings where id = $1", [wedding]);
    expect(await rowOf(vendorId)).toBeUndefined();
  });
});

// --------------------------------------------------------------- integrity

describe("vendor integrity", () => {
  it("has UNIQUE (id, wedding_id) for future same-wedding foreign keys", async () => {
    const rows = await sql<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.wedding_vendors'::regclass and contype = 'u'`,
    );
    expect(rows).toEqual([{ name: "wedding_vendors_id_wedding_key", definition: "UNIQUE (id, wedding_id)" }]);
  });

  it("vendor names are not unique within a wedding", async () => {
    const indexes = await sql<{ definition: string }>(
      "select indexdef as definition from pg_indexes where schemaname = 'public' and tablename = 'wedding_vendors' order by indexname",
    );
    expect(indexes.map((i) => i.definition)).toEqual([
      "CREATE UNIQUE INDEX wedding_vendors_id_wedding_key ON public.wedding_vendors USING btree (id, wedding_id)",
      "CREATE UNIQUE INDEX wedding_vendors_pkey ON public.wedding_vendors USING btree (id)",
      "CREATE INDEX wedding_vendors_wedding_created_idx ON public.wedding_vendors USING btree (wedding_id, created_at)",
    ]);
  });

  it("the list read is served by the (wedding_id, created_at) index", async () => {
    const conn = await superuser.connect();
    try {
      await conn.query("begin");
      await conn.query("set local enable_seqscan = off");
      const { rows } = await conn.query<{ "QUERY PLAN": string }>(
        `explain select id from public.wedding_vendors
         where wedding_id = '00000000-0000-4000-8000-000000000001' order by created_at, id`,
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("wedding_vendors_wedding_created_idx");
    } finally {
      await conn.query("rollback");
      conn.release();
    }
  });

  it("has exactly the four member policies and RLS enabled", async () => {
    const policies = await sql<{ name: string; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
      `select policyname as name, cmd, roles::text[] as roles, qual, with_check as check from pg_policies
       where schemaname = 'public' and tablename = 'wedding_vendors' order by policyname`,
    );
    expect(policies.map((p) => [p.name, p.cmd, p.roles])).toEqual([
      ["wedding_vendors_delete_member", "DELETE", ["authenticated"]],
      ["wedding_vendors_insert_member", "INSERT", ["authenticated"]],
      ["wedding_vendors_select_member", "SELECT", ["authenticated"]],
      ["wedding_vendors_update_member", "UPDATE", ["authenticated"]],
    ]);
    for (const p of policies) {
      for (const expr of [p.qual, p.check].filter((e): e is string => e !== null)) {
        expect(expr, p.name).toBe("private.is_wedding_member(wedding_id)");
      }
    }
  });

  it("authenticated may write exactly the editable columns", async () => {
    const rows = await sql<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
       where grantee = 'authenticated' and table_schema = 'public' and table_name = 'wedding_vendors'
         and privilege_type in ('INSERT', 'UPDATE')
       order by privilege_type, column_name`,
    );
    const editable = [
      "category",
      "contact_name",
      "contracted_amount_minor",
      "currency",
      "custom_category",
      "email",
      "instagram_handle",
      "name",
      "notes",
      "phone",
      "quoted_amount_minor",
      "status",
    ];
    expect(rows.filter((r) => r.privilege_type === "INSERT").map((r) => r.column_name)).toEqual(
      [...editable, "wedding_id"].sort(),
    );
    expect(rows.filter((r) => r.privilege_type === "UPDATE").map((r) => r.column_name)).toEqual(editable);
  });

  it("no SECURITY DEFINER or client-callable function touches vendors", async () => {
    const rows = await sql<{ name: string }>(
      `select p.pronamespace::regnamespace || '.' || p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prosrc ilike '%vendor%'`,
    );
    expect(rows).toEqual([]);
  });
});

// ------------------------------------------------------------ public paths

describe("vendor privacy on public paths", () => {
  it("the published site and the guest RSVP view carry no vendor data", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda pública con proveedores");
    await createVendor("ownerA", wedding, {
      name: "Proveedor Secreto Público",
      contact_name: "Contacto Secreto",
      email: "secreto@proveedor.cr",
      phone: "8888-0000",
      notes: "Nota secreta",
      currency: "USD",
      contracted_amount_minor: 123_456,
      status: "booked",
    });

    const slug = `proveedores-${randomBytes(4).toString("hex")}`;
    expect((await as.ownerA.rpc("set_wedding_site_slug", { target_wedding_id: wedding, new_slug: slug })).error).toBeNull();
    const section = await as.ownerA.rpc("save_wedding_site_section", {
      target_wedding_id: wedding,
      section_kind: "intro",
      section_title: "Bienvenidos",
      section_body: "Hola",
      section_visible: true,
    });
    expect(section.error).toBeNull();
    expect((await as.ownerA.rpc("publish_wedding_site", { target_wedding_id: wedding })).error).toBeNull();

    const site = await as.anon.rpc("get_published_wedding_site", { site_slug: slug });
    expect(site.error).toBeNull();
    expect(site.data).not.toBeNull();

    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const party = await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: wedding,
      party_label: "Familia",
      invitation_token_hash: hash,
      invitation_token_ciphertext: shapedEnvelope(),
      guest_names: ["Ana"],
    });
    expect(party.error).toBeNull();
    const rsvp = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: hash });
    expect(rsvp.error).toBeNull();
    const siteSlug = await as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: hash });

    for (const payload of [site.data, rsvp.data, siteSlug.data]) {
      const text = JSON.stringify(payload);
      for (const secret of ["Proveedor Secreto", "Contacto Secreto", "secreto@proveedor", "8888-0000", "Nota secreta", "123456"]) {
        expect(text).not.toContain(secret);
      }
      expect(text.toLowerCase()).not.toContain("vendor");
    }
  });

  it("no anon-callable function references vendors", async () => {
    const rows = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and has_function_privilege('anon', p.oid, 'execute')
         and p.prosrc ilike '%vendor%'`,
    );
    expect(rows).toEqual([]);
  });
});
