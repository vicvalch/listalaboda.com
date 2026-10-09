import { createHash, randomBytes, randomUUID } from "node:crypto";

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
  users,
} from "./support";

// LB-23 (ADR-016): the wedding run of show ("Cronograma"). Exercised as real
// anon/authenticated users through the Data API; the superuser connection
// only arranges fixtures and reads ground truth.

type EntryInsert = Database["public"]["Tables"]["wedding_timeline_entries"]["Insert"];

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
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
  weddingA = await fixtureWedding("ownerA", "Boda Cronograma A");
  weddingB = await fixtureWedding("ownerB", "Boda Cronograma B");
  await addMember(weddingA, "collabA", "collaborator");
});

function insertEntry(actor: keyof typeof as, weddingId: string, fields: Partial<EntryInsert> = {}) {
  return as[actor]
    .from("wedding_timeline_entries")
    .insert({ wedding_id: weddingId, title: "Ceremonia", ...fields })
    .select("id")
    .single();
}

async function createEntry(actor: TestUserKey, weddingId: string, fields: Partial<EntryInsert> = {}): Promise<string> {
  const { data, error } = await insertEntry(actor, weddingId, fields);
  if (error || !data) throw new Error(`entry insert failed: ${error?.message}`);
  return data.id;
}

async function createVendor(weddingId: string, owner: TestUserKey = "ownerA", fields: Record<string, unknown> = {}) {
  const { data, error } = await as[owner]
    .from("wedding_vendors")
    .insert({ wedding_id: weddingId, name: "Banda Sol", category: "music", ...fields })
    .select("id")
    .single();
  if (error || !data) throw new Error(`vendor insert failed: ${error?.message}`);
  return data.id;
}

type Row = {
  wedding_id: string;
  title: string;
  day_offset: number;
  start_time: string | null;
  duration_minutes: number | null;
  wedding_vendor_id: string | null;
  created_by: string | null;
};

async function rowOf(entryId: string): Promise<Row | undefined> {
  const [row] = await sql<Row>(
    `select wedding_id, title, day_offset, start_time::text, duration_minutes, wedding_vendor_id, created_by
     from public.wedding_timeline_entries where id = $1`,
    [entryId],
  );
  return row;
}

/** Inserts as the owner and returns the Postgres error code (null = accepted). */
async function insertCode(fields: Partial<EntryInsert>): Promise<string | null> {
  const { error } = await insertEntry("ownerA", weddingA, fields);
  return error?.code ?? null;
}

/** The named constraint an insert violates, or null. */
async function violated(fields: Partial<EntryInsert>): Promise<string | null> {
  const { error } = await insertEntry("ownerA", weddingA, fields);
  if (!error) return null;
  return /constraint "([^"]+)"/.exec(error.message)?.[1] ?? error.code ?? "error";
}

// ------------------------------------------------------------------ access

describe("timeline access", () => {
  for (const actor of ["ownerA", "collabA"] as const) {
    it(`${actor} can select, insert, update and delete the wedding's entries`, async () => {
      const { data: inserted, error } = await insertEntry(actor, weddingA, { title: `Entrada de ${actor}` });
      expect(error).toBeNull();
      const entryId = inserted!.id;

      const read = await as[actor].from("wedding_timeline_entries").select("id, title").eq("id", entryId);
      expect(read.data).toEqual([{ id: entryId, title: `Entrada de ${actor}` }]);

      const updated = await as[actor]
        .from("wedding_timeline_entries")
        .update({ start_time: "15:30", duration_minutes: 45, phase: "ceremony" })
        .eq("id", entryId)
        .select("id, start_time");
      expect(updated.data).toEqual([{ id: entryId, start_time: "15:30:00" }]);

      const deleted = await as[actor].from("wedding_timeline_entries").delete().eq("id", entryId).select("id");
      expect(deleted.data).toEqual([{ id: entryId }]);
      expect(await rowOf(entryId)).toBeUndefined();
    });
  }

  it("a non-member sees nothing and cannot write", async () => {
    const entryId = await createEntry("ownerA", weddingA, { title: "Privado", notes: "Nota privada" });
    for (const actor of ["outsider", "ownerB"] as const) {
      expect((await as[actor].from("wedding_timeline_entries").select("id").eq("wedding_id", weddingA)).data).toEqual([]);
      expect((await as[actor].from("wedding_timeline_entries").select("id").eq("id", entryId)).data).toEqual([]);
      expect((await insertEntry(actor, weddingA, { title: "Intruso" })).error?.code).toBe(PERMISSION_DENIED);
      const update = await as[actor].from("wedding_timeline_entries").update({ title: "Hackeado" }).eq("id", entryId).select("id");
      expect(update.data).toEqual([]);
      const del = await as[actor].from("wedding_timeline_entries").delete().eq("id", entryId).select("id");
      expect(del.data).toEqual([]);
    }
    expect((await rowOf(entryId))?.title).toBe("Privado");
  });

  it("anon can neither read nor write entries", async () => {
    const entryId = await createEntry("ownerA", weddingA, { title: "Anon" });
    expect((await as.anon.from("wedding_timeline_entries").select("id")).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.anon.from("wedding_timeline_entries").select("id").eq("id", entryId)).error?.code).toBe(PERMISSION_DENIED);
    expect((await insertEntry("anon", weddingA, { title: "Anon" })).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.anon.from("wedding_timeline_entries").update({ title: "X" }).eq("id", entryId)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await as.anon.from("wedding_timeline_entries").delete().eq("id", entryId)).error?.code).toBe(PERMISSION_DENIED);
    expect((await rowOf(entryId))?.title).toBe("Anon");
  });
});

