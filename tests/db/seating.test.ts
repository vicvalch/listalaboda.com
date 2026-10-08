import { createHash, randomBytes } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/supabase/database.types";

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

// LB-19 (ADR-012): the seating plan — tables and one-table-per-guest
// assignments. Exercised as real anon/authenticated users through the Data
// API (and, for the concurrency proofs, as `authenticated` on two raw
// connections with overlapping transactions); the superuser connection only
// arranges fixtures and reads ground truth.

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

type Party = { id: string; hash: string; guestIds: string[] };

async function createParty(actor: TestUserKey, weddingId: string, label: string, names: string[]): Promise<Party> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: names,
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  const guests = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at, id",
    [data],
  );
  return { id: data, hash, guestIds: guests.map((g) => g.id) };
}

/** The party answers for every guest at once, through the real anon RSVP function. */
async function answer(party: Party, attending: readonly boolean[]) {
  const responses: Json = party.guestIds.map((guestId, i) => ({ guest_id: guestId, attending: attending[i] ?? true }));
  return as.anon.rpc("submit_guest_rsvp", { invitation_token_hash: party.hash, responses });
}

function insertTable(actor: keyof typeof as, weddingId: string, name: string, capacity: number) {
  return as[actor]
    .from("seating_tables")
    .insert({ wedding_id: weddingId, name, capacity })
    .select("id, sort_order")
    .single();
}

async function createTable(actor: TestUserKey, weddingId: string, name: string, capacity: number): Promise<string> {
  const { data, error } = await insertTable(actor, weddingId, name, capacity);
  if (error || !data) throw new Error(`table insert failed: ${error?.message}`);
  return data.id;
}

function seat(actor: keyof typeof as, weddingId: string, guestId: string, tableId: string) {
  return as[actor]
    .from("seating_assignments")
    .insert({ guest_id: guestId, wedding_id: weddingId, seating_table_id: tableId })
    .select("guest_id");
}

function move(actor: keyof typeof as, weddingId: string, guestId: string, tableId: string) {
  return as[actor]
    .from("seating_assignments")
    .update({ seating_table_id: tableId })
    .eq("guest_id", guestId)
    .eq("wedding_id", weddingId)
    .select("guest_id");
}

function unseat(actor: keyof typeof as, weddingId: string, guestId: string) {
  return as[actor]
    .from("seating_assignments")
    .delete()
    .eq("guest_id", guestId)
    .eq("wedding_id", weddingId)
    .select("guest_id");
}

async function mustSeat(weddingId: string, guestId: string, tableId: string) {
  const { error } = await seat("ownerA", weddingId, guestId, tableId);
  if (error) throw new Error(`seat failed: ${error.message}`);
}

async function tableOf(guestId: string): Promise<string | null> {
  const rows = await sql<{ seating_table_id: string }>(
    "select seating_table_id from public.seating_assignments where guest_id = $1",
    [guestId],
  );
  return rows[0]?.seating_table_id ?? null;
}

async function countAt(tableId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(
    "select count(*)::int as n from public.seating_assignments where seating_table_id = $1",
    [tableId],
  );
  return row?.n ?? 0;
}

async function capacityOf(tableId: string): Promise<number | undefined> {
  const [row] = await sql<{ capacity: number }>("select capacity from public.seating_tables where id = $1", [tableId]);
  return row?.capacity;
}

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Mesas A");
  weddingB = await fixtureWedding("ownerB", "Boda Mesas B");
  await addMember(weddingA, "collabA", "collaborator");
});

// ------------------------------------------------------------------- access

