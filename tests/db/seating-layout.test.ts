import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import { PERMISSION_DENIED, addMember, as, createWedding as createFixtureWedding, shapedEnvelope, sql, users } from "./support";

// LB-20 (ADR-013): the visual planner's layout state on seating_tables —
// shape (closed enum, visual only) and the table center (layout_x/layout_y,
// both or neither, 0–10000). Exercised as real anon/authenticated users
// through the Data API; the superuser connection only arranges fixtures and
// reads ground truth. The LB-19 invariants (capacity, assignments) are in
// seating.test.ts and must be untouched by layout writes.

const CHECK_VIOLATION = "23514";
const INVALID_ENUM = "22P02";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

async function createTable(weddingId: string, name: string, capacity: number): Promise<string> {
  const { data, error } = await as.ownerA
    .from("seating_tables")
    .insert({ wedding_id: weddingId, name, capacity })
    .select("id")
    .single();
  if (error || !data) throw new Error(`table insert failed: ${error?.message}`);
  return data.id;
}

async function createGuests(weddingId: string, label: string, names: string[]): Promise<string[]> {
  const hash = createHash("sha256").update(randomBytes(32).toString("base64url"), "utf8").digest("hex");
  const { data, error } = await as.ownerA.rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: names,
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  const rows = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at, id",
    [data],
  );
  return rows.map((r) => r.id);
}

async function seat(weddingId: string, guestId: string, tableId: string) {
  const { error } = await as.ownerA
    .from("seating_assignments")
    .insert({ guest_id: guestId, wedding_id: weddingId, seating_table_id: tableId });
  if (error) throw new Error(`seat failed: ${error.message}`);
}

type TableRow = {
  name: string;
  capacity: number;
  shape: string;
  layout_x: number | null;
  layout_y: number | null;
  sort_order: number;
  created_by: string | null;
};

async function tableRow(tableId: string): Promise<TableRow | undefined> {
  const [row] = await sql<TableRow>(
    "select name, capacity, shape::text as shape, layout_x, layout_y, sort_order, created_by from public.seating_tables where id = $1",
    [tableId],
  );
  return row;
}

async function assignmentsAt(tableId: string): Promise<string[]> {
  const rows = await sql<{ guest_id: string }>(
    "select guest_id from public.seating_assignments where seating_table_id = $1 order by guest_id",
    [tableId],
  );
  return rows.map((r) => r.guest_id);
}

function setLayout(actor: keyof typeof as, tableId: string, layout: { layout_x?: number | null; layout_y?: number | null }) {
  return as[actor].from("seating_tables").update(layout).eq("id", tableId).select("id, layout_x, layout_y");
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Plano A");
  weddingB = await fixtureWedding("ownerB", "Boda Plano B");
  await addMember(weddingA, "collabA", "collaborator");
});

// -------------------------------------------------------------------- shape

describe("seating table shape", () => {
  it("defaults to round, with no position", async () => {
    const tableId = await createTable(weddingA, "Mesa por defecto", 8);
    expect(await tableRow(tableId)).toMatchObject({ shape: "round", layout_x: null, layout_y: null });
  });

  it.each(["round", "rectangle"] as const)("stores a valid %s table", async (shape) => {
    const { data, error } = await as.collabA
      .from("seating_tables")
      .insert({ wedding_id: weddingA, name: `Mesa ${shape}`, capacity: 6, shape })
      .select("id, shape")
      .single();
    expect(error).toBeNull();
    expect(data?.shape).toBe(shape);
  });

  it("refuses an unknown shape on insert and update", async () => {
    const tableId = await createTable(weddingA, "Mesa forma", 4);
    for (const shape of ["oval", "square", "", "ROUND"]) {
      const insert = await as.ownerA
        .from("seating_tables")
        .insert({ wedding_id: weddingA, name: "Mesa rara", capacity: 4, shape: shape as "round" });
      expect(insert.error?.code, shape).toBe(INVALID_ENUM);
      const update = await as.ownerA.from("seating_tables").update({ shape: shape as "round" }).eq("id", tableId);
      expect(update.error?.code, shape).toBe(INVALID_ENUM);
    }
    expect((await tableRow(tableId))?.shape).toBe("round");
  });

  it("the enum is exactly round and rectangle", async () => {
    const rows = await sql<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       where e.enumtypid = 'public.seating_table_shape'::regtype order by e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual(["round", "rectangle"]);
  });
});

// ------------------------------------------------------------------- layout