// ----------------------------------------------------------------- tenancy

describe("timeline tenancy", () => {
  it("a known entry id of another wedding is invisible and untouchable", async () => {
    const foreign = await createEntry("ownerB", weddingB, { title: "De B" });
    expect((await as.ownerA.from("wedding_timeline_entries").select("id").eq("id", foreign)).data).toEqual([]);
    expect((await as.ownerA.from("wedding_timeline_entries").update({ title: "X" }).eq("id", foreign).select("id")).data).toEqual([]);
    expect((await as.ownerA.from("wedding_timeline_entries").delete().eq("id", foreign).select("id")).data).toEqual([]);
    expect((await rowOf(foreign))?.title).toBe("De B");
  });

  it("a member of A cannot insert into wedding B", async () => {
    expect((await insertEntry("ownerA", weddingB, { title: "Cruce" })).error?.code).toBe(PERMISSION_DENIED);
  });

  it("wedding_id can't be changed (no UPDATE grant)", async () => {
    const entryId = await createEntry("ownerA", weddingA);
    const moved = await as.ownerA
      .from("wedding_timeline_entries")
      .update({ wedding_id: weddingB } as never)
      .eq("id", entryId);
    expect(moved.error?.code).toBe(PERMISSION_DENIED);
    expect((await rowOf(entryId))?.wedding_id).toBe(weddingA);
  });
});

// ------------------------------------------------------------------ vendor