describe("seating access", () => {
  for (const actor of ["ownerA", "collabA"] as const) {
    it(`${actor} can create, read, edit and delete tables and assignments`, async () => {
      const party = await createParty("ownerA", weddingA, `Acceso ${actor}`, ["Uno", "Dos"]);
      const { data: created, error } = await insertTable(actor, weddingA, `Mesa ${actor}`, 4);
      expect(error).toBeNull();
      const tableId = created!.id;

      const read = await as[actor].from("seating_tables").select("id, name, capacity").eq("id", tableId);
      expect(read.data).toEqual([{ id: tableId, name: `Mesa ${actor}`, capacity: 4 }]);

      const edited = await as[actor]
        .from("seating_tables")
        .update({ name: `Mesa ${actor} editada`, capacity: 6 })
        .eq("id", tableId)
        .select("name, capacity");
      expect(edited.data).toEqual([{ name: `Mesa ${actor} editada`, capacity: 6 }]);

      expect((await seat(actor, weddingA, party.guestIds[0]!, tableId)).error).toBeNull();
      const assignments = await as[actor].from("seating_assignments").select("guest_id").eq("seating_table_id", tableId);
      expect(assignments.data).toEqual([{ guest_id: party.guestIds[0] }]);
      expect((await unseat(actor, weddingA, party.guestIds[0]!)).data).toHaveLength(1);

      const deleted = await as[actor].from("seating_tables").delete().eq("id", tableId).select("id");
      expect(deleted.data).toEqual([{ id: tableId }]);
    });
  }

  it("a non-member sees no tables or assignments and cannot write any", async () => {
    const party = await createParty("ownerA", weddingA, "Acceso ajeno", ["Ana"]);
    const tableId = await createTable("ownerA", weddingA, "Mesa privada", 4);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);

    for (const actor of ["outsider", "ownerB"] as const) {
      expect((await as[actor].from("seating_tables").select("id").eq("wedding_id", weddingA)).data).toEqual([]);
      expect((await as[actor].from("seating_assignments").select("guest_id").eq("wedding_id", weddingA)).data).toEqual([]);

      expect((await insertTable(actor, weddingA, "Mesa intrusa", 4)).error?.code).toBe(PERMISSION_DENIED);
      const other = await createParty("ownerA", weddingA, `Ajeno ${actor}`, ["Beto"]);
      expect((await seat(actor, weddingA, other.guestIds[0]!, tableId)).error?.code).toBe(PERMISSION_DENIED);
      expect(await tableOf(other.guestIds[0]!)).toBeNull();

      // Updates and deletes find nothing to touch.
      const rename = await as[actor].from("seating_tables").update({ capacity: 1 }).eq("id", tableId).select("id");
      expect(rename.data).toEqual([]);
      expect((await move(actor, weddingA, party.guestIds[0]!, tableId)).data).toEqual([]);
      expect((await unseat(actor, weddingA, party.guestIds[0]!)).data).toEqual([]);
      expect((await as[actor].from("seating_tables").delete().eq("id", tableId).select("id")).data).toEqual([]);
    }
    expect(await capacityOf(tableId)).toBe(4);
    expect(await tableOf(party.guestIds[0]!)).toBe(tableId);
  });

  it("a non-member's writes are refused by the write policies themselves (no RETURNING to hide behind)", async () => {
    // Without .select(), PostgREST sends return=minimal: only the INSERT/UPDATE/DELETE
    // policies (not the SELECT policy) can stop these. Ground truth via superuser.
    const party = await createParty("ownerA", weddingA, "Ajeno minimal", ["Ana", "Beto"]);
    const tableId = await createTable("ownerA", weddingA, "Mesa minimal", 4);
    const other = await createTable("ownerA", weddingA, "Mesa minimal 2", 4);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);

    for (const actor of ["outsider", "ownerB"] as const) {
      const insert = await as[actor].from("seating_tables").insert({ wedding_id: weddingA, name: `Intrusa ${actor}`, capacity: 4 });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      const seatIt = await as[actor]
        .from("seating_assignments")
        .insert({ guest_id: party.guestIds[1]!, wedding_id: weddingA, seating_table_id: tableId });
      expect(seatIt.error?.code).toBe(PERMISSION_DENIED);
      await as[actor].from("seating_tables").update({ capacity: 9, name: "Hackeada" }).eq("id", tableId);
      await as[actor].from("seating_assignments").update({ seating_table_id: other }).eq("guest_id", party.guestIds[0]!);
      await as[actor].from("seating_assignments").delete().eq("guest_id", party.guestIds[0]!);
      await as[actor].from("seating_tables").delete().eq("id", other);
    }
    expect(await sql("select 1 from public.seating_tables where name like 'Intrusa %'")).toEqual([]);
    expect(await tableOf(party.guestIds[1]!)).toBeNull();
    expect(await tableOf(party.guestIds[0]!)).toBe(tableId);
    expect(await sql("select name, capacity from public.seating_tables where id = $1", [tableId])).toEqual([
      { name: "Mesa minimal", capacity: 4 },
    ]);
    expect(await capacityOf(other)).toBe(4);
  });

  it("anon can neither read nor write seating", async () => {
    const party = await createParty("ownerA", weddingA, "Acceso anon", ["Ana"]);
    const tableId = await createTable("ownerA", weddingA, "Mesa anon", 4);

    expect((await as.anon.from("seating_tables").select("id")).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.anon.from("seating_assignments").select("guest_id")).error?.code).toBe(PERMISSION_DENIED);
    expect((await insertTable("anon", weddingA, "Mesa anon 2", 4)).error?.code).toBe(PERMISSION_DENIED);
    expect((await seat("anon", weddingA, party.guestIds[0]!, tableId)).error?.code).toBe(PERMISSION_DENIED);
    const update = await as.anon.from("seating_tables").update({ capacity: 1 }).eq("id", tableId);
    expect(update.error?.code).toBe(PERMISSION_DENIED);
    const del = await as.anon.from("seating_tables").delete().eq("id", tableId);
    expect(del.error?.code).toBe(PERMISSION_DENIED);
    expect(await capacityOf(tableId)).toBe(4);
    expect(await tableOf(party.guestIds[0]!)).toBeNull();
  });

  it("clients can't write ids, ordering, provenance, timestamps or move an assignment between guests/weddings", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa columnas", 4);
    const party = await createParty("ownerA", weddingA, "Columnas", ["Ana", "Beto"]);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);

    for (const extra of [
      { sort_order: 5 },
      { created_by: users.collabA.id },
      { id: "00000000-0000-4000-8000-000000000001" },
      { created_at: "2000-01-01T00:00:00Z" },
    ]) {
      const insert = await as.ownerA.from("seating_tables").insert({ wedding_id: weddingA, name: "X", capacity: 2, ...extra });
      expect(insert.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
      const update = await as.ownerA.from("seating_tables").update(extra).eq("id", tableId);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    const toWedding = await as.ownerA.from("seating_tables").update({ wedding_id: weddingB }).eq("id", tableId);
    expect(toWedding.error?.code).toBe(PERMISSION_DENIED);

    for (const change of [{ guest_id: party.guestIds[1]! }, { wedding_id: weddingB }, { created_at: "2000-01-01T00:00:00Z" }]) {
      const update = await as.ownerA.from("seating_assignments").update(change).eq("guest_id", party.guestIds[0]!);
      expect(update.error?.code, JSON.stringify(change)).toBe(PERMISSION_DENIED);
    }
    expect(await tableOf(party.guestIds[0]!)).toBe(tableId);
  });
});