describe("seating table layout constraints", () => {
  it("accepts both coordinates null, both set, and the 0 and 10000 bounds", async () => {
    const tableId = await createTable(weddingA, "Mesa límites", 4);
    for (const layout of [
      { layout_x: 0, layout_y: 0 },
      { layout_x: 10_000, layout_y: 10_000 },
      { layout_x: 600, layout_y: 340 },
      { layout_x: null, layout_y: null },
    ]) {
      const { error } = await setLayout("ownerA", tableId, layout);
      expect(error, JSON.stringify(layout)).toBeNull();
      expect(await tableRow(tableId)).toMatchObject(layout);
    }
  });

  it.each([
    ["x without y", { layout_x: 100, layout_y: null }],
    ["y without x", { layout_x: null, layout_y: 100 }],
    ["negative x", { layout_x: -1, layout_y: 100 }],
    ["negative y", { layout_x: 100, layout_y: -20 }],
    ["x above 10000", { layout_x: 10_001, layout_y: 100 }],
    ["y above 10000", { layout_x: 100, layout_y: 10_020 }],
  ])("refuses %s", async (_label, layout) => {
    const tableId = await createTable(weddingA, "Mesa inválida", 4);
    await setLayout("ownerA", tableId, { layout_x: 200, layout_y: 200 });
    const { error } = await setLayout("ownerA", tableId, layout);
    expect(error?.code).toBe(CHECK_VIOLATION);
    expect(await tableRow(tableId)).toMatchObject({ layout_x: 200, layout_y: 200 });
  });

  it("refuses a half-placed table on insert too", async () => {
    const pair = await sql<{ ok: boolean }>(
      `select pg_get_constraintdef(oid) ilike '%layout_x IS NULL%layout_y IS NULL%' as ok
       from pg_constraint where conname = 'seating_tables_layout_pair'`,
    );
    expect(pair).toEqual([{ ok: true }]);
    // Clients can't insert coordinates at all (no INSERT grant); the CHECK covers every role.
    await expect(
      sql(
        "insert into public.seating_tables (wedding_id, name, capacity, layout_x) values ($1, 'Mesa medio', 4, 100)",
        [weddingA],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("is plain integers: no fractional or textual coordinates", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'seating_tables'
         and column_name in ('shape', 'layout_x', 'layout_y') order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "layout_x", data_type: "integer", is_nullable: "YES" },
      { column_name: "layout_y", data_type: "integer", is_nullable: "YES" },
      { column_name: "shape", data_type: "USER-DEFINED", is_nullable: "NO" },
    ]);
  });
});

// ------------------------------------------------------------------- access