describe("timeline vendor link", () => {
  it("no vendor and a same-wedding vendor are valid", async () => {
    const vendorId = await createVendor(weddingA);
    expect(await insertCode({ wedding_vendor_id: null })).toBeNull();
    const entryId = await createEntry("collabA", weddingA, { wedding_vendor_id: vendorId });
    expect((await rowOf(entryId))?.wedding_vendor_id).toBe(vendorId);
  });

  it("a vendor of wedding B can't be linked to an entry of wedding A, on insert or update", async () => {
    const foreignVendor = await createVendor(weddingB, "ownerB");
    expect(await insertCode({ wedding_vendor_id: foreignVendor })).toBe(FOREIGN_KEY_VIOLATION);
    const entryId = await createEntry("ownerA", weddingA);
    const update = await as.ownerA
      .from("wedding_timeline_entries")
      .update({ wedding_vendor_id: foreignVendor })
      .eq("id", entryId);
    expect(update.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect((await rowOf(entryId))?.wedding_vendor_id).toBeNull();
  });

  it("an unknown or malformed vendor id is refused", async () => {
    expect(await insertCode({ wedding_vendor_id: randomUUID() })).toBe(FOREIGN_KEY_VIOLATION);
    expect(await insertCode({ wedding_vendor_id: "not-a-uuid" })).toBe(INVALID_TEXT_REPRESENTATION);
  });

  it("deleting the vendor unlinks the entry: it survives with its wedding, title and time", async () => {
    const vendorId = await createVendor(weddingA, "ownerA", { name: "Se elimina" });
    const entryId = await createEntry("ownerA", weddingA, {
      title: "Llega el DJ",
      start_time: "14:00",
      wedding_vendor_id: vendorId,
    });
    const del = await as.collabA.from("wedding_vendors").delete().eq("id", vendorId).select("id");
    expect(del.data).toEqual([{ id: vendorId }]);
    expect(await rowOf(entryId)).toMatchObject({
      wedding_id: weddingA,
      title: "Llega el DJ",
      start_time: "14:00:00",
      wedding_vendor_id: null,
    });
  });

  it("a vendor with financial records still can't be deleted (LB-22), linked or not", async () => {
    const vendorId = await createVendor(weddingA, "ownerA", {
      name: "Con pagos",
      status: "booked",
      currency: "USD",
      contracted_amount_minor: 100_000,
    });
    const entryId = await createEntry("ownerA", weddingA, { wedding_vendor_id: vendorId });
    const payment = await as.ownerA
      .from("vendor_payments")
      .insert({ wedding_id: weddingA, wedding_vendor_id: vendorId, amount_minor: 1_000, paid_on: "2026-10-01" })
      .select("id")
      .single();
    expect(payment.error).toBeNull();
    const del = await as.ownerA.from("wedding_vendors").delete().eq("id", vendorId).select("id");
    expect(del.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await sql("select 1 from public.wedding_vendors where id = $1", [vendorId])).toHaveLength(1);
    expect((await rowOf(entryId))?.wedding_vendor_id).toBe(vendorId);
  });

  it("the FK is the composite same-wedding key with a column-list SET NULL", async () => {
    const rows = await sql<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.wedding_timeline_entries'::regclass and contype = 'f' order by conname`,
    );
    expect(rows).toEqual([
      {
        name: "wedding_timeline_entries_created_by_fkey",
        definition: "FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL",
      },
      {
        name: "wedding_timeline_entries_vendor_same_wedding",
        definition:
          "FOREIGN KEY (wedding_vendor_id, wedding_id) REFERENCES wedding_vendors(id, wedding_id) ON DELETE SET NULL (wedding_vendor_id)",
      },
      {
        name: "wedding_timeline_entries_wedding_id_fkey",
        definition: "FOREIGN KEY (wedding_id) REFERENCES weddings(id) ON DELETE CASCADE",
      },
    ]);
  });
});

// ------------------------------------------------------------- text fields

describe("timeline text", () => {
  it("title: required, 1–120, trimmed, plain text, not unique", async () => {
    expect(await insertCode({ title: "a".repeat(120) })).toBeNull();
    expect(await insertCode({ title: "Ceremonia" })).toBeNull();
    expect(await insertCode({ title: "Ceremonia" })).toBeNull();
    for (const bad of ["", " ", " Ceremonia", "Ceremonia ", "a".repeat(121), "Cere\nmonia", "a\u0007"]) {
      expect(await violated({ title: bad }), JSON.stringify(bad)).toBe("wedding_timeline_entries_title_valid");
    }
  });

  it("location and responsible: optional, 1–120, trimmed, plain text", async () => {
    for (const column of ["location", "responsible_name"] as const) {
      const constraint = `wedding_timeline_entries_${column}_valid`;
      expect(await insertCode({ [column]: null })).toBeNull();
      expect(await insertCode({ [column]: "Hotel · Suite 405" })).toBeNull();
      expect(await insertCode({ [column]: "a".repeat(120) })).toBeNull();
      for (const bad of ["", " x", "x ", "a".repeat(121), "a\tb", "a\u0001b"]) {
        expect(await violated({ [column]: bad }), `${column} ${JSON.stringify(bad)}`).toBe(constraint);
      }
    }
  });

  it("notes: optional, multiline, ≤ 4000, no other control characters", async () => {
    expect(await insertCode({ notes: null })).toBeNull();
    expect(await insertCode({ notes: "Línea 1\r\nLínea 2\n\tSangría" })).toBeNull();
    expect(await insertCode({ notes: "a".repeat(4000) })).toBeNull();
    for (const bad of ["", " x", "x\n", "a".repeat(4001), "a\u0007b", "a\u000bb"]) {
      expect(await violated({ notes: bad }), JSON.stringify(bad)).toBe("wedding_timeline_entries_notes_valid");
    }
  });
});

// ------------------------------------------------------------------ timing