// ------------------------------------------------------------------- tables

describe("seating tables", () => {
  it("stores a valid table with database provenance", async () => {
    const { data, error } = await insertTable("collabA", weddingA, "Mesa de los novios", 10);
    expect(error).toBeNull();
    const [row] = await sql<{ name: string; capacity: number; created_by: string; wedding_id: string }>(
      "select name, capacity, created_by, wedding_id from public.seating_tables where id = $1",
      [data!.id],
    );
    expect(row).toEqual({ name: "Mesa de los novios", capacity: 10, created_by: users.collabA.id, wedding_id: weddingA });
  });

  it("rejects blank, padded, over-long and control-character names", async () => {
    for (const name of ["", "   ", " Mesa", "Mesa ", "a".repeat(81), "Mesa\u0007", "Mesa\n1"]) {
      const { error } = await insertTable("ownerA", weddingA, name, 4);
      expect(error?.code, JSON.stringify(name)).toBe(CHECK_VIOLATION);
    }
    expect((await insertTable("ownerA", weddingA, "a".repeat(80), 4)).error).toBeNull();
  });

  it("accepts capacity 1 and 50 and rejects 0, 51 and negatives", async () => {
    for (const capacity of [0, 51, -1]) {
      const { error } = await insertTable("ownerA", weddingA, `Mesa ${capacity}`, capacity);
      expect(error?.code, String(capacity)).toBe(CHECK_VIOLATION);
    }
    for (const capacity of [1, 50]) {
      expect((await insertTable("ownerA", weddingA, `Mesa ${capacity}`, capacity)).error).toBeNull();
    }
    const tableId = await createTable("ownerA", weddingA, "Mesa límites", 5);
    for (const capacity of [0, 51]) {
      const { error } = await as.ownerA.from("seating_tables").update({ capacity }).eq("id", tableId);
      expect(error?.code).toBe(CHECK_VIOLATION);
    }
  });

  it("appends new tables after the wedding's last one, per wedding, with names that may repeat", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda orden mesas");
    const other = await fixtureWedding("ownerA", "Boda orden mesas 2");
    const first = await insertTable("ownerA", wedding, "Mesa", 8);
    const second = await insertTable("ownerA", wedding, "Mesa", 8);
    const elsewhere = await insertTable("ownerA", other, "Mesa", 8);
    const third = await insertTable("ownerA", wedding, "Mesa", 8);
    expect([first.data!.sort_order, second.data!.sort_order, third.data!.sort_order]).toEqual([10, 20, 30]);
    expect(elsewhere.data!.sort_order).toBe(10);

    const read = await as.ownerA
      .from("seating_tables")
      .select("id")
      .eq("wedding_id", wedding)
      .order("sort_order")
      .order("created_at")
      .order("id");
    expect(read.data!.map((r) => r.id)).toEqual([first.data!.id, second.data!.id, third.data!.id]);
    // Renaming or resizing never reorders.
    await as.ownerA.from("seating_tables").update({ name: "Primera", capacity: 3 }).eq("id", first.data!.id);
    const [row] = await sql<{ sort_order: number }>("select sort_order from public.seating_tables where id = $1", [first.data!.id]);
    expect(row?.sort_order).toBe(10);
  });
});

