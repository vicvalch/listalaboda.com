import { createHash, randomBytes } from "node:crypto";

import type pg from "pg";
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

// LB-22 (ADR-015): wedding budget estimates, vendor schedule items and vendor
// payments. Exercised as real anon/authenticated users through the Data API
// (and, for the concurrency proofs, as `authenticated` on two raw connections
// with overlapping transactions); the superuser connection only arranges
// fixtures and reads ground truth.

type VendorInsert = Database["public"]["Tables"]["wedding_vendors"]["Insert"];
type ItemInsert = Database["public"]["Tables"]["vendor_payment_schedule_items"]["Insert"];
type PaymentInsert = Database["public"]["Tables"]["vendor_payments"]["Insert"];
type Actor = keyof typeof as;

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
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
  weddingA = await fixtureWedding("ownerA", "Boda Presupuesto A");
  weddingB = await fixtureWedding("ownerB", "Boda Presupuesto B");
  await addMember(weddingA, "collabA", "collaborator");
});

let vendorCounter = 0;

/** A booked vendor with a contract (default ₡1 000 000,00 = 100 000 000 minor). */
async function createVendor(
  actor: TestUserKey,
  weddingId: string,
  fields: Partial<VendorInsert> = {},
): Promise<string> {
  const { data, error } = await as[actor]
    .from("wedding_vendors")
    .insert({
      wedding_id: weddingId,
      name: `Proveedor ${++vendorCounter}`,
      category: "photography",
      status: "booked",
      currency: "CRC",
      contracted_amount_minor: 100_000_000,
      ...fields,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`vendor insert failed: ${error?.message}`);
  return data.id;
}

function insertItem(actor: Actor, weddingId: string, vendorId: string, fields: Partial<ItemInsert> = {}) {
  return as[actor]
    .from("vendor_payment_schedule_items")
    .insert({
      wedding_id: weddingId,
      wedding_vendor_id: vendorId,
      label: "Depósito",
      amount_minor: 30_000_000,
      due_on: "2026-11-01",
      ...fields,
    })
    .select("id")
    .single();
}

async function createItem(weddingId: string, vendorId: string, fields: Partial<ItemInsert> = {}): Promise<string> {
  const { data, error } = await insertItem("ownerA", weddingId, vendorId, fields);
  if (error || !data) throw new Error(`item insert failed: ${error?.message}`);
  return data.id;
}

function insertPayment(actor: Actor, weddingId: string, vendorId: string, fields: Partial<PaymentInsert> = {}) {
  return as[actor]
    .from("vendor_payments")
    .insert({
      wedding_id: weddingId,
      wedding_vendor_id: vendorId,
      amount_minor: 10_000_000,
      paid_on: "2026-10-01",
      ...fields,
    })
    .select("id")
    .single();
}

async function createPayment(weddingId: string, vendorId: string, fields: Partial<PaymentInsert> = {}): Promise<string> {
  const { data, error } = await insertPayment("ownerA", weddingId, vendorId, fields);
  if (error || !data) throw new Error(`payment insert failed: ${error?.message}`);
  return data.id;
}

async function paidOnItem(itemId: string): Promise<number> {
  const [row] = await sql<{ total: string }>(
    "select coalesce(sum(amount_minor), 0)::text as total from public.vendor_payments where schedule_item_id = $1",
    [itemId],
  );
  return Number(row!.total);
}

/** Σ items + Σ unlinked payments: the vendor's recorded floor, from ground truth. */
async function recordedFloor(vendorId: string): Promise<number> {
  const [row] = await sql<{ total: string }>(
    `select ((select coalesce(sum(amount_minor), 0) from public.vendor_payment_schedule_items where wedding_vendor_id = $1)
           + (select coalesce(sum(amount_minor), 0) from public.vendor_payments
              where wedding_vendor_id = $1 and schedule_item_id is null))::text as total`,
    [vendorId],
  );
  return Number(row!.total);
}

async function contractOf(vendorId: string): Promise<number | null> {
  const [row] = await sql<{ amount: string | null }>(
    "select contracted_amount_minor::text as amount from public.wedding_vendors where id = $1",
    [vendorId],
  );
  return row?.amount === null || row?.amount === undefined ? null : Number(row.amount);
}

// ================================================================== budget

describe("budget totals and allocations", () => {
  for (const actor of ["ownerA", "collabA"] as const) {
    it(`${actor} can create, read, update and delete totals and allocations`, async () => {
      const wedding = await fixtureWedding("ownerA", `Boda CRUD ${actor}`);
      await addMember(wedding, "collabA", "collaborator");

      const total = await as[actor]
        .from("wedding_budget_totals")
        .insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1_200_000_000 })
        .select("id, currency, amount_minor")
        .single();
      expect(total.error).toBeNull();
      expect(total.data).toMatchObject({ currency: "CRC", amount_minor: 1_200_000_000 });

      const allocation = await as[actor]
        .from("wedding_budget_allocations")
        .insert({ wedding_id: wedding, category: "photography", currency: "USD", amount_minor: 200_000 })
        .select("id")
        .single();
      expect(allocation.error).toBeNull();

      const updatedTotal = await as[actor]
        .from("wedding_budget_totals")
        .update({ amount_minor: 0 })
        .eq("id", total.data!.id)
        .select("amount_minor");
      expect(updatedTotal.data).toEqual([{ amount_minor: 0 }]);
      const updatedAllocation = await as[actor]
        .from("wedding_budget_allocations")
        .update({ amount_minor: 250_000 })
        .eq("id", allocation.data!.id)
        .select("amount_minor");
      expect(updatedAllocation.data).toEqual([{ amount_minor: 250_000 }]);

      expect((await as[actor].from("wedding_budget_totals").delete().eq("id", total.data!.id).select("id")).data).toHaveLength(1);
      expect(
        (await as[actor].from("wedding_budget_allocations").delete().eq("id", allocation.data!.id).select("id")).data,
      ).toHaveLength(1);
      expect(await sql("select 1 from public.wedding_budget_totals where wedding_id = $1", [wedding])).toEqual([]);
    });
  }

  it("non-members and anon can't read or write budget rows", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda presupuesto privado");
    const { data: total } = await as.ownerA
      .from("wedding_budget_totals")
      .insert({ wedding_id: wedding, currency: "USD", amount_minor: 250_000 })
      .select("id")
      .single();
    const { data: allocation } = await as.ownerA
      .from("wedding_budget_allocations")
      .insert({ wedding_id: wedding, category: "venue", currency: "USD", amount_minor: 100_000 })
      .select("id")
      .single();

    for (const actor of ["outsider", "ownerB"] as const) {
      for (const table of ["wedding_budget_totals", "wedding_budget_allocations"] as const) {
        expect((await as[actor].from(table).select("id").eq("wedding_id", wedding)).data).toEqual([]);
        expect((await as[actor].from(table).update({ amount_minor: 1 }).eq("wedding_id", wedding).select("id")).data).toEqual([]);
        expect((await as[actor].from(table).delete().eq("wedding_id", wedding).select("id")).data).toEqual([]);
      }
      const insert = await as[actor]
        .from("wedding_budget_totals")
        .insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1 });
      expect(insert.error?.code).toBe(PERMISSION_DENIED);
      const insertAllocation = await as[actor]
        .from("wedding_budget_allocations")
        .insert({ wedding_id: wedding, category: "music", currency: "CRC", amount_minor: 1 });
      expect(insertAllocation.error?.code).toBe(PERMISSION_DENIED);
    }
    for (const table of ["wedding_budget_totals", "wedding_budget_allocations"] as const) {
      expect((await as.anon.from(table).select("id")).error?.code).toBe(PERMISSION_DENIED);
      expect((await as.anon.from(table).update({ amount_minor: 1 }).eq("wedding_id", wedding)).error?.code).toBe(
        PERMISSION_DENIED,
      );
      expect((await as.anon.from(table).delete().eq("wedding_id", wedding)).error?.code).toBe(PERMISSION_DENIED);
    }
    expect(
      (await as.anon.from("wedding_budget_totals").insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1 })).error
        ?.code,
    ).toBe(PERMISSION_DENIED);

    expect(await sql("select amount_minor::int from public.wedding_budget_totals where id = $1", [total!.id])).toEqual([
      { amount_minor: 250_000 },
    ]);
    expect(await sql("select amount_minor::int from public.wedding_budget_allocations where id = $1", [allocation!.id])).toEqual([
      { amount_minor: 100_000 },
    ]);
  });

  it("supports only CRC and USD, and the LB-21 money range", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda monedas presupuesto");
    for (const currency of ["EUR", "crc", "US$", ""]) {
      const total = await as.ownerA.from("wedding_budget_totals").insert({ wedding_id: wedding, currency, amount_minor: 1 });
      expect(total.error?.code, currency).toBe(CHECK_VIOLATION);
      const allocation = await as.ownerA
        .from("wedding_budget_allocations")
        .insert({ wedding_id: wedding, category: "venue", currency, amount_minor: 1 });
      expect(allocation.error?.code, currency).toBe(CHECK_VIOLATION);
    }
    for (const amount of [-1, 100_000_000_000_000]) {
      const total = await as.ownerA
        .from("wedding_budget_totals")
        .insert({ wedding_id: wedding, currency: "CRC", amount_minor: amount });
      expect(total.error?.code, String(amount)).toBe(CHECK_VIOLATION);
    }
    expect(
      (await as.ownerA.from("wedding_budget_totals").insert({ wedding_id: wedding, currency: "CRC", amount_minor: 99_999_999_999_999 }))
        .error,
    ).toBeNull();
    expect(
      (await as.ownerA.from("wedding_budget_allocations").insert({ wedding_id: wedding, category: "venue", currency: "USD", amount_minor: 0 }))
        .error,
    ).toBeNull();
    const unknownCategory = await as.ownerA.from("wedding_budget_allocations").insert({
      wedding_id: wedding,
      category: "florist" as Database["public"]["Enums"]["wedding_vendor_category"],
      currency: "USD",
      amount_minor: 1,
    });
    expect(unknownCategory.error?.code).toBe(INVALID_TEXT_REPRESENTATION);
  });

  it("one total per wedding and currency; one allocation per wedding, category and currency", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda únicos presupuesto");
    const row = { wedding_id: wedding, currency: "CRC", amount_minor: 1 };
    expect((await as.ownerA.from("wedding_budget_totals").insert(row)).error).toBeNull();
    expect((await as.collabA.from("wedding_budget_totals").insert(row)).error?.code).toBe(PERMISSION_DENIED);
    expect((await as.ownerA.from("wedding_budget_totals").insert(row)).error?.code).toBe(UNIQUE_VIOLATION);
    expect((await as.ownerA.from("wedding_budget_totals").insert({ ...row, currency: "USD" })).error).toBeNull();

    const allocation = { wedding_id: wedding, category: "photography" as const, currency: "USD", amount_minor: 200_000 };
    expect((await as.ownerA.from("wedding_budget_allocations").insert(allocation)).error).toBeNull();
    expect((await as.ownerA.from("wedding_budget_allocations").insert(allocation)).error?.code).toBe(UNIQUE_VIOLATION);
    // Same category, other currency: a separate row.
    expect((await as.ownerA.from("wedding_budget_allocations").insert({ ...allocation, currency: "CRC", amount_minor: 0 })).error).toBeNull();
  });

  it("protects ids, the wedding, the key columns, provenance and timestamps", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda columnas presupuesto");
    const { data: total } = await as.collabA
      .from("wedding_budget_totals")
      .insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1 })
      .select("id")
      .single();
    // collabA isn't a member of this new wedding: added below for the rest of the test.
    expect(total).toBeNull();
    await addMember(wedding, "collabA", "collaborator");
    const { data: created } = await as.collabA
      .from("wedding_budget_totals")
      .insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1 })
      .select("id")
      .single();
    const [row] = await sql<{ created_by: string }>("select created_by from public.wedding_budget_totals where id = $1", [
      created!.id,
    ]);
    expect(row!.created_by).toBe(users.collabA.id);

    for (const extra of [
      { id: "00000000-0000-4000-8000-000000000001" },
      { created_by: users.ownerA.id },
      { created_at: "2000-01-01T00:00:00Z" },
      { updated_at: "2000-01-01T00:00:00Z" },
      { wedding_id: weddingA },
      { currency: "USD" },
    ]) {
      const update = await as.ownerA.from("wedding_budget_totals").update(extra).eq("id", created!.id);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    for (const extra of [{ category: "venue" as const }, { currency: "USD" }, { wedding_id: weddingA }]) {
      const update = await as.ownerA.from("wedding_budget_allocations").update(extra).eq("wedding_id", wedding);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    const insertWithId = await as.ownerA
      .from("wedding_budget_totals")
      .insert({ id: "00000000-0000-4000-8000-000000000002", wedding_id: wedding, currency: "USD", amount_minor: 1 });
    expect(insertWithId.error?.code).toBe(PERMISSION_DENIED);
  });

  it("a member of A can't write budget rows into wedding B", async () => {
    for (const actor of ["ownerA", "collabA"] as const) {
      expect(
        (await as[actor].from("wedding_budget_totals").insert({ wedding_id: weddingB, currency: "USD", amount_minor: 1 })).error
          ?.code,
      ).toBe(PERMISSION_DENIED);
    }
  });
});

