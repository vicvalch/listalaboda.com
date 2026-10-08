import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { VendorInput } from "@/lib/vendors/validation";

vi.mock("server-only", () => ({}));

const {
  createWeddingVendor,
  deleteWeddingVendor,
  getWeddingVendor,
  listWeddingVendors,
  updateWeddingVendor,
  vendorFailure,
} = await import("@/lib/vendors/service");

// Application-layer tests for LB-21 (ADR-014): a real supabase-js client
// against a fake HTTP backend, asserting exactly what is sent, what is read
// and how failures map to the closed reasons. The database invariants (CHECKs,
// grants, member RLS) are tested in tests/db/wedding-vendors.test.ts.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const VENDOR_ID = "44444444-4444-4444-8444-444444444444";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  /** Reply to the one write (default: one affected row). */
  write?: Reply;
  /** Reply to a vendor read. */
  read?: Reply;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStorage(): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>([
    [
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    ],
  ]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function clientFor(backend: Backend = {}) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (url.pathname === "/auth/v1/user") return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    if (url.pathname === "/rest/v1/wedding_memberships") {
      const role = backend.role === undefined ? "collaborator" : backend.role;
      return json(role ? [{ id: MY_MEMBERSHIP, role }] : []);
    }
    if (url.pathname === "/rest/v1/wedding_vendors") {
      if (method === "GET") {
        const reply = backend.read ?? { status: 200, body: [] };
        return json(reply.body, reply.status);
      }
      const reply = backend.write ?? { status: 200, body: [{ id: VENDOR_ID }] };
      return json(reply.body, reply.status);
    }
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: { storage: memoryStorage(), storageKey: "test", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  return { supabase, requests };
}

const vendorRequests = (requests: Recorded[]) => requests.filter((r) => r.url.pathname === "/rest/v1/wedding_vendors");
const writes = (requests: Recorded[]) => vendorRequests(requests).filter((r) => r.method !== "GET");

const dbError = (code: string, message: string): Reply => ({ status: 400, body: { code, message, details: "raw detail" } });

const access = { userId: USER_ID, weddingId: WEDDING_ID, membershipId: MY_MEMBERSHIP, role: "collaborator" } as const;

const INPUT: VendorInput = {
  name: "Floristería Las Gardenias",
  category: "flowers_decor",
  customCategory: null,
  status: "quoted",
  contactName: "María José",
  email: "Ventas@gardenias.cr",
  phone: "+506 8888-1234",
  instagramHandle: "gardenias.cr",
  currency: "CRC",
  quotedAmountMinor: 120_000_000,
  contractedAmountMinor: null,
  notes: "Línea 1\nLínea 2",
};

const COLUMNS = {
  name: "Floristería Las Gardenias",
  category: "flowers_decor",
  custom_category: null,
  status: "quoted",
  contact_name: "María José",
  email: "Ventas@gardenias.cr",
  phone: "+506 8888-1234",
  instagram_handle: "gardenias.cr",
  currency: "CRC",
  quoted_amount_minor: 120_000_000,
  contracted_amount_minor: null,
  notes: "Línea 1\nLínea 2",
};

// ---------------------------------------------------------------- mapping

describe("vendorFailure", () => {
  it.each([
    [{ code: "23514", message: 'new row violates check constraint "wedding_vendors_name_valid"' }, "invalid_input"],
    [{ code: "23502", message: "null value" }, "invalid_input"],
    [{ code: "22P02", message: "invalid input value for enum" }, "invalid_input"],
    [{ code: "42501", message: "new row violates row-level security policy" }, "forbidden"],
    [{ code: "23505", message: "duplicate key" }, "database_error"],
    [{ code: "XX000", message: "boom" }, "database_error"],
    [{}, "database_error"],
  ] as const)("%j → %s", (error, reason) => {
    expect(vendorFailure(error)).toBe(reason);
  });
});

// ---------------------------------------------------------------- writes

describe("vendor service writes", () => {
  it.each(["owner", "collaborator"] as const)("%s creates a vendor scoped to the authorized wedding", async (role) => {
    const { supabase, requests } = clientFor({ role });
    await expect(createWeddingVendor(supabase, WEDDING_ID, INPUT)).resolves.toEqual({ ok: true, vendorId: VENDOR_ID });
    const [insert, ...rest] = writes(requests);
    expect(rest).toEqual([]);
    expect(insert?.method).toBe("POST");
    // Only the editable columns plus the authorized wedding: no id, provenance or timestamps.
    expect(insert?.body).toEqual({ wedding_id: WEDDING_ID, ...COLUMNS });
  });

  it("updates every editable field in one write, scoped to (id, wedding), never the wedding itself", async () => {
    const { supabase, requests } = clientFor();
    const booked: VendorInput = { ...INPUT, status: "booked", contractedAmountMinor: 110_000_000 };
    await expect(updateWeddingVendor(supabase, WEDDING_ID, VENDOR_ID, booked)).resolves.toEqual({
      ok: true,
      vendorId: VENDOR_ID,
    });
    const [patch, ...rest] = writes(requests);
    expect(rest).toEqual([]);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ ...COLUMNS, status: "booked", contracted_amount_minor: 110_000_000 });
    expect(patch?.url.searchParams.get("id")).toBe(`eq.${VENDOR_ID}`);
    expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("deletes scoped to (id, wedding)", async () => {
    const { supabase, requests } = clientFor();
    await expect(deleteWeddingVendor(supabase, WEDDING_ID, VENDOR_ID)).resolves.toEqual({ ok: true, vendorId: VENDOR_ID });
    const [del] = writes(requests);
    expect(del?.method).toBe("DELETE");
    expect(del?.url.searchParams.get("id")).toBe(`eq.${VENDOR_ID}`);
    expect(del?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("zero affected rows (another wedding's vendor, deleted, made up) is invalid_target", async () => {
    const { supabase } = clientFor({ write: { status: 200, body: [] } });
    await expect(updateWeddingVendor(supabase, WEDDING_ID, VENDOR_ID, INPUT)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
    await expect(deleteWeddingVendor(supabase, WEDDING_ID, VENDOR_ID)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it.each([
    [dbError("23514", 'new row violates check constraint "wedding_vendors_currency_iff_amount"'), "invalid_input"],
    [dbError("42501", "new row violates row-level security policy for table \"wedding_vendors\""), "forbidden"],
    [dbError("XX000", "internal"), "database_error"],
  ] as const)("write failure %j maps to %s without raw details", async (reply, reason) => {
    const { supabase } = clientFor({ write: reply });
    const result = await createWeddingVendor(supabase, WEDDING_ID, INPUT);
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toMatch(/constraint|raw detail|wedding_vendors|security/);
  });

  it.each<Partial<VendorInput>>([
    { name: "" },
    { name: "  padded " },
    { category: "other" },
    { customCategory: "Fotos" },
    { currency: null },
    { currency: "CRC", quotedAmountMinor: null },
    { currency: "EUR" as VendorInput["currency"] },
    { quotedAmountMinor: -1 },
    { quotedAmountMinor: 0.5 },
    { email: "Ventas@GARDENIAS.cr" },
    { instagramHandle: "@gardenias" },
    { instagramHandle: "https://instagram.com/x" },
    { phone: "call me" },
    { notes: "a\u0000b" },
  ])("invalid input %j never reaches the database", async (change) => {
    const { supabase, requests } = clientFor();
    await expect(createWeddingVendor(supabase, WEDDING_ID, { ...INPUT, ...change })).resolves.toEqual({
      ok: false,
      reason: "invalid_input",
    });
    await expect(updateWeddingVendor(supabase, WEDDING_ID, VENDOR_ID, { ...INPUT, ...change })).resolves.toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(vendorRequests(requests)).toEqual([]);
  });

  it.each(["not-a-uuid", `${VENDOR_ID} `, "../x"])("a malformed vendor id (%s) never reaches the database", async (id) => {
    const { supabase, requests } = clientFor();
    await expect(updateWeddingVendor(supabase, WEDDING_ID, id, INPUT)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
    await expect(deleteWeddingVendor(supabase, WEDDING_ID, id)).resolves.toEqual({ ok: false, reason: "invalid_target" });
    expect(vendorRequests(requests)).toEqual([]);
  });

  it("a non-member gets not_found and nothing is written", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(createWeddingVendor(supabase, WEDDING_ID, INPUT)).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(deleteWeddingVendor(supabase, WEDDING_ID, VENDOR_ID)).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(vendorRequests(requests)).toEqual([]);
  });
});

// ------------------------------------------------------------------ reads

const ROW = {
  id: VENDOR_ID,
  name: "Floristería Las Gardenias",
  category: "flowers_decor",
  custom_category: null,
  status: "quoted",
  contact_name: "María José",
  email: "Ventas@gardenias.cr",
  phone: "+506 8888-1234",
  instagram_handle: "gardenias.cr",
  currency: "CRC",
  quoted_amount_minor: 120_000_000,
  contracted_amount_minor: null,
  updated_at: "2026-10-08T10:00:00+00:00",
};

const ITEM = {
  id: VENDOR_ID,
  name: "Floristería Las Gardenias",
  category: "flowers_decor",
  customCategory: null,
  status: "quoted",
  contactName: "María José",
  email: "Ventas@gardenias.cr",
  phone: "+506 8888-1234",
  instagramHandle: "gardenias.cr",
  currency: "CRC",
  quotedAmountMinor: 120_000_000,
  contractedAmountMinor: null,
  updatedAt: "2026-10-08T10:00:00+00:00",
};

describe("listWeddingVendors", () => {
  it("reads the wedding's vendors in ONE query, without notes", async () => {
    const { supabase, requests } = clientFor({ read: { status: 200, body: [ROW] } });
    await expect(listWeddingVendors(supabase, access)).resolves.toEqual([ITEM]);
    const reads = vendorRequests(requests);
    expect(reads).toHaveLength(1);
    const select = reads[0]!.url.searchParams.get("select") ?? "";
    expect(select.split(",").map((c) => c.trim()).sort()).toEqual(
      [
        "id",
        "name",
        "category",
        "custom_category",
        "status",
        "contact_name",
        "email",
        "phone",
        "instagram_handle",
        "currency",
        "quoted_amount_minor",
        "contracted_amount_minor",
        "updated_at",
      ].sort(),
    );
    expect(select).not.toContain("notes");
    expect(select).not.toContain("created_by");
    expect(reads[0]!.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("returns null on a database error", async () => {
    const { supabase } = clientFor({ read: dbError("XX000", "boom") });
    await expect(listWeddingVendors(supabase, access)).resolves.toBeNull();
  });
});

describe("getWeddingVendor", () => {
  it("reads one vendor with its notes in ONE query scoped by (id, wedding)", async () => {
    const { supabase, requests } = clientFor({ read: { status: 200, body: { ...ROW, notes: "Hola\nmundo" } } });
    await expect(getWeddingVendor(supabase, access, VENDOR_ID)).resolves.toEqual({
      ok: true,
      vendor: { ...ITEM, notes: "Hola\nmundo" },
    });
    const reads = vendorRequests(requests);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.url.searchParams.get("select")).toContain("notes");
    expect(reads[0]!.url.searchParams.get("id")).toBe(`eq.${VENDOR_ID}`);
    expect(reads[0]!.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("another wedding's (or a missing) vendor is not_found, never data", async () => {
    const { supabase } = clientFor({ read: { status: 200, body: null } });
    await expect(getWeddingVendor(supabase, access, VENDOR_ID)).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("a malformed id is not_found without a query", async () => {
    const { supabase, requests } = clientFor();
    await expect(getWeddingVendor(supabase, access, "nope")).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(vendorRequests(requests)).toEqual([]);
  });

  it("a database error is database_error, not not_found", async () => {
    const { supabase } = clientFor({ read: dbError("XX000", "boom") });
    await expect(getWeddingVendor(supabase, access, VENDOR_ID)).resolves.toEqual({ ok: false, reason: "database_error" });
  });
});
