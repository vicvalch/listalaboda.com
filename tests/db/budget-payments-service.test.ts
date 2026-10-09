import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { VendorInput } from "@/lib/vendors/validation";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { getWeddingBudget, setBudgetAllocation, setBudgetTotal } = await import("@/lib/budget/service");
const { summarizeBudget, vendorFinance } = await import("@/lib/budget/summary");
const payments = await import("@/lib/vendors/payments");
const { createWeddingVendor, deleteWeddingVendor, getWeddingVendor, updateWeddingVendor } = await import(
  "@/lib/vendors/service"
);
const { parseVendorInput } = await import("@/lib/vendors/validation");

// LB-22 services (what the Server Actions and pages call) against the real
// local stack: identity from the real Auth server, authority from real
// memberships, RLS, grants and the financial triggers underneath.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** A session client whose PostgREST requests are counted. */
async function sessionClient(user: TestUserKey) {
  const requests: string[] = [];
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.startsWith("/rest/v1/")) requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return fetch(input, init);
      },
    },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return { supabase, requests };
}

async function accessOf(user: TestUserKey, weddingId: string) {
  const { supabase, requests } = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  return { supabase, requests, access: access.access };
}

function vendorInput(overrides: Record<string, string> = {}): VendorInput {
  const result = parseVendorInput({
    name: "Fotografía Luz",
    category: "photography",
    customCategory: "",
    status: "booked",
    contactName: "",
    email: "",
    phone: "",
    instagramHandle: "",
    currency: "CRC",
    quotedAmount: "",
    contractedAmount: "6.000",
    notes: "",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.fieldErrors));
  return result.input;
}

async function newVendor(user: TestUserKey, weddingId: string, overrides: Record<string, string> = {}): Promise<string> {
  const { supabase } = await sessionClient(user);
  const created = await createWeddingVendor(supabase, weddingId, vendorInput(overrides));
  if (!created.ok) throw new Error(created.reason);
  return created.vendorId;
}

const item = (label: string, amountMinor: number, dueOn = "2026-11-01") => ({ label, amountMinor, dueOn });
const pay = (amountMinor: number, scheduleItemId: string | null = null, note: string | null = null) => ({
  amountMinor,
  paidOn: "2026-10-01",
  scheduleItemId,
  note,
});

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Servicio Pagos A");
  weddingB = await fixtureWedding("ownerB", "Boda Servicio Pagos B");
  await addMember(weddingA, "collabA", "collaborator");
});

// ================================================================== budget