// =========================================================== schedule items

describe("schedule items", () => {
  it("owners and collaborators create, edit and delete items; dates are stored as calendar dates", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await insertItem(actor, weddingA, vendor, { label: `Cuota ${actor}`, due_on: "2028-02-29" });
      expect(error).toBeNull();
      const [row] = await sql<{ due_on: string; created_by: string }>(
        "select due_on::text as due_on, created_by from public.vendor_payment_schedule_items where id = $1",
        [data!.id],
      );
      expect(row).toEqual({ due_on: "2028-02-29", created_by: users[actor].id });
      const update = await as[actor]
        .from("vendor_payment_schedule_items")
        .update({ label: "Renombrada", amount_minor: 1_000, due_on: "2020-01-01" })
        .eq("id", data!.id)
        .select("id");
      expect(update.data).toHaveLength(1);
      const del = await as[actor].from("vendor_payment_schedule_items").delete().eq("id", data!.id).select("id");
      expect(del.data).toHaveLength(1);
    }
    // Invalid calendar dates never get in.
    expect((await insertItem("ownerA", weddingA, vendor, { due_on: "2027-02-29" })).error).not.toBeNull();
  });

  it("requires a contracted amount (never a quote)", async () => {
    const quoted = await createVendor("ownerA", weddingA, { status: "quoted", contracted_amount_minor: null, quoted_amount_minor: 500 });
    const { error } = await insertItem("ownerA", weddingA, quoted);
    expect(error).toMatchObject({ code: CHECK_VIOLATION, message: "vendor_contract_required" });
    const none = await createVendor("ownerA", weddingA, { currency: null, contracted_amount_minor: null });
    expect((await insertItem("ownerA", weddingA, none)).error?.message).toBe("vendor_contract_required");
    // A contract of any status allows a schedule (status isn't coupled to money).
    const selected = await createVendor("ownerA", weddingA, { status: "selected" });
    expect((await insertItem("ownerA", weddingA, selected)).error).toBeNull();
  });

  it("validates label and amount", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    for (const label of ["", " ", " Depósito", "Depósito ", "x".repeat(81), "Dep\nósito", "Dep\u0007"]) {
      expect((await insertItem("ownerA", weddingA, vendor, { label })).error?.code, JSON.stringify(label)).toBe(CHECK_VIOLATION);
    }
    expect((await insertItem("ownerA", weddingA, vendor, { label: "x".repeat(80), amount_minor: 1 })).error).toBeNull();
    for (const amount of [0, -1, 100_000_000_000_000]) {
      expect((await insertItem("ownerA", weddingA, vendor, { amount_minor: amount })).error?.code, String(amount)).toBe(
        CHECK_VIOLATION,
      );
    }
  });

  it("the schedule may reach the contract exactly but never exceed it", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 600_000 });
    expect((await insertItem("ownerA", weddingA, vendor, { amount_minor: 200_000 })).error).toBeNull();
    expect((await insertItem("ownerA", weddingA, vendor, { amount_minor: 300_000 })).error).toBeNull();
    const over = await insertItem("collabA", weddingA, vendor, { amount_minor: 100_001 });
    expect(over.error).toMatchObject({ code: CHECK_VIOLATION, message: "vendor_schedule_exceeds_contract" });
    expect((await insertItem("collabA", weddingA, vendor, { amount_minor: 100_000 })).error).toBeNull();
    expect(await recordedFloor(vendor)).toBe(600_000);
  });

  it("an item update re-checks the contract cap and what is already paid against it", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 600_000 });
    const first = await createItem(weddingA, vendor, { amount_minor: 300_000 });
    await createItem(weddingA, vendor, { amount_minor: 200_000 });
    await createPayment(weddingA, vendor, { schedule_item_id: first, amount_minor: 250_000 });

    const grow = await as.ownerA.from("vendor_payment_schedule_items").update({ amount_minor: 400_001 }).eq("id", first);
    expect(grow.error?.message).toBe("vendor_schedule_exceeds_contract");
    expect((await as.ownerA.from("vendor_payment_schedule_items").update({ amount_minor: 400_000 }).eq("id", first)).error).toBeNull();

    const shrink = await as.collabA.from("vendor_payment_schedule_items").update({ amount_minor: 249_999 }).eq("id", first);
    expect(shrink.error).toMatchObject({ code: CHECK_VIOLATION, message: "vendor_schedule_item_below_paid" });
    expect((await as.collabA.from("vendor_payment_schedule_items").update({ amount_minor: 250_000 }).eq("id", first)).error).toBeNull();
    // Label/date edits on a fully paid item are fine.
    expect(
      (await as.collabA.from("vendor_payment_schedule_items").update({ label: "Pagada", due_on: "2019-05-05" }).eq("id", first)).error,
    ).toBeNull();
  });

  it("unlinked payments consume schedule room", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 600_000 });
    await createPayment(weddingA, vendor, { amount_minor: 200_000 });
    expect((await insertItem("ownerA", weddingA, vendor, { amount_minor: 400_001 })).error?.message).toBe(
      "vendor_schedule_exceeds_contract",
    );
    expect((await insertItem("ownerA", weddingA, vendor, { amount_minor: 400_000 })).error).toBeNull();
  });

  it("only a same-wedding vendor; a foreign or unknown vendor is refused", async () => {
    const vendorB = await createVendor("ownerB", weddingB);
    // Member of A naming B's vendor under wedding A: the composite FK refuses it.
    expect((await insertItem("ownerA", weddingA, vendorB)).error?.code).toBe(FOREIGN_KEY_VIOLATION);
    // ...under wedding B: RLS refuses it.
    expect((await insertItem("ownerA", weddingB, vendorB)).error?.code).toBe(PERMISSION_DENIED);
    expect((await insertItem("ownerA", weddingA, "00000000-0000-4000-8000-000000000009")).error?.code).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(await sql("select 1 from public.vendor_payment_schedule_items where wedding_vendor_id = $1", [vendorB])).toEqual([]);
  });

  it("clients can't move an item or write protected columns", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    const other = await createVendor("ownerA", weddingA);
    const item = await createItem(weddingA, vendor);
    for (const extra of [
      { wedding_vendor_id: other },
      { wedding_id: weddingB },
      { id: "00000000-0000-4000-8000-000000000003" },
      { created_by: users.collabA.id },
      { created_at: "2000-01-01T00:00:00Z" },
      { updated_at: "2000-01-01T00:00:00Z" },
    ]) {
      const update = await as.ownerA.from("vendor_payment_schedule_items").update(extra).eq("id", item);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
    for (const extra of [{ id: "00000000-0000-4000-8000-000000000004" }, { created_by: users.collabA.id }]) {
      expect((await insertItem("ownerA", weddingA, vendor, extra)).error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
  });

  it("stores no currency, status or paid amount", async () => {
    const columns = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'vendor_payment_schedule_items' order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "id",
      "wedding_id",
      "wedding_vendor_id",
      "label",
      "amount_minor",
      "due_on",
      "created_by",
      "created_at",
      "updated_at",
    ]);
  });
});