// -------------------------------------------------------------- assignments

describe("seating assignments", () => {
  it("seats attending and pending guests; refuses a guest who declined", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa RSVP", 10);
    const answered = await createParty("ownerA", weddingA, "Respondieron", ["Sí", "No"]);
    expect((await answer(answered, [true, false])).error).toBeNull();
    const pending = await createParty("ownerA", weddingA, "Pendientes", ["Quizás"]);

    expect((await seat("ownerA", weddingA, answered.guestIds[0]!, tableId)).error).toBeNull();
    expect((await seat("collabA", weddingA, pending.guestIds[0]!, tableId)).error).toBeNull();

    const declined = await seat("ownerA", weddingA, answered.guestIds[1]!, tableId);
    expect(declined.error?.code).toBe(CHECK_VIOLATION);
    expect(declined.error?.message).toBe("seating_guest_declined");
    expect(await tableOf(answered.guestIds[1]!)).toBeNull();
  });

  it("a guest has at most one assignment", async () => {
    const t1 = await createTable("ownerA", weddingA, "Mesa única 1", 4);
    const t2 = await createTable("ownerA", weddingA, "Mesa única 2", 4);
    const party = await createParty("ownerA", weddingA, "Única", ["Ana"]);
    await mustSeat(weddingA, party.guestIds[0]!, t1);
    const again = await seat("ownerA", weddingA, party.guestIds[0]!, t2);
    expect(again.error?.code).toBe(UNIQUE_VIOLATION);
    const same = await seat("ownerA", weddingA, party.guestIds[0]!, t1);
    expect(same.error?.code).toBe(UNIQUE_VIOLATION);
    expect(await sql("select 1 from public.seating_assignments where guest_id = $1", [party.guestIds[0]])).toHaveLength(1);
  });

  it("moves and unseats", async () => {
    const t1 = await createTable("ownerA", weddingA, "Mesa mover 1", 4);
    const t2 = await createTable("ownerA", weddingA, "Mesa mover 2", 4);
    const party = await createParty("ownerA", weddingA, "Mover", ["Ana"]);
    const guest = party.guestIds[0]!;
    await mustSeat(weddingA, guest, t1);

    expect((await move("collabA", weddingA, guest, t2)).data).toEqual([{ guest_id: guest }]);
    expect(await tableOf(guest)).toBe(t2);
    // Staying at the same table is a no-op, even when that table is full.
    await as.ownerA.from("seating_tables").update({ capacity: 1 }).eq("id", t2);
    expect((await move("ownerA", weddingA, guest, t2)).error).toBeNull();

    expect((await unseat("ownerA", weddingA, guest)).data).toEqual([{ guest_id: guest }]);
    expect(await tableOf(guest)).toBeNull();
    expect(await sql("select 1 from public.guests where id = $1", [guest])).toHaveLength(1);
  });

  it("a full table refuses another guest — pending guests take seats too", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa llena", 2);
    // Nobody here has answered: capacity counts every assignment row.
    const party = await createParty("ownerA", weddingA, "Llena", ["Ana", "Beto", "Caro"]);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);
    await mustSeat(weddingA, party.guestIds[1]!, tableId);

    const third = await seat("collabA", weddingA, party.guestIds[2]!, tableId);
    expect(third.error?.code).toBe(CHECK_VIOLATION);
    expect(third.error?.message).toBe("seating_table_full");
    expect(await countAt(tableId)).toBe(2);
  });

  it("a declined-but-seated guest still takes a seat", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa conflicto", 1);
    const party = await createParty("ownerA", weddingA, "Conflicto", ["Ana"]);
    const other = await createParty("ownerA", weddingA, "Otro", ["Beto"]);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);
    expect((await answer(party, [false])).error).toBeNull();
    expect((await seat("ownerA", weddingA, other.guestIds[0]!, tableId)).error?.message).toBe("seating_table_full");
  });

  it("a failed move to a full table keeps the original assignment", async () => {
    const from = await createTable("ownerA", weddingA, "Mesa origen", 4);
    const full = await createTable("ownerA", weddingA, "Mesa destino llena", 1);
    const party = await createParty("ownerA", weddingA, "Mover lleno", ["Ana", "Beto"]);
    await mustSeat(weddingA, party.guestIds[0]!, full);
    await mustSeat(weddingA, party.guestIds[1]!, from);

    const moved = await move("ownerA", weddingA, party.guestIds[1]!, full);
    expect(moved.error?.message).toBe("seating_table_full");
    expect(await tableOf(party.guestIds[1]!)).toBe(from);
    expect(await countAt(full)).toBe(1);
  });

  it("capacity can't go below the people seated; equal or higher is fine", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa capacidad", 10);
    const party = await createParty("ownerA", weddingA, "Capacidad", names("Persona", 8));
    for (const guest of party.guestIds) await mustSeat(weddingA, guest, tableId);

    const below = await as.collabA.from("seating_tables").update({ capacity: 7 }).eq("id", tableId);
    expect(below.error?.code).toBe(CHECK_VIOLATION);
    expect(below.error?.message).toBe("seating_capacity_below_assigned");
    expect(await capacityOf(tableId)).toBe(10);
    expect(await countAt(tableId)).toBe(8);

    expect((await as.ownerA.from("seating_tables").update({ capacity: 8 }).eq("id", tableId)).error).toBeNull();
    expect((await as.ownerA.from("seating_tables").update({ capacity: 12 }).eq("id", tableId)).error).toBeNull();
    expect(await capacityOf(tableId)).toBe(12);
    // Renaming a table that is over a later-lowered capacity isn't possible to reach; renaming alone always works.
    expect((await as.ownerA.from("seating_tables").update({ name: "Mesa 8" }).eq("id", tableId)).error).toBeNull();
  });
});