describe("timeline timing", () => {
  it("day_offset is exactly 0 or 1 (default 0)", async () => {
    const entryId = await createEntry("ownerA", weddingA);
    expect((await rowOf(entryId))?.day_offset).toBe(0);
    expect(await insertCode({ day_offset: 1 })).toBeNull();
    expect(await violated({ day_offset: -1 })).toBe("wedding_timeline_entries_day_offset_valid");
    expect(await violated({ day_offset: 2 })).toBe("wedding_timeline_entries_day_offset_valid");
  });

  it("start_time: null or a whole minute strictly before 24:00", async () => {
    for (const ok of [null, "00:00", "07:05", "23:59"]) {
      expect(await insertCode({ start_time: ok }), String(ok)).toBeNull();
    }
    for (const bad of ["15:30:30", "15:30:00.5", "24:00"]) {
      expect(await violated({ start_time: bad }), bad).toBe("wedding_timeline_entries_start_time_valid");
    }
    // Not a time at all.
    expect(await insertCode({ start_time: "25:00" })).not.toBeNull();
    expect(await insertCode({ start_time: "nope" })).not.toBeNull();
  });

  it("duration: null or 1–1440", async () => {
    expect(await insertCode({ duration_minutes: null })).toBeNull();
    expect(await insertCode({ duration_minutes: 1 })).toBeNull();
    expect(await insertCode({ start_time: "00:00", duration_minutes: 1440 })).toBeNull();
    expect(await violated({ duration_minutes: 0 })).toBe("wedding_timeline_entries_duration_valid");
    expect(await violated({ duration_minutes: 1441 })).toBe("wedding_timeline_entries_duration_valid");
    expect(await violated({ duration_minutes: -5 })).toBe("wedding_timeline_entries_duration_valid");
  });

  it("the window: a timed span ends by midnight after day 1, never later", async () => {
    const ok: Partial<EntryInsert>[] = [
      { day_offset: 0, start_time: "23:45", duration_minutes: 60 },
      { day_offset: 1, start_time: "00:30", duration_minutes: 120 },
      { day_offset: 1, start_time: "22:00", duration_minutes: 120 },
      { day_offset: 1, start_time: "23:30", duration_minutes: 30 },
      { day_offset: 1, start_time: "00:00", duration_minutes: 1440 },
      // No start: not evaluated.
      { day_offset: 1, start_time: null, duration_minutes: 1440 },
    ];
    for (const fields of ok) expect(await insertCode(fields), JSON.stringify(fields)).toBeNull();
    const bad: Partial<EntryInsert>[] = [
      { day_offset: 1, start_time: "23:30", duration_minutes: 31 },
      { day_offset: 1, start_time: "23:30", duration_minutes: 120 },
      { day_offset: 1, start_time: "00:01", duration_minutes: 1440 },
    ];
    for (const fields of bad) {
      expect(await violated(fields), JSON.stringify(fields)).toBe("wedding_timeline_entries_end_within_window");
    }
  });

  it("an update can't push an existing span out of the window either", async () => {
    const entryId = await createEntry("ownerA", weddingA, { day_offset: 1, start_time: "23:00", duration_minutes: 60 });
    const update = await as.ownerA
      .from("wedding_timeline_entries")
      .update({ duration_minutes: 61 })
      .eq("id", entryId);
    expect(update.error?.code).toBe(CHECK_VIOLATION);
    expect((await rowOf(entryId))?.duration_minutes).toBe(60);
  });

  it("overlapping and identical start times are all accepted", async () => {
    for (const title of ["Floristería", "DJ prueba de sonido", "Fotos de detalles"]) {
      expect(await insertCode({ title, start_time: "14:00", duration_minutes: 90 })).toBeNull();
    }
    expect(await insertCode({ title: "Floristería", start_time: "14:00", duration_minutes: 90 })).toBeNull();
  });

  it("phase: the seven values or null", async () => {
    const values = await sql<{ value: string }>(
      "select unnest(enum_range(null::public.wedding_timeline_phase))::text as value",
    );
    expect(values.map((v) => v.value)).toEqual([
      "getting_ready",
      "setup",
      "ceremony",
      "photos",
      "cocktail",
      "reception",
      "closing",
    ]);
    for (const { value } of values) {
      expect(await insertCode({ phase: value as EntryInsert["phase"] })).toBeNull();
    }
    expect(await insertCode({ phase: null })).toBeNull();
    expect(await insertCode({ phase: "other" as never })).toBe(INVALID_TEXT_REPRESENTATION);
  });
});