// ================================================================ payments

describe("payments", () => {
  it("linked and unlinked payments, partial payments and the exact final payment", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 600_000 });
    const item = await createItem(weddingA, vendor, { amount_minor: 300_000 });

    expect((await insertPayment("collabA", weddingA, vendor, { schedule_item_id: item, amount_minor: 100_000 })).error).toBeNull();
    expect((await insertPayment("ownerA", weddingA, vendor, { schedule_item_id: item, amount_minor: 150_000 })).error).toBeNull();
    expect(await paidOnItem(item)).toBe(250_000);
    const over = await insertPayment("ownerA", weddingA, vendor, { schedule_item_id: item, amount_minor: 50_001 });
    expect(over.error).toMatchObject({ code: CHECK_VIOLATION, message: "vendor_payment_exceeds_schedule_item" });
    expect((await insertPayment("ownerA", weddingA, vendor, { schedule_item_id: item, amount_minor: 50_000 })).error).toBeNull();
    expect(await paidOnItem(item)).toBe(300_000);

    // Unlinked ("Sin cuota"): up to contract − schedule − other unlinked = 300 000.
    expect((await insertPayment("ownerA", weddingA, vendor, { amount_minor: 200_000, note: "SINPE #8842" })).error).toBeNull();
    const unlinkedOver = await insertPayment("collabA", weddingA, vendor, { amount_minor: 100_001 });
    expect(unlinkedOver.error).toMatchObject({ code: CHECK_VIOLATION, message: "vendor_payment_exceeds_unscheduled" });
    expect((await insertPayment("collabA", weddingA, vendor, { amount_minor: 100_000 })).error).toBeNull();
    expect(await recordedFloor(vendor)).toBe(600_000);
  });

  it("a payment needs a contracted amount", async () => {
    const vendor = await createVendor("ownerA", weddingA, { status: "quoted", contracted_amount_minor: null, quoted_amount_minor: 100 });
    expect((await insertPayment("ownerA", weddingA, vendor)).error).toMatchObject({
      code: CHECK_VIOLATION,
      message: "vendor_contract_required",
    });
  });

  it("a payment can't be applied to another vendor's (or wedding's) item", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    const other = await createVendor("ownerA", weddingA);
    const otherItem = await createItem(weddingA, other);
    expect((await insertPayment("ownerA", weddingA, vendor, { schedule_item_id: otherItem })).error?.code).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    const vendorB = await createVendor("ownerB", weddingB);
    const { data: itemB } = await as.ownerB
      .from("vendor_payment_schedule_items")
      .insert({ wedding_id: weddingB, wedding_vendor_id: vendorB, label: "B", amount_minor: 100, due_on: "2026-01-01" })
      .select("id")
      .single();
    expect((await insertPayment("ownerA", weddingA, vendor, { schedule_item_id: itemB!.id })).error?.code).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect((await insertPayment("ownerA", weddingA, vendorB)).error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await paidOnItem(otherItem)).toBe(0);
  });

  it("updates re-check every cap: amount, moving between items, item ↔ Sin cuota", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000 });
    const deposit = await createItem(weddingA, vendor, { label: "Depósito", amount_minor: 300_000 });
    const final = await createItem(weddingA, vendor, { label: "Final", amount_minor: 500_000 });
    const onDeposit = await createPayment(weddingA, vendor, { schedule_item_id: deposit, amount_minor: 300_000 });
    const onFinal = await createPayment(weddingA, vendor, { schedule_item_id: final, amount_minor: 400_000 });
    const unlinked = await createPayment(weddingA, vendor, { amount_minor: 150_000 });
    // Unscheduled room: 1 000 000 − 800 000 − 150 000 = 50 000.

    const update = (id: string, fields: Partial<PaymentInsert>) =>
      as.collabA.from("vendor_payments").update(fields).eq("id", id).select("id");

    // Amount: the item cap ignores the payment's own old amount.
    expect((await update(onFinal, { amount_minor: 500_001 })).error?.message).toBe("vendor_payment_exceeds_schedule_item");
    expect((await update(onFinal, { amount_minor: 500_000 })).error).toBeNull();
    expect((await update(unlinked, { amount_minor: 200_001 })).error?.message).toBe("vendor_payment_exceeds_unscheduled");
    expect((await update(unlinked, { amount_minor: 200_000 })).error).toBeNull();
    expect((await update(unlinked, { amount_minor: 150_000 })).error).toBeNull();

    // Item → item: the destination must have room.
    expect((await update(onDeposit, { schedule_item_id: final })).error?.message).toBe("vendor_payment_exceeds_schedule_item");
    // Item → Sin cuota: the unscheduled room must hold it (50 000 left).
    expect((await update(onDeposit, { schedule_item_id: null })).error?.message).toBe("vendor_payment_exceeds_unscheduled");
    expect(await paidOnItem(deposit)).toBe(300_000);

    // Free some room, then move: deposit payment of 50 000 → Sin cuota.
    expect((await update(onDeposit, { amount_minor: 50_000 })).error).toBeNull();
    expect((await update(onDeposit, { schedule_item_id: null })).error).toBeNull();
    expect(await paidOnItem(deposit)).toBe(0);
    expect(await recordedFloor(vendor)).toBe(1_000_000);

    // Sin cuota → item: the item cap applies (deposit has 300 000 free).
    expect((await update(unlinked, { schedule_item_id: deposit })).error).toBeNull();
    expect(await paidOnItem(deposit)).toBe(150_000);
    expect((await update(onDeposit, { schedule_item_id: final })).error?.message).toBe("vendor_payment_exceeds_schedule_item");
    expect((await update(onDeposit, { schedule_item_id: deposit, amount_minor: 150_000 })).error).toBeNull();
    expect(await paidOnItem(deposit)).toBe(300_000);

    // Date and note edits are plain edits.
    expect((await update(onFinal, { paid_on: "2019-12-31", note: "Transferencia BAC" })).error).toBeNull();
    expect(
      await sql("select paid_on::text as paid_on, note from public.vendor_payments where id = $1", [onFinal]),
    ).toEqual([{ paid_on: "2019-12-31", note: "Transferencia BAC" }]);
    expect((await update(onFinal, { note: null })).error).toBeNull();

    // Hard delete.
    expect((await as.ownerA.from("vendor_payments").delete().eq("id", onFinal).select("id")).data).toHaveLength(1);
    expect(await paidOnItem(final)).toBe(0);
  });

  it("validates amount and the one-line note", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    for (const amount of [0, -5, 100_000_000_000_000]) {
      expect((await insertPayment("ownerA", weddingA, vendor, { amount_minor: amount })).error?.code, String(amount)).toBe(
        CHECK_VIOLATION,
      );
    }
    for (const note of ["", " ", " SINPE", "SINPE ", "x".repeat(501), "Línea\notra", "Tab\there", "Bell\u0007"]) {
      expect((await insertPayment("ownerA", weddingA, vendor, { amount_minor: 1, note })).error?.code, JSON.stringify(note)).toBe(
        CHECK_VIOLATION,
      );
    }
    expect((await insertPayment("ownerA", weddingA, vendor, { amount_minor: 1, note: "x".repeat(500) })).error).toBeNull();
    expect((await insertPayment("ownerA", weddingA, vendor, { amount_minor: 1, note: "SINPE #8842" })).error).toBeNull();
  });

  it("clients can't move a payment to another vendor or wedding, nor write protected columns", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    const other = await createVendor("ownerA", weddingA);
    const payment = await createPayment(weddingA, vendor, { amount_minor: 1 });
    for (const extra of [
      { wedding_vendor_id: other },
      { wedding_id: weddingB },
      { id: "00000000-0000-4000-8000-000000000005" },
      { created_by: users.collabA.id },
      { created_at: "2000-01-01T00:00:00Z" },
    ]) {
      const update = await as.ownerA.from("vendor_payments").update(extra).eq("id", payment);
      expect(update.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
    }
  });

  it("stores no currency, status or payment method", async () => {
    const columns = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'vendor_payments' order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "id",
      "wedding_id",
      "wedding_vendor_id",
      "schedule_item_id",
      "amount_minor",
      "paid_on",
      "note",
      "created_by",
      "created_at",
      "updated_at",
    ]);
  });
});