// ----------------------------------------------------------------- tenancy

describe("seating tenancy", () => {
  it("a guest can't sit at another wedding's table, and a table can't take another wedding's guest", async () => {
    const tableA = await createTable("ownerA", weddingA, "Mesa A", 4);
    const tableB = await createTable("ownerB", weddingB, "Mesa B", 4);
    const guestA = (await createParty("ownerA", weddingA, "Tenencia A", ["Ana"])).guestIds[0]!;
    const guestB = (await createParty("ownerB", weddingB, "Tenencia B", ["Beto"])).guestIds[0]!;

    // Member of A, A's guest, B's table: the same-wedding table FK refuses.
    expect((await seat("ownerA", weddingA, guestA, tableB)).error?.code).toBe(FOREIGN_KEY_VIOLATION);
    // Member of B, B's table, A's guest: the same-wedding guest FK refuses.
    expect((await seat("ownerB", weddingB, guestA, tableB)).error?.code).toBe(FOREIGN_KEY_VIOLATION);

    await mustSeat(weddingA, guestA, tableA);
    expect((await move("ownerA", weddingA, guestA, tableB)).error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await tableOf(guestA)).toBe(tableA);
    expect(await tableOf(guestB)).toBeNull();
  });

  it("a forged wedding_id is refused", async () => {
    const tableA = await createTable("ownerA", weddingA, "Mesa forjada", 4);
    const guestA = (await createParty("ownerA", weddingA, "Forjada", ["Ana"])).guestIds[0]!;
    // ownerA isn't a member of B: RLS refuses before anything is written.
    expect((await seat("ownerA", weddingB, guestA, tableA)).error?.code).toBe(PERMISSION_DENIED);
    // ownerB is a member of B, but A's guest and table aren't B's.
    expect((await seat("ownerB", weddingB, guestA, tableA)).error?.code).toBe(FOREIGN_KEY_VIOLATION);
    // Even privileged writes can't cross weddings (the FKs bind every role).
    await expect(
      sql(
        "insert into public.seating_assignments (guest_id, wedding_id, seating_table_id) values ($1, $2, $3)",
        [guestA, weddingB, tableA],
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    expect(await tableOf(guestA)).toBeNull();
  });

  it("another wedding's member can't use known ids to read, move, unseat or resize", async () => {
    const tableA = await createTable("ownerA", weddingA, "Mesa ids", 4);
    const otherA = await createTable("ownerA", weddingA, "Mesa ids 2", 4);
    const guestA = (await createParty("ownerA", weddingA, "Ids", ["Ana"])).guestIds[0]!;
    await mustSeat(weddingA, guestA, tableA);

    expect((await as.ownerB.from("seating_assignments").select("guest_id").eq("guest_id", guestA)).data).toEqual([]);
    expect((await move("ownerB", weddingA, guestA, otherA)).data).toEqual([]);
    // Even naming their own wedding, the row isn't theirs.
    expect((await move("ownerB", weddingB, guestA, otherA)).data).toEqual([]);
    expect((await unseat("ownerB", weddingB, guestA)).data).toEqual([]);
    expect((await as.ownerB.from("seating_tables").update({ capacity: 1 }).eq("id", tableA).select("id")).data).toEqual([]);
    expect(await tableOf(guestA)).toBe(tableA);
    expect(await capacityOf(tableA)).toBe(4);
  });
});

// ----------------------------------------------------------------- deletes

describe("seating deletes", () => {
  it("deleting a table removes its assignments and keeps the guests", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa borrada", 4);
    const party = await createParty("ownerA", weddingA, "Borrar mesa", ["Ana", "Beto"]);
    for (const guest of party.guestIds) await mustSeat(weddingA, guest, tableId);

    expect((await as.collabA.from("seating_tables").delete().eq("id", tableId).select("id")).data).toHaveLength(1);
    expect(await countAt(tableId)).toBe(0);
    expect(await sql("select 1 from public.guests where id = any($1::uuid[])", [party.guestIds])).toHaveLength(2);
  });

  it("deleting a guest removes their assignment and keeps the table", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa guest borrado", 4);
    const party = await createParty("ownerA", weddingA, "Borrar invitado", ["Ana", "Beto"]);
    for (const guest of party.guestIds) await mustSeat(weddingA, guest, tableId);

    const removed = await as.ownerA.from("guests").delete().eq("id", party.guestIds[1]!).select("id");
    expect(removed.data).toHaveLength(1);
    expect(await countAt(tableId)).toBe(1);
    expect(await capacityOf(tableId)).toBe(4);
  });

  it("deleting a party removes its guests' assignments and keeps the table", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa grupo borrado", 4);
    const party = await createParty("ownerA", weddingA, "Borrar grupo", ["Ana", "Beto"]);
    const stays = await createParty("ownerA", weddingA, "Se queda", ["Caro"]);
    for (const guest of [...party.guestIds, ...stays.guestIds]) await mustSeat(weddingA, guest, tableId);

    expect((await as.ownerA.from("guest_invitations").delete().eq("id", party.id).select("id")).data).toHaveLength(1);
    expect(await countAt(tableId)).toBe(1);
    expect(await tableOf(stays.guestIds[0]!)).toBe(tableId);
  });

  it("deleting a wedding removes its tables and assignments", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda borrada mesas");
    const tableId = await createTable("ownerA", wedding, "Mesa", 4);
    const party = await createParty("ownerA", wedding, "Grupo", ["Ana"]);
    await mustSeat(wedding, party.guestIds[0]!, tableId);

    await sql("delete from public.weddings where id = $1", [wedding]);
    expect(await sql("select 1 from public.seating_tables where wedding_id = $1", [wedding])).toEqual([]);
    expect(await sql("select 1 from public.seating_assignments where wedding_id = $1", [wedding])).toEqual([]);
  });
});