describe("seating layout access", () => {
  it.each(["ownerA", "collabA"] as const)("%s reads the layout and updates shape and position", async (actor) => {
    const tableId = await createTable(weddingA, `Mesa acceso ${actor}`, 6);
    const shape = await as[actor].from("seating_tables").update({ shape: "rectangle" }).eq("id", tableId).select("shape");
    expect(shape.data).toEqual([{ shape: "rectangle" }]);
    const moved = await setLayout(actor, tableId, { layout_x: 480, layout_y: 260 });
    expect(moved.data).toEqual([{ id: tableId, layout_x: 480, layout_y: 260 }]);
    const read = await as[actor].from("seating_tables").select("shape, layout_x, layout_y").eq("id", tableId);
    expect(read.data).toEqual([{ shape: "rectangle", layout_x: 480, layout_y: 260 }]);
  });

  it("members can't write sort_order, created_by, timestamps, ids or the wedding through a layout write", async () => {
    const tableId = await createTable(weddingA, "Mesa columnas plano", 4);
    const before = await tableRow(tableId);
    for (const extra of [
      { sort_order: 5 },
      { created_by: users.collabA.id },
      { created_at: "2000-01-01T00:00:00Z" },
      { updated_at: "2000-01-01T00:00:00Z" },
      { id: "00000000-0000-4000-8000-000000000001" },
      { wedding_id: weddingB },
    ]) {
      const update = await as.collabA
        .from("seating_tables")
        .update({ layout_x: 100, layout_y: 100, ...extra })
        .eq("id", tableId);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    // Coordinates can't be set on insert either: a new table is never placed.
    const insert = await as.ownerA
      .from("seating_tables")
      .insert({ wedding_id: weddingA, name: "Mesa colocada", capacity: 4, layout_x: 100, layout_y: 100 });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    expect(await tableRow(tableId)).toEqual(before);
  });

  it("column grants are exactly the LB-19 set plus shape (insert) and shape/layout (update)", async () => {
    const rows = await sql<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
       where grantee = 'authenticated' and table_schema = 'public' and table_name = 'seating_tables'
         and privilege_type in ('INSERT', 'UPDATE')
       order by privilege_type, column_name`,
    );
    expect(rows).toEqual([
      { privilege_type: "INSERT", column_name: "capacity" },
      { privilege_type: "INSERT", column_name: "name" },
      { privilege_type: "INSERT", column_name: "shape" },
      { privilege_type: "INSERT", column_name: "wedding_id" },
      { privilege_type: "UPDATE", column_name: "capacity" },
      { privilege_type: "UPDATE", column_name: "layout_x" },
      { privilege_type: "UPDATE", column_name: "layout_y" },
      { privilege_type: "UPDATE", column_name: "name" },
      { privilege_type: "UPDATE", column_name: "shape" },
    ]);
  });

  it("a non-member can't see or change the layout (zero rows, and refused without RETURNING)", async () => {
    const tableId = await createTable(weddingA, "Mesa ajena plano", 4);
    await setLayout("ownerA", tableId, { layout_x: 300, layout_y: 300 });
    for (const actor of ["outsider", "ownerB"] as const) {
      expect((await as[actor].from("seating_tables").select("layout_x").eq("id", tableId)).data).toEqual([]);
      expect((await setLayout(actor, tableId, { layout_x: 900, layout_y: 900 })).data).toEqual([]);
      // return=minimal: only the UPDATE policy can stop it.
      await as[actor].from("seating_tables").update({ layout_x: 700, layout_y: 700, shape: "rectangle" }).eq("id", tableId);
    }
    expect(await tableRow(tableId)).toMatchObject({ shape: "round", layout_x: 300, layout_y: 300 });
  });

  it("anon can neither read nor write the layout", async () => {
    const tableId = await createTable(weddingA, "Mesa anon plano", 4);
    expect((await as.anon.from("seating_tables").select("shape, layout_x, layout_y")).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.anon.from("seating_tables").update({ layout_x: 1, layout_y: 1 }).eq("id", tableId)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    expect((await as.anon.from("seating_tables").update({ shape: "rectangle" }).eq("id", tableId)).error?.code).toBe(
      PERMISSION_DENIED,
    );
    const anonColumns = await sql(
      `select 1 from information_schema.column_privileges
       where grantee = 'anon' and table_schema = 'public' and table_name = 'seating_tables'`,
    );
    expect(anonColumns).toEqual([]);
    expect(await tableRow(tableId)).toMatchObject({ shape: "round", layout_x: null, layout_y: null });
  });
});

// ------------------------------------------------- LB-19 invariants intact

describe("layout writes leave the seating domain alone", () => {
  it("moving a table doesn't change its assignments, capacity or order", async () => {
    const tableId = await createTable(weddingA, "Mesa con gente", 2);
    const guests = await createGuests(weddingA, "Plano movido", ["Ana", "Beto"]);
    for (const guestId of guests) await seat(weddingA, guestId, tableId);
    const before = await tableRow(tableId);

    // A full table can still be moved: the capacity trigger only watches capacity.
    expect((await setLayout("collabA", tableId, { layout_x: 820, layout_y: 440 })).error).toBeNull();
    expect(await tableRow(tableId)).toEqual({ ...before, layout_x: 820, layout_y: 440 });
    expect(await assignmentsAt(tableId)).toEqual([...guests].sort());
  });

  it("changing the shape doesn't change capacity, assignments or position", async () => {
    const tableId = await createTable(weddingA, "Mesa forma gente", 3);
    const guests = await createGuests(weddingA, "Plano forma", ["Carla"]);
    await seat(weddingA, guests[0]!, tableId);
    await setLayout("ownerA", tableId, { layout_x: 400, layout_y: 400 });
    const before = await tableRow(tableId);

    const { error } = await as.collabA.from("seating_tables").update({ shape: "rectangle" }).eq("id", tableId);
    expect(error).toBeNull();
    expect(await tableRow(tableId)).toEqual({ ...before, shape: "rectangle" });
    expect(await assignmentsAt(tableId)).toEqual(guests);
  });

  it("the capacity trigger still refuses a full table after a layout or shape change", async () => {
    const tableId = await createTable(weddingA, "Mesa llena plano", 1);
    const guests = await createGuests(weddingA, "Plano llena", ["Uno", "Dos"]);
    await seat(weddingA, guests[0]!, tableId);
    await setLayout("ownerA", tableId, { layout_x: 200, layout_y: 600 });
    await as.ownerA.from("seating_tables").update({ shape: "rectangle" }).eq("id", tableId);
    const second = await as.ownerA
      .from("seating_assignments")
      .insert({ guest_id: guests[1]!, wedding_id: weddingA, seating_table_id: tableId });
    expect(second.error?.code).toBe(CHECK_VIOLATION);
    expect(second.error?.message).toBe("seating_table_full");
    expect(await assignmentsAt(tableId)).toEqual([guests[0]]);
  });

  it("no layout trigger was added: seating_tables keeps exactly its LB-19 triggers", async () => {
    const rows = await sql<{ tgname: string }>(
      `select tgname from pg_trigger
       where tgrelid = 'public.seating_tables'::regclass and not tgisinternal order by tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      "seating_tables_assign_sort_order",
      "seating_tables_enforce_capacity",
      "seating_tables_set_updated_at",
    ]);
  });

  it("the guest's RSVP view and anon functions carry no layout data", async () => {
    const fns = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and has_function_privilege('anon', p.oid, 'execute')
         and (p.prosrc ilike '%layout_x%' or p.prosrc ilike '%seating_table_shape%')`,
    );
    expect(fns).toEqual([]);
  });
});