// =============================================================== tenancy

describe("financial tenancy", () => {
  it("non-members, other weddings' members and anon can't enumerate or touch schedule items or payments", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    const item = await createItem(weddingA, vendor, { label: "Secreto" });
    const payment = await createPayment(weddingA, vendor, { schedule_item_id: item, amount_minor: 1_000, note: "Nota secreta" });

    for (const actor of ["outsider", "ownerB"] as const) {
      for (const [table, id] of [
        ["vendor_payment_schedule_items", item],
        ["vendor_payments", payment],
      ] as const) {
        expect((await as[actor].from(table).select("*").eq("wedding_id", weddingA)).data).toEqual([]);
        expect((await as[actor].from(table).select("*").eq("id", id)).data).toEqual([]);
        expect((await as[actor].from(table).update({ amount_minor: 1 }).eq("id", id).select("id")).data).toEqual([]);
        expect((await as[actor].from(table).delete().eq("id", id).select("id")).data).toEqual([]);
      }
      expect((await insertPayment(actor, weddingA, vendor, { amount_minor: 1 })).error?.code).toBe(PERMISSION_DENIED);
      expect((await insertItem(actor, weddingA, vendor)).error?.code).toBe(PERMISSION_DENIED);
    }
    for (const table of ["vendor_payment_schedule_items", "vendor_payments"] as const) {
      expect((await as.anon.from(table).select("id")).error?.code).toBe(PERMISSION_DENIED);
      expect((await as.anon.from(table).delete().eq("wedding_id", weddingA)).error?.code).toBe(PERMISSION_DENIED);
      expect((await as.anon.from(table).update({ amount_minor: 1 }).eq("wedding_id", weddingA)).error?.code).toBe(
        PERMISSION_DENIED,
      );
    }
    expect((await insertPayment("anon", weddingA, vendor)).error?.code).toBe(PERMISSION_DENIED);
    expect(await paidOnItem(item)).toBe(1_000);
  });
});