// -------------------------------------------------------------------- RSVP

describe("seating and RSVP", () => {
  it("a seated guest who later declines: the RSVP succeeds and the assignment stays", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa luego no", 4);
    const party = await createParty("ownerA", weddingA, "Luego no", ["Ana", "Beto"]);
    expect((await answer(party, [true, true])).error).toBeNull();
    await mustSeat(weddingA, party.guestIds[0]!, tableId);

    expect((await answer(party, [false, true])).error).toBeNull();
    const [rsvp] = await sql<{ attending: boolean }>("select attending from public.rsvps where guest_id = $1", [
      party.guestIds[0],
    ]);
    expect(rsvp?.attending).toBe(false);
    expect(await tableOf(party.guestIds[0]!)).toBe(tableId);
  });

  it("a declined seated guest can't be moved, but can be unseated", async () => {
    const t1 = await createTable("ownerA", weddingA, "Mesa no 1", 4);
    const t2 = await createTable("ownerA", weddingA, "Mesa no 2", 4);
    const party = await createParty("ownerA", weddingA, "No mover", ["Ana"]);
    await mustSeat(weddingA, party.guestIds[0]!, t1);
    expect((await answer(party, [false])).error).toBeNull();

    const moved = await move("ownerA", weddingA, party.guestIds[0]!, t2);
    expect(moved.error?.message).toBe("seating_guest_declined");
    expect(await tableOf(party.guestIds[0]!)).toBe(t1);

    expect((await unseat("collabA", weddingA, party.guestIds[0]!)).data).toHaveLength(1);
    expect(await tableOf(party.guestIds[0]!)).toBeNull();
    // And, unseated, they can't be seated again while declined.
    expect((await seat("ownerA", weddingA, party.guestIds[0]!, t1)).error?.message).toBe("seating_guest_declined");
  });
});