// ---------------------------------------------------- protected / deletion

describe("timeline protected fields and deletion", () => {
  it("clients can't write ids, provenance or timestamps; created_by defaults to the caller", async () => {
    for (const fields of [
      { id: randomUUID() },
      { created_by: users.collabA.id },
      { created_at: "2020-01-01T00:00:00Z" },
      { updated_at: "2020-01-01T00:00:00Z" },
    ]) {
      expect((await insertEntry("ownerA", weddingA, fields as never)).error?.code, JSON.stringify(fields)).toBe(
        PERMISSION_DENIED,
      );
    }
    const entryId = await createEntry("collabA", weddingA);
    expect((await rowOf(entryId))?.created_by).toBe(users.collabA.id);
    for (const fields of [{ id: randomUUID() }, { created_by: users.ownerA.id }, { created_at: "2020-01-01T00:00:00Z" }]) {
      const update = await as.ownerA.from("wedding_timeline_entries").update(fields as never).eq("id", entryId);
      expect(update.error?.code, JSON.stringify(fields)).toBe(PERMISSION_DENIED);
    }
  });

  it("updated_at follows edits", async () => {
    const entryId = await createEntry("ownerA", weddingA);
    const [before] = await sql<{ updated_at: Date }>("select updated_at from public.wedding_timeline_entries where id = $1", [entryId]);
    await as.ownerA.from("wedding_timeline_entries").update({ title: "Editada" }).eq("id", entryId);
    const [after] = await sql<{ updated_at: Date }>("select updated_at from public.wedding_timeline_entries where id = $1", [entryId]);
    // Changed, not "greater": the local Docker clock can step backwards (WSL time sync).
    expect(after!.updated_at.getTime()).not.toBe(before!.updated_at.getTime());
  });

  it("deleting a wedding deletes its timeline (and its vendors, whose SET NULL doesn't get in the way)", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda que se borra");
    const vendorId = await createVendor(wedding);
    const entryId = await createEntry("ownerA", wedding, { wedding_vendor_id: vendorId });
    await sql("delete from public.weddings where id = $1", [wedding]);
    expect(await rowOf(entryId)).toBeUndefined();
  });

  it("deleting the creator's account keeps the entry with created_by null", async () => {
    const userId = randomUUID();
    await sql(
      `insert into auth.users (id, aud, role, email, created_at, updated_at)
       values ($1, 'authenticated', 'authenticated', $2, now(), now())`,
      [userId, `timeline-${userId}@example.test`],
    );
    const [row] = await sql<{ id: string }>(
      `insert into public.wedding_timeline_entries (wedding_id, title, created_by)
       values ($1, 'De una cuenta borrada', $2) returning id`,
      [weddingA, userId],
    );
    await sql("delete from auth.users where id = $1", [userId]);
    expect(await rowOf(row!.id)).toMatchObject({ title: "De una cuenta borrada", created_by: null, wedding_id: weddingA });
  });
});

// ---------------------------------------------------------------- catalog