// ============================================================ vendor guard

describe("vendor financial guard", () => {
  const updateVendor = (vendorId: string, fields: Partial<VendorInsert>, actor: TestUserKey = "ownerA") =>
    as[actor].from("wedding_vendors").update(fields).eq("id", vendorId).select("id");

  it("currency may change freely without financial children", async () => {
    const vendor = await createVendor("ownerA", weddingA);
    expect((await updateVendor(vendor, { currency: "USD" })).error).toBeNull();
    expect((await updateVendor(vendor, { currency: "CRC" })).error).toBeNull();
    expect((await updateVendor(vendor, { contracted_amount_minor: null, currency: null })).error).toBeNull();
  });

  it("a schedule item or a payment locks the currency (same currency is a no-op)", async () => {
    const withItem = await createVendor("ownerA", weddingA);
    await createItem(weddingA, withItem);
    const withPayment = await createVendor("ownerA", weddingA);
    await createPayment(weddingA, withPayment, { amount_minor: 1 });
    for (const vendor of [withItem, withPayment]) {
      expect((await updateVendor(vendor, { currency: "USD" }, "collabA")).error).toMatchObject({
        code: CHECK_VIOLATION,
        message: "vendor_currency_locked",
      });
      expect((await updateVendor(vendor, { currency: "CRC", name: "Mismo" })).error).toBeNull();
      expect(await sql("select currency from public.wedding_vendors where id = $1", [vendor])).toEqual([{ currency: "CRC" }]);
    }
  });

  it("with children the contract can't become null, can grow, and can drop exactly to the floor", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000, quoted_amount_minor: 1_200_000 });
    const item = await createItem(weddingA, vendor, { amount_minor: 300_000 });
    await createPayment(weddingA, vendor, { schedule_item_id: item, amount_minor: 100_000 });
    await createPayment(weddingA, vendor, { amount_minor: 200_000 });
    // Floor = 300 000 (item) + 200 000 (unlinked) = 500 000; the linked 100 000 is inside the item.

    expect((await updateVendor(vendor, { contracted_amount_minor: null })).error).toMatchObject({
      code: CHECK_VIOLATION,
      message: "vendor_contract_required",
    });
    expect((await updateVendor(vendor, { contracted_amount_minor: 2_000_000 })).error).toBeNull();
    expect((await updateVendor(vendor, { contracted_amount_minor: 499_999 })).error).toMatchObject({
      code: CHECK_VIOLATION,
      message: "vendor_contract_below_recorded",
    });
    expect((await updateVendor(vendor, { contracted_amount_minor: 500_000 }, "collabA")).error).toBeNull();
    expect(await contractOf(vendor)).toBe(500_000);

    // Quote and status are not coupled to finance records.
    expect((await updateVendor(vendor, { quoted_amount_minor: null })).error).toBeNull();
    expect((await updateVendor(vendor, { quoted_amount_minor: 1 })).error).toBeNull();
    for (const status of ["discarded", "considering", "booked"] as const) {
      expect((await updateVendor(vendor, { status })).error, status).toBeNull();
    }
  });

  it("deleting a vendor with any financial child is refused; without children it still works", async () => {
    const withItem = await createVendor("ownerA", weddingA);
    await createItem(weddingA, withItem);
    const withUnlinked = await createVendor("ownerA", weddingA);
    await createPayment(weddingA, withUnlinked, { amount_minor: 1 });
    const withLinked = await createVendor("ownerA", weddingA);
    await createPayment(weddingA, withLinked, { schedule_item_id: await createItem(weddingA, withLinked), amount_minor: 1 });

    for (const vendor of [withItem, withUnlinked, withLinked]) {
      for (const actor of ["ownerA", "collabA"] as const) {
        const del = await as[actor].from("wedding_vendors").delete().eq("id", vendor).select("id");
        expect(del.error?.code).toBe(FOREIGN_KEY_VIOLATION);
      }
      expect(await contractOf(vendor)).toBe(100_000_000);
    }
    const clean = await createVendor("ownerA", weddingA);
    expect((await as.collabA.from("wedding_vendors").delete().eq("id", clean).select("id")).data).toEqual([{ id: clean }]);
  });
});

