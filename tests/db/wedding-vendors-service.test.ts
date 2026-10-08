import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { VendorInput } from "@/lib/vendors/validation";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { createWeddingVendor, deleteWeddingVendor, getWeddingVendor, listWeddingVendors, updateWeddingVendor } =
  await import("@/lib/vendors/service");
const { parseVendorInput } = await import("@/lib/vendors/validation");
const { summarizeVendors } = await import("@/lib/vendors/summary");

// LB-21 services (what the Server Actions and pages call) against the real
// local stack: identity from the real Auth server, authority from real
// memberships, RLS and the CHECKs underneath.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

async function sessionClient(user: TestUserKey) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return supabase;
}

async function accessOf(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  return { supabase, access: access.access };
}

function input(overrides: Record<string, string>): VendorInput {
  const result = parseVendorInput({
    name: "Floristería Las Gardenias",
    category: "flowers_decor",
    customCategory: "",
    status: "quoted",
    contactName: "María José",
    email: "Ventas@Gardenias.CR",
    phone: "+506 8888-1234",
    instagramHandle: "@gardenias.cr",
    currency: "CRC",
    quotedAmount: "1.200.000",
    contractedAmount: "",
    notes: "Llamar el lunes.\nPedir muestras.",
    ...overrides,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.fieldErrors));
  return result.input;
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Servicio Proveedores A");
  weddingB = await fixtureWedding("ownerB", "Boda Servicio Proveedores B");
  await addMember(weddingA, "collabA", "collaborator");
});

describe("vendor service", () => {
  it("creates, lists, reads, updates and deletes for owners and collaborators", async () => {
    for (const user of ["ownerA", "collabA"] as const) {
      const { supabase, access } = await accessOf(user, weddingA);
      const created = await createWeddingVendor(supabase, weddingA, input({ name: `Flores de ${user}` }));
      if (!created.ok) throw new Error(created.reason);

      const list = await listWeddingVendors(supabase, access);
      const item = list?.find((v) => v.id === created.vendorId);
      expect(item).toMatchObject({
        name: `Flores de ${user}`,
        email: "Ventas@gardenias.cr",
        instagramHandle: "gardenias.cr",
        currency: "CRC",
        quotedAmountMinor: 120_000_000,
        contractedAmountMinor: null,
      });
      // The list never carries notes.
      expect(item).not.toHaveProperty("notes");

      const detail = await getWeddingVendor(supabase, access, created.vendorId);
      expect(detail).toMatchObject({ ok: true, vendor: { notes: "Llamar el lunes.\nPedir muestras." } });

      const updated = await updateWeddingVendor(
        supabase,
        weddingA,
        created.vendorId,
        input({ name: `Flores de ${user}`, status: "booked", contractedAmount: "1.100.000", email: "otra@flores.cr" }),
      );
      expect(updated).toEqual({ ok: true, vendorId: created.vendorId });
      expect(await getWeddingVendor(supabase, access, created.vendorId)).toMatchObject({
        ok: true,
        vendor: { status: "booked", contractedAmountMinor: 110_000_000, email: "otra@flores.cr" },
      });

      expect(await deleteWeddingVendor(supabase, weddingA, created.vendorId)).toEqual({
        ok: true,
        vendorId: created.vendorId,
      });
      expect(await getWeddingVendor(supabase, access, created.vendorId)).toEqual({ ok: false, reason: "not_found" });
    }
  });

  it("a known vendor of another wedding: not_found to read, invalid_target to write, untouched", async () => {
    const owner = await accessOf("ownerB", weddingB);
    const foreign = await createWeddingVendor(owner.supabase, weddingB, input({ name: "Proveedor ajeno" }));
    if (!foreign.ok) throw new Error(foreign.reason);

    const { supabase, access } = await accessOf("ownerA", weddingA);
    expect(await getWeddingVendor(supabase, access, foreign.vendorId)).toEqual({ ok: false, reason: "not_found" });
    expect(await updateWeddingVendor(supabase, weddingA, foreign.vendorId, input({ name: "Robado" }))).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await deleteWeddingVendor(supabase, weddingA, foreign.vendorId)).toEqual({ ok: false, reason: "invalid_target" });
    // Naming wedding B directly: not a member → not_found.
    expect(await updateWeddingVendor(supabase, weddingB, foreign.vendorId, input({ name: "Robado" }))).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await deleteWeddingVendor(supabase, weddingB, foreign.vendorId)).toEqual({ ok: false, reason: "not_found" });
    expect(await createWeddingVendor(supabase, weddingB, input({ name: "Plantado" }))).toEqual({
      ok: false,
      reason: "not_found",
    });

    const [row] = await sql<{ name: string; wedding_id: string }>(
      "select name, wedding_id from public.wedding_vendors where id = $1",
      [foreign.vendorId],
    );
    expect(row).toEqual({ name: "Proveedor ajeno", wedding_id: weddingB });
  });

  it("a malformed vendor id is not_found / invalid_target", async () => {
    const { supabase, access } = await accessOf("ownerA", weddingA);
    expect(await getWeddingVendor(supabase, access, "nope")).toEqual({ ok: false, reason: "not_found" });
    expect(await deleteWeddingVendor(supabase, weddingA, "nope")).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("an outsider gets not_found for every operation", async () => {
    const supabase = await sessionClient("outsider");
    expect(await createWeddingVendor(supabase, weddingA, input({}))).toEqual({ ok: false, reason: "not_found" });
    expect(await requireWeddingMembership(supabase, weddingA)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a database CHECK refusal maps to invalid_input without raw errors", async () => {
    const { supabase } = await accessOf("ownerA", weddingA);
    // Bypass the parser on purpose: the service re-validates, so this never
    // reaches the database either.
    const bad = { ...input({}), currency: null };
    expect(await createWeddingVendor(supabase, weddingA, bad)).toEqual({ ok: false, reason: "invalid_input" });
    expect(await sql("select 1 from public.wedding_vendors where wedding_id = $1 and currency is null and quoted_amount_minor is not null", [weddingA])).toEqual([]);
  });

  it("lists 50 vendors in one query and keeps CRC and USD totals separate", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda con 50 proveedores");
    const { supabase, access } = await accessOf("ownerA", wedding);
    const categories = ["venue", "catering", "photography", "music", "flowers_decor"];
    for (let i = 0; i < 50; i += 1) {
      const result = await createWeddingVendor(
        supabase,
        wedding,
        input({
          name: `Proveedor ${String(i).padStart(2, "0")}`,
          category: categories[i % categories.length]!,
          status: i % 2 === 0 ? "booked" : "quoted",
          currency: i % 4 < 2 ? "CRC" : "USD",
          quotedAmount: "1000",
          contractedAmount: i % 2 === 0 ? "100" : "",
        }),
      );
      if (!result.ok) throw new Error(result.reason);
    }

    const list = await listWeddingVendors(supabase, access);
    expect(list).toHaveLength(50);
    const summary = summarizeVendors(list!);
    expect(summary.byStatus.booked).toBe(25);
    // Booked = even i: i % 4 === 0 → CRC (13), i % 4 === 2 → USD (12); 100.00 each.
    expect(summary.contractedTotals).toEqual([
      { currency: "CRC", totalMinor: BigInt(13 * 10_000) },
      { currency: "USD", totalMinor: BigInt(12 * 10_000) },
    ]);
  });
});