describe("timeline catalog", () => {
  it("has no stored execution status, end, ordering, priority or participant columns", async () => {
    const columns = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'wedding_timeline_entries' order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "id",
      "wedding_id",
      "title",
      "day_offset",
      "start_time",
      "duration_minutes",
      "phase",
      "location",
      "responsible_name",
      "wedding_vendor_id",
      "notes",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    for (const absent of [
      "status",
      "is_completed",
      "completed_at",
      "is_delayed",
      "started_at",
      "finished_at",
      "end_time",
      "sort_order",
      "is_key_moment",
      "priority",
      "guest_id",
      "member_id",
    ]) {
      expect(columns.map((c) => c.column_name)).not.toContain(absent);
    }
  });

  it("has only the planned indexes and no uniqueness over time", async () => {
    const indexes = await sql<{ definition: string }>(
      "select indexdef as definition from pg_indexes where schemaname = 'public' and tablename = 'wedding_timeline_entries' order by indexname",
    );
    expect(indexes.map((i) => i.definition)).toEqual([
      "CREATE UNIQUE INDEX wedding_timeline_entries_pkey ON public.wedding_timeline_entries USING btree (id)",
      "CREATE INDEX wedding_timeline_entries_vendor_idx ON public.wedding_timeline_entries USING btree (wedding_vendor_id, wedding_id) WHERE (wedding_vendor_id IS NOT NULL)",
      "CREATE INDEX wedding_timeline_entries_wedding_time_idx ON public.wedding_timeline_entries USING btree (wedding_id, day_offset, start_time)",
    ]);
  });

  it("has exactly the four member policies and RLS enabled", async () => {
    const [table] = await sql<{ rls: boolean }>(
      "select relrowsecurity as rls from pg_class where oid = 'public.wedding_timeline_entries'::regclass",
    );
    expect(table?.rls).toBe(true);
    const policies = await sql<{ name: string; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
      `select policyname as name, cmd, roles::text[] as roles, qual, with_check as check from pg_policies
       where schemaname = 'public' and tablename = 'wedding_timeline_entries' order by policyname`,
    );
    expect(policies.map((p) => [p.name, p.cmd, p.roles])).toEqual([
      ["wedding_timeline_entries_delete_member", "DELETE", ["authenticated"]],
      ["wedding_timeline_entries_insert_member", "INSERT", ["authenticated"]],
      ["wedding_timeline_entries_select_member", "SELECT", ["authenticated"]],
      ["wedding_timeline_entries_update_member", "UPDATE", ["authenticated"]],
    ]);
    for (const p of policies) {
      for (const expr of [p.qual, p.check].filter((e): e is string => e !== null)) {
        expect(expr, p.name).toBe("private.is_wedding_member(wedding_id)");
      }
    }
  });

  it("authenticated may write exactly the editable columns; anon nothing", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where grantee in ('authenticated', 'anon') and table_schema = 'public'
         and table_name = 'wedding_timeline_entries' and privilege_type in ('INSERT', 'UPDATE')
       order by grantee, privilege_type, column_name`,
    );
    const editable = [
      "day_offset",
      "duration_minutes",
      "location",
      "notes",
      "phase",
      "responsible_name",
      "start_time",
      "title",
      "wedding_vendor_id",
    ];
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(rows.filter((r) => r.privilege_type === "INSERT").map((r) => r.column_name)).toEqual(
      [...editable, "wedding_id"].sort(),
    );
    expect(rows.filter((r) => r.privilege_type === "UPDATE").map((r) => r.column_name)).toEqual(editable);
    const tableGrants = await sql<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'wedding_timeline_entries'
         and grantee in ('anon', 'authenticated') order by grantee, privilege_type`,
    );
    expect(tableGrants).toEqual([
      { grantee: "authenticated", privilege_type: "DELETE" },
      { grantee: "authenticated", privilege_type: "SELECT" },
    ]);
  });

  it("no function references the timeline (no RPC, SECURITY DEFINER or public reader)", async () => {
    const rows = await sql<{ name: string }>(
      `select p.pronamespace::regnamespace || '.' || p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prosrc ilike '%timeline%'`,
    );
    expect(rows).toEqual([]);
  });
});

// ------------------------------------------------------------ public paths

describe("timeline privacy on public paths", () => {
  it("the published site and the guest RSVP view carry no timeline data", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda pública con cronograma");
    const vendorId = await createVendor(wedding, "ownerA", { name: "Proveedor Cronograma", phone: "8777-6655" });
    await createEntry("ownerA", wedding, {
      title: "Actividad Secreta Cronograma",
      notes: "Nota secreta del cronograma",
      location: "Bodega secreta",
      responsible_name: "Responsable Secreto",
      wedding_vendor_id: vendorId,
      start_time: "15:30",
    });

    const slug = `cronograma-${randomBytes(4).toString("hex")}`;
    expect((await as.ownerA.rpc("set_wedding_site_slug", { target_wedding_id: wedding, new_slug: slug })).error).toBeNull();
    const section = await as.ownerA.rpc("save_wedding_site_section", {
      target_wedding_id: wedding,
      section_kind: "schedule",
      section_title: "Programa",
      section_body: "Ceremonia a las 15:30",
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
      for (const secret of ["Actividad Secreta", "Nota secreta", "Bodega secreta", "Responsable Secreto", "8777-6655", "Proveedor Cronograma"]) {
        expect(text).not.toContain(secret);
      }
      expect(text.toLowerCase()).not.toContain("timeline");
    }
  });
});