describe("budget service", () => {
  it("sets, updates, reads and removes totals and allocations (owner and collaborator)", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda servicio presupuesto");
    await addMember(wedding, "collabA", "collaborator");
    const owner = await accessOf("ownerA", wedding);
    const collab = await accessOf("collabA", wedding);

    expect(await setBudgetTotal(owner.supabase, wedding, "CRC", 1_200_000_000)).toEqual({ ok: true });
    expect(await setBudgetTotal(collab.supabase, wedding, "CRC", 1_500_000_000)).toEqual({ ok: true });
    expect(await setBudgetTotal(collab.supabase, wedding, "USD", 250_000)).toEqual({ ok: true });
    expect(await setBudgetAllocation(owner.supabase, wedding, "photography", "USD", 200_000)).toEqual({ ok: true });
    expect(await setBudgetAllocation(collab.supabase, wedding, "photography", "CRC", 0)).toEqual({ ok: true });
    expect(await setBudgetAllocation(collab.supabase, wedding, "photography", "USD", 210_000)).toEqual({ ok: true });

    const budget = await getWeddingBudget(owner.supabase, owner.access);
    expect(budget?.totals).toEqual(
      expect.arrayContaining([
        { currency: "CRC", amountMinor: 1_500_000_000 },
        { currency: "USD", amountMinor: 250_000 },
      ]),
    );
    expect(budget?.allocations).toEqual(
      expect.arrayContaining([
        { category: "photography", currency: "USD", amountMinor: 210_000 },
        { category: "photography", currency: "CRC", amountMinor: 0 },
      ]),
    );
    expect(budget?.allocations).toHaveLength(2);

    expect(await setBudgetTotal(collab.supabase, wedding, "CRC", null)).toEqual({ ok: true });
    expect(await setBudgetAllocation(owner.supabase, wedding, "photography", "CRC", null)).toEqual({ ok: true });
    // Removing what doesn't exist is fine (idempotent).
    expect(await setBudgetTotal(owner.supabase, wedding, "CRC", null)).toEqual({ ok: true });
    const after = await getWeddingBudget(owner.supabase, owner.access);
    expect(after?.totals).toEqual([{ currency: "USD", amountMinor: 250_000 }]);
    expect(after?.allocations).toEqual([{ category: "photography", currency: "USD", amountMinor: 210_000 }]);
    expect(await sql("select created_by from public.wedding_budget_totals where wedding_id = $1", [wedding])).toEqual([
      { created_by: users.collabA.id },
    ]);
  });

  it("refuses invalid input before any request, and non-members get not_found", async () => {
    const { supabase, requests } = await sessionClient("ownerA");
    expect(await setBudgetTotal(supabase, weddingA, "EUR" as "CRC", 1)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await setBudgetTotal(supabase, weddingA, "CRC", -1)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await setBudgetTotal(supabase, weddingA, "CRC", 1.5)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await setBudgetAllocation(supabase, weddingA, "florist" as "venue", "CRC", 1)).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(requests).toEqual([]);

    const outsider = await sessionClient("ownerB");
    expect(await setBudgetTotal(outsider.supabase, weddingA, "CRC", 1)).toEqual({ ok: false, reason: "not_found" });
    expect(await setBudgetAllocation(outsider.supabase, weddingA, "venue", "CRC", null)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("reads the budget page data in a fixed number of queries at 50 vendors, 150 items and 300 payments", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda grande presupuesto");
    // Fixture rows inserted directly (the triggers still run): contract 10 000 000 each.
    await sql(
      `insert into public.wedding_vendors (wedding_id, name, category, status, currency, contracted_amount_minor)
       select $1, 'Proveedor ' || g, 'photography', 'booked', case when g % 2 = 0 then 'CRC' else 'USD' end, 10000000
       from generate_series(1, 50) g`,
      [wedding],
    );
    await sql(
      `insert into public.vendor_payment_schedule_items (wedding_id, wedding_vendor_id, label, amount_minor, due_on)
       select v.wedding_id, v.id, 'Cuota ' || g, 2000000, date '2026-10-01' + g * 30
       from public.wedding_vendors v cross join generate_series(1, 3) g where v.wedding_id = $1`,
      [wedding],
    );
    await sql(
      `insert into public.vendor_payments (wedding_id, wedding_vendor_id, schedule_item_id, amount_minor, paid_on)
       select s.wedding_id, s.wedding_vendor_id, s.id, 1000000, date '2026-09-01'
       from public.vendor_payment_schedule_items s cross join generate_series(1, 2) g where s.wedding_id = $1`,
      [wedding],
    );
    await setBudgetTotal((await sessionClient("ownerA")).supabase, wedding, "CRC", 900_000_000);

    const { supabase, requests, access } = await accessOf("ownerA", wedding);
    requests.length = 0;
    const started = performance.now();
    const budget = await getWeddingBudget(supabase, access);
    const loaded = performance.now();
    const summary = summarizeBudget({ ...budget!, today: "2026-10-20" });
    const derived = performance.now();

    // Exactly two reads, whatever the size: no per-vendor, per-item or per-payment query.
    expect(requests.sort()).toEqual(["GET /rest/v1/wedding_vendors", "GET /rest/v1/weddings"]);
    expect(budget?.vendors).toHaveLength(50);
    expect(budget?.vendors.flatMap((v) => v.scheduleItems)).toHaveLength(150);
    expect(budget?.vendors.flatMap((v) => v.payments)).toHaveLength(300);
    expect(summary.currencies.map((c) => [c.currency, c.committedMinor, c.paidMinor])).toEqual([
      ["CRC", BigInt(250_000_000), BigInt(150_000_000)],
      ["USD", BigInt(250_000_000), BigInt(150_000_000)],
    ]);
    // Responsive without pagination or virtualization at this scale.
    expect(derived - loaded).toBeLessThan(250);
    expect(loaded - started).toBeLessThan(5_000);
  });
});

// ========================================================== schedule items

describe("schedule item service", () => {
  it("creates, updates and deletes items; maps every refusal to its closed reason", async () => {
    const vendorId = await newVendor("ownerA", weddingA, { contractedAmount: "6.000" }); // 600 000 minor
    const { supabase } = await accessOf("collabA", weddingA);

    const created = await payments.createScheduleItem(supabase, weddingA, vendorId, item("Depósito", 300_000));
    if (!created.ok) throw new Error(created.reason);
    expect(await payments.createScheduleItem(supabase, weddingA, vendorId, item("Demasiado", 300_001))).toEqual({
      ok: false,
      reason: "schedule_exceeds_contract",
    });
    expect(await payments.updateScheduleItem(supabase, weddingA, vendorId, created.id, item("Depósito 50 %", 250_000))).toEqual({
      ok: true,
      id: created.id,
    });

    const paid = await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(200_000, created.id));
    expect(paid.ok).toBe(true);
    expect(await payments.updateScheduleItem(supabase, weddingA, vendorId, created.id, item("Depósito", 199_999))).toEqual({
      ok: false,
      reason: "schedule_item_below_paid",
    });
    expect(await payments.deleteScheduleItem(supabase, weddingA, vendorId, created.id)).toEqual({
      ok: false,
      reason: "schedule_item_has_payments",
    });
    if (!paid.ok) throw new Error(paid.reason);
    expect(await payments.deleteVendorPayment(supabase, weddingA, vendorId, paid.id)).toEqual({ ok: true, id: paid.id });
    expect(await payments.deleteScheduleItem(supabase, weddingA, vendorId, created.id)).toEqual({ ok: true, id: created.id });
  });

  it("a vendor without a contract: contract_required", async () => {
    const vendorId = await newVendor("ownerA", weddingA, { status: "quoted", contractedAmount: "", quotedAmount: "100" });
    const { supabase } = await accessOf("ownerA", weddingA);
    expect(await payments.createScheduleItem(supabase, weddingA, vendorId, item("Depósito", 1))).toEqual({
      ok: false,
      reason: "contract_required",
    });
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(1))).toEqual({
      ok: false,
      reason: "contract_required",
    });
  });

  it("known foreign ids are invalid_target and stay untouched; naming a foreign wedding is not_found", async () => {
    const foreignVendor = await newVendor("ownerB", weddingB);
    const ownerB = await sessionClient("ownerB");
    const foreignItem = await payments.createScheduleItem(ownerB.supabase, weddingB, foreignVendor, item("Ajena", 100));
    const foreignPayment = await payments.recordVendorPayment(ownerB.supabase, weddingB, foreignVendor, pay(50));
    if (!foreignItem.ok || !foreignPayment.ok) throw new Error("fixture");

    const { supabase } = await accessOf("ownerA", weddingA);
    const ownVendor = await newVendor("ownerA", weddingA);
    expect(await payments.createScheduleItem(supabase, weddingA, foreignVendor, item("X", 1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.updateScheduleItem(supabase, weddingA, foreignVendor, foreignItem.id, item("X", 1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.updateScheduleItem(supabase, weddingA, ownVendor, foreignItem.id, item("X", 1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.deleteScheduleItem(supabase, weddingA, foreignVendor, foreignItem.id)).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.recordVendorPayment(supabase, weddingA, foreignVendor, pay(1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.recordVendorPayment(supabase, weddingA, ownVendor, pay(1, foreignItem.id))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.updateVendorPayment(supabase, weddingA, foreignVendor, foreignPayment.id, pay(1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.deleteVendorPayment(supabase, weddingA, foreignVendor, foreignPayment.id)).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await payments.deleteVendorPayment(supabase, weddingB, foreignVendor, foreignPayment.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await payments.createScheduleItem(supabase, weddingA, "not-a-uuid", item("X", 1))).toEqual({
      ok: false,
      reason: "invalid_target",
    });

    expect(await sql("select label from public.vendor_payment_schedule_items where id = $1", [foreignItem.id])).toEqual([
      { label: "Ajena" },
    ]);
    expect(await sql("select amount_minor::int from public.vendor_payments where id = $1", [foreignPayment.id])).toEqual([
      { amount_minor: 50 },
    ]);
  });
});

// ================================================================ payments

describe("payment service", () => {
  it("records, moves and edits payments; every cap maps to its reason", async () => {
    const vendorId = await newVendor("ownerA", weddingA, { contractedAmount: "10.000" }); // 1 000 000 minor
    const { supabase, access } = await accessOf("ownerA", weddingA);
    const deposit = await payments.createScheduleItem(supabase, weddingA, vendorId, item("Depósito", 300_000));
    const final = await payments.createScheduleItem(supabase, weddingA, vendorId, item("Final", 600_000));
    if (!deposit.ok || !final.ok) throw new Error("fixture");

    const partial = await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(100_000, deposit.id, "SINPE #8842"));
    if (!partial.ok) throw new Error(partial.reason);
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(200_001, deposit.id))).toEqual({
      ok: false,
      reason: "payment_exceeds_schedule_item",
    });
    const unlinked = await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(100_000));
    if (!unlinked.ok) throw new Error(unlinked.reason);
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(1))).toEqual({
      ok: false,
      reason: "payment_exceeds_unscheduled",
    });

    // Sin cuota → item.
    expect(await payments.updateVendorPayment(supabase, weddingA, vendorId, unlinked.id, pay(100_000, final.id))).toEqual({
      ok: true,
      id: unlinked.id,
    });
    // Item → Sin cuota (room: 1 000 000 − 900 000 = 100 000).
    expect(await payments.updateVendorPayment(supabase, weddingA, vendorId, partial.id, pay(100_001, null))).toEqual({
      ok: false,
      reason: "payment_exceeds_unscheduled",
    });
    expect(await payments.updateVendorPayment(supabase, weddingA, vendorId, partial.id, pay(100_000, null, "Efectivo"))).toEqual({
      ok: true,
      id: partial.id,
    });

    const vendor = await getWeddingVendor(supabase, access, vendorId);
    if (!vendor.ok) throw new Error(vendor.reason);
    const finance = vendorFinance(vendor.vendor, "2026-10-20");
    expect(finance.paidMinor).toBe(BigInt(200_000));
    expect(finance.unscheduledMinor).toBe(BigInt(0));
    expect(finance.remainingMinor).toBe(finance.scheduledRemainingMinor + finance.unscheduledMinor!);
    expect(vendor.vendor.payments.find((p) => p.id === partial.id)).toMatchObject({ scheduleItemId: null, note: "Efectivo" });
  });

  it("refuses invalid input before any request", async () => {
    const { supabase, requests } = await sessionClient("ownerA");
    const vendorId = "11111111-1111-4111-8111-111111111111";
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(0))).toEqual({ ok: false, reason: "invalid_input" });
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, { ...pay(1), paidOn: "2026-02-30" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(1, null, "dos\nlíneas"))).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(await payments.createScheduleItem(supabase, weddingA, vendorId, item(" ", 1))).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(requests).toEqual([]);
  });
});