// =========================================================== item deletion

describe("schedule item deletion", () => {
  it("an item with payments can't be deleted until they move to Sin cuota or are deleted", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000 });
    const first = await createItem(weddingA, vendor, { amount_minor: 300_000 });
    const payment = await createPayment(weddingA, vendor, { schedule_item_id: first, amount_minor: 100_000 });

    const blocked = await as.collabA.from("vendor_payment_schedule_items").delete().eq("id", first).select("id");
    expect(blocked.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await paidOnItem(first)).toBe(100_000);

    // Moved to Sin cuota (room: 1 000 000 − 300 000 = 700 000), then the delete works.
    expect((await as.ownerA.from("vendor_payments").update({ schedule_item_id: null }).eq("id", payment)).error).toBeNull();
    expect((await as.ownerA.from("vendor_payment_schedule_items").delete().eq("id", first).select("id")).data).toHaveLength(1);
    expect(await sql("select schedule_item_id from public.vendor_payments where id = $1", [payment])).toEqual([
      { schedule_item_id: null },
    ]);

    const second = await createItem(weddingA, vendor, { amount_minor: 300_000 });
    const linked = await createPayment(weddingA, vendor, { schedule_item_id: second, amount_minor: 1_000 });
    expect((await as.ownerA.from("vendor_payment_schedule_items").delete().eq("id", second)).error?.code).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect((await as.ownerA.from("vendor_payments").delete().eq("id", linked)).error).toBeNull();
    expect((await as.ownerA.from("vendor_payment_schedule_items").delete().eq("id", second).select("id")).data).toHaveLength(1);
  });
});

// ========================================================= wedding cascade

describe("wedding deletion", () => {
  it("cascades budget rows, vendors, schedule items and payments together", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda que se borra con pagos");
    const vendor = await createVendor("ownerA", wedding);
    const item = await createItem(wedding, vendor);
    await createPayment(wedding, vendor, { schedule_item_id: item, amount_minor: 1_000 });
    await createPayment(wedding, vendor, { amount_minor: 2_000 });
    expect(
      (await as.ownerA.from("wedding_budget_totals").insert({ wedding_id: wedding, currency: "CRC", amount_minor: 1 })).error,
    ).toBeNull();
    expect(
      (
        await as.ownerA
          .from("wedding_budget_allocations")
          .insert({ wedding_id: wedding, category: "photography", currency: "CRC", amount_minor: 1 })
      ).error,
    ).toBeNull();

    await sql("delete from public.weddings where id = $1", [wedding]);
    for (const table of [
      "wedding_vendors",
      "vendor_payment_schedule_items",
      "vendor_payments",
      "wedding_budget_totals",
      "wedding_budget_allocations",
    ]) {
      expect(await sql(`select 1 from public.${table} where wedding_id = $1`, [wedding]), table).toEqual([]);
    }
  });
});

// ============================================================ concurrency

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

const INSERT_PAYMENT =
  "insert into public.vendor_payments (wedding_id, wedding_vendor_id, schedule_item_id, amount_minor, paid_on) values ($1, $2, $3, $4, '2026-10-01')";

/**
 * Runs `firstSql` in one transaction (left open), starts `secondSql` in
 * another, requires that the second WAITS (the vendor row lock), commits the
 * first and returns the second's outcome (then rolls it back or commits).
 */
async function race(
  firstSql: [string, unknown[]],
  secondSql: [string, unknown[]],
  { commitSecond = false } = {},
): Promise<{ first: Settled; second: Settled }> {
  const a = await authenticatedTransaction("ownerA");
  const b = await authenticatedTransaction("collabA");
  try {
    const first = await track(a.query(...firstSql)).done;
    const second = track(b.query(...secondSql));
    await wait(400);
    expect(second.settled()).toBe(false);
    await a.query("commit");
    const outcome = await second.done;
    await b.query(commitSecond && outcome.status === "fulfilled" ? "commit" : "rollback");
    return { first, second: outcome };
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
  }
}