// ------------------------------------------------------------- concurrency

/** A raw connection acting as `authenticated` for `user`, inside an open transaction. */
async function authenticatedTransaction(user: TestUserKey): Promise<pg.PoolClient> {
  const conn = await superuser.connect();
  await conn.query("begin");
  await conn.query("set local role authenticated");
  await conn.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: users[user].id, role: "authenticated" }),
  ]);
  return conn;
}

type Settled = { status: "fulfilled" } | { status: "rejected"; code?: string; message?: string };

function track(query: Promise<unknown>): { done: Promise<Settled>; settled: () => boolean } {
  let settled = false;
  const done = query.then(
    (): Settled => ((settled = true), { status: "fulfilled" }),
    (error: { code?: string; message?: string }): Settled => (
      (settled = true), { status: "rejected", code: error.code, message: error.message }
    ),
  );
  return { done, settled: () => settled };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("seating concurrency", () => {
  it("two transactions seating into the last free seat: exactly one wins", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa carrera", 8);
    const party = await createParty("ownerA", weddingA, "Carrera", names("Invitado", 9));
    for (const guest of party.guestIds.slice(0, 7)) await mustSeat(weddingA, guest, tableId);
    const [guestA, guestB] = party.guestIds.slice(7) as [string, string];

    const first = await authenticatedTransaction("ownerA");
    const second = await authenticatedTransaction("collabA");
    const insert = "insert into public.seating_assignments (guest_id, wedding_id, seating_table_id) values ($1, $2, $3)";
    try {
      const a = track(first.query(insert, [guestA, weddingA, tableId]));
      expect(await a.done).toEqual({ status: "fulfilled" });
      // B starts while A's transaction is still open: it must wait for A's table lock.
      const b = track(second.query(insert, [guestB, weddingA, tableId]));
      await wait(400);
      expect(b.settled()).toBe(false);

      await first.query("commit");
      const outcome = await b.done;
      expect(outcome).toEqual({ status: "rejected", code: CHECK_VIOLATION, message: "seating_table_full" });
      await second.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await countAt(tableId)).toBe(8);
    expect(await tableOf(guestA)).toBe(tableId);
    expect(await tableOf(guestB)).toBeNull();
  });

  it("two transactions moving guests into the last free seat: exactly one wins, the other stays put", async () => {
    const destination = await createTable("ownerA", weddingA, "Mesa destino carrera", 8);
    const fromA = await createTable("ownerA", weddingA, "Mesa origen A", 4);
    const fromB = await createTable("ownerA", weddingA, "Mesa origen B", 4);
    const party = await createParty("ownerA", weddingA, "Carrera mover", names("Persona", 9));
    for (const guest of party.guestIds.slice(0, 7)) await mustSeat(weddingA, guest, destination);
    const [guestA, guestB] = party.guestIds.slice(7) as [string, string];
    await mustSeat(weddingA, guestA, fromA);
    await mustSeat(weddingA, guestB, fromB);

    const first = await authenticatedTransaction("collabA");
    const second = await authenticatedTransaction("ownerA");
    const update = "update public.seating_assignments set seating_table_id = $1 where guest_id = $2 and wedding_id = $3";
    try {
      const a = track(first.query(update, [destination, guestA, weddingA]));
      expect(await a.done).toEqual({ status: "fulfilled" });
      const b = track(second.query(update, [destination, guestB, weddingA]));
      await wait(400);
      expect(b.settled()).toBe(false);

      await first.query("commit");
      expect(await b.done).toEqual({ status: "rejected", code: CHECK_VIOLATION, message: "seating_table_full" });
      await second.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await countAt(destination)).toBe(8);
    expect(await tableOf(guestA)).toBe(destination);
    expect(await tableOf(guestB)).toBe(fromB);
  });

  it("a capacity reduction and a seat race on the same table never leave it over capacity", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa reducir carrera", 3);
    const party = await createParty("ownerA", weddingA, "Reducir carrera", names("Gente", 3));
    for (const guest of party.guestIds.slice(0, 2)) await mustSeat(weddingA, guest, tableId);

    const first = await authenticatedTransaction("ownerA");
    const second = await authenticatedTransaction("collabA");
    try {
      const a = track(
        first.query("insert into public.seating_assignments (guest_id, wedding_id, seating_table_id) values ($1, $2, $3)", [
          party.guestIds[2],
          weddingA,
          tableId,
        ]),
      );
      expect(await a.done).toEqual({ status: "fulfilled" });
      const b = track(second.query("update public.seating_tables set capacity = 2 where id = $1", [tableId]));
      await wait(400);
      expect(b.settled()).toBe(false);
      await first.query("commit");
      expect(await b.done).toEqual({
        status: "rejected",
        code: CHECK_VIOLATION,
        message: "seating_capacity_below_assigned",
      });
      await second.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await capacityOf(tableId)).toBe(3);
    expect(await countAt(tableId)).toBe(3);
  });
});