// =========================================================== vendor guard

describe("vendor service financial guard", () => {
  it("maps currency lock, contract required, contract floor and delete protection", async () => {
    const vendorId = await newVendor("ownerA", weddingA, { contractedAmount: "6.000" });
    const { supabase } = await accessOf("collabA", weddingA);
    const deposit = await payments.createScheduleItem(supabase, weddingA, vendorId, item("Depósito", 300_000));
    if (!deposit.ok) throw new Error(deposit.reason);
    await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(100_000));

    expect(await updateWeddingVendor(supabase, weddingA, vendorId, vendorInput({ currency: "USD" }))).toEqual({
      ok: false,
      reason: "currency_locked",
    });
    expect(
      await updateWeddingVendor(supabase, weddingA, vendorId, vendorInput({ contractedAmount: "", quotedAmount: "1" })),
    ).toEqual({ ok: false, reason: "contract_required" });
    expect(await updateWeddingVendor(supabase, weddingA, vendorId, vendorInput({ contractedAmount: "3.999,99" }))).toEqual({
      ok: false,
      reason: "contract_below_recorded",
    });
    expect(await updateWeddingVendor(supabase, weddingA, vendorId, vendorInput({ contractedAmount: "4.000" }))).toEqual({
      ok: true,
      vendorId,
    });
    expect(await updateWeddingVendor(supabase, weddingA, vendorId, vendorInput({ contractedAmount: "8.000", status: "discarded" }))).toEqual({
      ok: true,
      vendorId,
    });
    expect(await deleteWeddingVendor(supabase, weddingA, vendorId)).toEqual({ ok: false, reason: "has_financial_records" });

    const clean = await newVendor("ownerA", weddingA);
    expect(await updateWeddingVendor(supabase, weddingA, clean, vendorInput({ currency: "USD" }))).toEqual({
      ok: true,
      vendorId: clean,
    });
    expect(await deleteWeddingVendor(supabase, weddingA, clean)).toEqual({ ok: true, vendorId: clean });
  });

  it("the vendor detail reads its schedule and payments in ONE vendor query", async () => {
    const vendorId = await newVendor("ownerA", weddingA);
    const { supabase, requests, access } = await accessOf("ownerA", weddingA);
    const created = await payments.createScheduleItem(supabase, weddingA, vendorId, item("Depósito", 1_000));
    if (!created.ok) throw new Error(created.reason);
    await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(500, created.id));
    await payments.recordVendorPayment(supabase, weddingA, vendorId, pay(250));
    requests.length = 0;
    const vendor = await getWeddingVendor(supabase, access, vendorId);
    expect(requests).toEqual(["GET /rest/v1/wedding_vendors"]);
    if (!vendor.ok) throw new Error(vendor.reason);
    expect(vendor.vendor.scheduleItems).toHaveLength(1);
    expect(vendor.vendor.payments).toHaveLength(2);
  });
});