describe("financial concurrency", () => {
  it("two concurrent final payments of the same item: exactly one wins", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 100_000 });
    const item = await createItem(weddingA, vendor, { amount_minor: 100_000 });
    const { first, second } = await race(
      [INSERT_PAYMENT, [weddingA, vendor, item, 100_000]],
      [INSERT_PAYMENT, [weddingA, vendor, item, 100_000]],
      { commitSecond: true },
    );
    expect(first).toEqual({ status: "fulfilled" });
    expect(second).toEqual({ status: "rejected", code: CHECK_VIOLATION, message: "vendor_payment_exceeds_schedule_item" });
    expect(await paidOnItem(item)).toBe(100_000);
  });

  it("a payment racing a contract reduction never leaves the vendor below its floor", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000 });
    await createItem(weddingA, vendor, { amount_minor: 400_000 });
    // Payment first: the reduction waits, then sees the payment.
    const paymentFirst = await race(
      [INSERT_PAYMENT, [weddingA, vendor, null, 300_000]],
      ["update public.wedding_vendors set contracted_amount_minor = 500000 where id = $1", [vendor]],
      { commitSecond: true },
    );
    expect(paymentFirst.first).toEqual({ status: "fulfilled" });
    expect(paymentFirst.second).toMatchObject({ status: "rejected", message: "vendor_contract_below_recorded" });
    expect(await contractOf(vendor)).toBe(1_000_000);

    // Reduction first: the payment waits, then sees the smaller contract.
    const reductionFirst = await race(
      ["update public.wedding_vendors set contracted_amount_minor = 750000 where id = $1", [vendor]],
      [INSERT_PAYMENT, [weddingA, vendor, null, 100_000]],
      { commitSecond: true },
    );
    expect(reductionFirst.first).toEqual({ status: "fulfilled" });
    expect(reductionFirst.second).toMatchObject({ status: "rejected", message: "vendor_payment_exceeds_unscheduled" });
    expect(await contractOf(vendor)).toBe(750_000);
    expect(await recordedFloor(vendor)).toBeLessThanOrEqual(750_000);
  });

  it("a payment racing an item reduction never exceeds the item", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000 });
    const item = await createItem(weddingA, vendor, { amount_minor: 500_000 });
    const paymentFirst = await race(
      [INSERT_PAYMENT, [weddingA, vendor, item, 400_000]],
      ["update public.vendor_payment_schedule_items set amount_minor = 300000 where id = $1", [item]],
      { commitSecond: true },
    );
    expect(paymentFirst.first).toEqual({ status: "fulfilled" });
    expect(paymentFirst.second).toMatchObject({ status: "rejected", message: "vendor_schedule_item_below_paid" });

    const reductionFirst = await race(
      ["update public.vendor_payment_schedule_items set amount_minor = 450000 where id = $1", [item]],
      [INSERT_PAYMENT, [weddingA, vendor, item, 100_000]],
      { commitSecond: true },
    );
    expect(reductionFirst.first).toEqual({ status: "fulfilled" });
    expect(reductionFirst.second).toMatchObject({ status: "rejected", message: "vendor_payment_exceeds_schedule_item" });
    const [row] = await sql<{ amount: string }>(
      "select amount_minor::text as amount from public.vendor_payment_schedule_items where id = $1",
      [item],
    );
    expect(await paidOnItem(item)).toBeLessThanOrEqual(Number(row!.amount));
  });

  it("two concurrent unscheduled payments competing for the last room: exactly one wins", async () => {
    const vendor = await createVendor("ownerA", weddingA, { contracted_amount_minor: 1_000_000 });
    await createItem(weddingA, vendor, { amount_minor: 600_000 });
    const { first, second } = await race(
      [INSERT_PAYMENT, [weddingA, vendor, null, 300_000]],
      [INSERT_PAYMENT, [weddingA, vendor, null, 300_000]],
      { commitSecond: true },
    );
    expect(first).toEqual({ status: "fulfilled" });
    expect(second).toMatchObject({ status: "rejected", message: "vendor_payment_exceeds_unscheduled" });
    expect(await recordedFloor(vendor)).toBe(900_000);
  });
});

// =============================================================== security