// ---------------------------------------------------------------- security

describe("seating security", () => {
  it("trigger functions are invoker-rights, pin search_path and can't be executed by clients", async () => {
    const rows = await sql<{ name: string; definer: boolean; config: string[]; anon: boolean; authenticated: boolean }>(
      `select p.proname as name, p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
       from pg_proc p
       where p.pronamespace = 'private'::regnamespace
         and p.proname in ('enforce_seating_assignment', 'enforce_seating_table_capacity', 'assign_seating_table_sort_order')
       order by 1`,
    );
    expect(rows).toEqual([
      { name: "assign_seating_table_sort_order", definer: false, config: ['search_path=""'], anon: false, authenticated: false },
      { name: "enforce_seating_assignment", definer: false, config: ['search_path=""'], anon: false, authenticated: false },
      { name: "enforce_seating_table_capacity", definer: false, config: ['search_path=""'], anon: false, authenticated: false },
    ]);
  });

  it("no anon-callable function (guest RSVP, published site) references seating", async () => {
    const rows = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and has_function_privilege('anon', p.oid, 'execute')
         and p.prosrc ilike '%seating%'`,
    );
    expect(rows).toEqual([]);
  });

  it("the guest's RSVP view carries no seating data", async () => {
    const tableId = await createTable("ownerA", weddingA, "Mesa secreta RSVP", 4);
    const party = await createParty("ownerA", weddingA, "Vista RSVP", ["Ana"]);
    await mustSeat(weddingA, party.guestIds[0]!, tableId);
    const { data, error } = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    expect(error).toBeNull();
    const text = JSON.stringify(data);
    expect(text).not.toContain("Mesa secreta RSVP");
    expect(text).not.toContain(tableId);
    expect(text.toLowerCase()).not.toContain("seating");
  });

  it("the capacity count is served by the seating_table_id index", async () => {
    const conn = await superuser.connect();
    try {
      await conn.query("begin");
      await conn.query("set local enable_seqscan = off");
      const { rows } = await conn.query<{ "QUERY PLAN": string }>(
        `explain select count(*) from public.seating_assignments a
         where a.seating_table_id = '00000000-0000-4000-8000-000000000001'
           and a.guest_id <> '00000000-0000-4000-8000-000000000002'`,
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("seating_assignments_table_idx");
    } finally {
      await conn.query("rollback");
      conn.release();
    }
  });
});