describe("financial security and structure", () => {
  it("the three trigger functions are invoker-rights, pin search_path and aren't client-executable", async () => {
    const rows = await sql<{ name: string; definer: boolean; config: string[]; anon: boolean; authenticated: boolean }>(
      `select p.proname as name, p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
       from pg_proc p
       where p.pronamespace = 'private'::regnamespace
         and p.proname in ('enforce_vendor_payment', 'enforce_vendor_payment_schedule_item', 'enforce_wedding_vendor_finance')
       order by 1`,
    );
    expect(rows).toEqual(
      ["enforce_vendor_payment", "enforce_vendor_payment_schedule_item", "enforce_wedding_vendor_finance"].map((name) => ({
        name,
        definer: false,
        config: ['search_path=""'],
        anon: false,
        authenticated: false,
      })),
    );
  });

  it("every financial trigger locks the parent vendor FOR UPDATE before summing", async () => {
    const rows = await sql<{ name: string; source: string }>(
      `select p.proname as name, p.prosrc as source from pg_proc p
       where p.pronamespace = 'private'::regnamespace
         and p.proname in ('enforce_vendor_payment', 'enforce_vendor_payment_schedule_item')`,
    );
    expect(rows).toHaveLength(2);
    // Behavior is proven by the concurrency tests; this pins where the lock is.
    for (const row of rows) expect(row.source.toLowerCase(), row.name).toMatch(/from public\.wedding_vendors v[\s\S]*for update/);
  });

  it("no public RPC or SECURITY DEFINER function touches budget or payment tables", async () => {
    const rows = await sql<{ name: string; definer: boolean }>(
      `select p.pronamespace::regnamespace || '.' || p.proname as name, p.prosecdef as definer from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and (p.prosrc ilike '%vendor_payment%' or p.prosrc ilike '%wedding_budget%')
       order by 1`,
    );
    expect(rows).toEqual([
      { name: "private.enforce_vendor_payment", definer: false },
      { name: "private.enforce_vendor_payment_schedule_item", definer: false },
      { name: "private.enforce_wedding_vendor_finance", definer: false },
    ]);
  });

  it("vendor children are NO ACTION (never cascade from a vendor or item); wedding references cascade", async () => {
    const rows = await sql<{ name: string; action: string; definition: string }>(
      `select conname as name, confdeltype as action, pg_get_constraintdef(oid) as definition from pg_constraint
       where contype = 'f' and conrelid in ('public.vendor_payment_schedule_items'::regclass, 'public.vendor_payments'::regclass)
         and conname not like '%created_by%'
       order by conname`,
    );
    expect(rows.map((r) => [r.name, r.action])).toEqual([
      ["vendor_payment_schedule_items_vendor_same_wedding", "a"],
      ["vendor_payment_schedule_items_wedding_id_fkey", "c"],
      ["vendor_payments_schedule_item_same_vendor", "a"],
      ["vendor_payments_vendor_same_wedding", "a"],
      ["vendor_payments_wedding_id_fkey", "c"],
    ]);
    expect(rows.find((r) => r.name === "vendor_payments_schedule_item_same_vendor")?.definition).toBe(
      "FOREIGN KEY (schedule_item_id, wedding_vendor_id, wedding_id) REFERENCES vendor_payment_schedule_items(id, wedding_vendor_id, wedding_id)",
    );
  });

  it("has exactly the four member policies per table and exact column grants", async () => {
    const tables = ["wedding_budget_totals", "wedding_budget_allocations", "vendor_payment_schedule_items", "vendor_payments"];
    for (const table of tables) {
      const policies = await sql<{ cmd: string; roles: string[]; qual: string | null; check: string | null }>(
        `select cmd, roles::text[] as roles, qual, with_check as check from pg_policies
         where schemaname = 'public' and tablename = $1 order by cmd`,
        [table],
      );
      expect(policies.map((p) => [p.cmd, p.roles]), table).toEqual([
        ["DELETE", ["authenticated"]],
        ["INSERT", ["authenticated"]],
        ["SELECT", ["authenticated"]],
        ["UPDATE", ["authenticated"]],
      ]);
      for (const p of policies) {
        for (const expr of [p.qual, p.check].filter((e): e is string => e !== null)) {
          expect(expr, table).toBe("private.is_wedding_member(wedding_id)");
        }
      }
    }

    const grants = await sql<{ table_name: string; privilege_type: string; column_name: string }>(
      `select table_name, privilege_type, column_name from information_schema.column_privileges
       where grantee = 'authenticated' and table_schema = 'public' and table_name = any($1)
         and privilege_type in ('INSERT', 'UPDATE')
       order by table_name, privilege_type, column_name`,
      [tables],
    );
    const of = (table: string, privilege: string) =>
      grants.filter((g) => g.table_name === table && g.privilege_type === privilege).map((g) => g.column_name);
    expect(of("wedding_budget_totals", "INSERT")).toEqual(["amount_minor", "currency", "wedding_id"]);
    expect(of("wedding_budget_totals", "UPDATE")).toEqual(["amount_minor"]);
    expect(of("wedding_budget_allocations", "INSERT")).toEqual(["amount_minor", "category", "currency", "wedding_id"]);
    expect(of("wedding_budget_allocations", "UPDATE")).toEqual(["amount_minor"]);
    expect(of("vendor_payment_schedule_items", "INSERT")).toEqual([
      "amount_minor",
      "due_on",
      "label",
      "wedding_id",
      "wedding_vendor_id",
    ]);
    expect(of("vendor_payment_schedule_items", "UPDATE")).toEqual(["amount_minor", "due_on", "label"]);
    expect(of("vendor_payments", "INSERT")).toEqual([
      "amount_minor",
      "note",
      "paid_on",
      "schedule_item_id",
      "wedding_id",
      "wedding_vendor_id",
    ]);
    expect(of("vendor_payments", "UPDATE")).toEqual(["amount_minor", "note", "paid_on", "schedule_item_id"]);

    const tableGrants = await sql<{ table_name: string; privilege_type: string; grantee: string }>(
      `select table_name, privilege_type, grantee from information_schema.role_table_grants
       where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated')
       order by grantee, table_name, privilege_type`,
      [tables],
    );
    expect(tableGrants.filter((g) => g.grantee === "anon")).toEqual([]);
    for (const table of tables) {
      expect(tableGrants.filter((g) => g.table_name === table).map((g) => g.privilege_type), table).toEqual(["DELETE", "SELECT"]);
    }
  });

  it("indexes: per-vendor sums, the wedding schedule by date and linked payments", async () => {
    const indexes = await sql<{ definition: string }>(
      `select indexdef as definition from pg_indexes
       where schemaname = 'public' and tablename in ('vendor_payment_schedule_items', 'vendor_payments') order by indexname`,
    );
    expect(indexes.map((i) => i.definition)).toEqual([
      "CREATE UNIQUE INDEX vendor_payment_schedule_items_id_vendor_wedding_key ON public.vendor_payment_schedule_items USING btree (id, wedding_vendor_id, wedding_id)",
      "CREATE UNIQUE INDEX vendor_payment_schedule_items_pkey ON public.vendor_payment_schedule_items USING btree (id)",
      "CREATE INDEX vendor_payment_schedule_items_vendor_idx ON public.vendor_payment_schedule_items USING btree (wedding_vendor_id)",
      "CREATE INDEX vendor_payment_schedule_items_wedding_due_idx ON public.vendor_payment_schedule_items USING btree (wedding_id, due_on)",
      "CREATE UNIQUE INDEX vendor_payments_pkey ON public.vendor_payments USING btree (id)",
      "CREATE INDEX vendor_payments_schedule_item_idx ON public.vendor_payments USING btree (schedule_item_id) WHERE (schedule_item_id IS NOT NULL)",
      "CREATE INDEX vendor_payments_vendor_idx ON public.vendor_payments USING btree (wedding_vendor_id)",
    ]);
  });

  it("the published site and the guest RSVP view carry no budget or payment data", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda pública con pagos");
    const vendor = await createVendor("ownerA", wedding, { contracted_amount_minor: 987_654_321 });
    const item = await createItem(wedding, vendor, { label: "CuotaSecretaLB22", amount_minor: 123_456_789 });
    await createPayment(wedding, vendor, { schedule_item_id: item, amount_minor: 55_555, note: "NotaSecretaLB22" });
    await as.ownerA.from("wedding_budget_totals").insert({ wedding_id: wedding, currency: "CRC", amount_minor: 4_444_444 });

    const slug = `pagos-${randomBytes(4).toString("hex")}`;
    expect((await as.ownerA.rpc("set_wedding_site_slug", { target_wedding_id: wedding, new_slug: slug })).error).toBeNull();
    await as.ownerA.rpc("save_wedding_site_section", {
      target_wedding_id: wedding,
      section_kind: "intro",
      section_title: "Bienvenidos",
      section_body: "Hola",
      section_visible: true,
    });
    expect((await as.ownerA.rpc("publish_wedding_site", { target_wedding_id: wedding })).error).toBeNull();
    const site = await as.anon.rpc("get_published_wedding_site", { site_slug: slug });
    expect(site.data).not.toBeNull();

    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: wedding,
      party_label: "Familia",
      invitation_token_hash: hash,
      invitation_token_ciphertext: shapedEnvelope(),
      guest_names: ["Ana"],
    });
    const rsvp = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: hash });
    expect(rsvp.error).toBeNull();

    for (const payload of [site.data, rsvp.data]) {
      const text = JSON.stringify(payload);
      for (const secret of ["CuotaSecretaLB22", "NotaSecretaLB22", "123456789", "987654321", "55555", "4444444"]) {
        expect(text).not.toContain(secret);
      }
      expect(text.toLowerCase()).not.toMatch(/payment|budget|presupuesto/);
    }
  });
});
