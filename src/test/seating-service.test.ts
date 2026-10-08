import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { parseTableCapacity, parseTableInput, parseTableName } from "@/lib/seating/validation";
import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const {
  createSeatingTable,
  deleteSeatingTable,
  getSeatingData,
  moveGuest,
  seatGuest,
  seatingFailure,
  unseatGuest,
  updateSeatingTable,
} = await import("@/lib/seating/service");

// Application-layer tests for LB-19 (ADR-012): a real supabase-js client
// against a fake HTTP backend, asserting exactly what is sent, what is read
// and how failures map to the closed reasons. The database invariants
// (capacity under a lock, declined guests, same-wedding FKs, RLS) are tested
// in tests/db/seating.test.ts.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const TABLE_ID = "44444444-4444-4444-8444-444444444444";
const GUEST_ID = "55555555-5555-4555-8555-555555555555";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  /** Reply to the one write (default: one affected row). */
  write?: Reply;
  get?: Record<string, Reply>;
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
    if (method === "GET" && url.pathname.startsWith("/rest/v1/")) {
      const reply = backend.get?.[url.pathname.slice("/rest/v1/".length)] ?? { status: 200, body: [] };
      return json(reply.body, reply.status);
    }
    if (url.pathname.startsWith("/rest/v1/seating_")) {
      const reply = backend.write ?? { status: 200, body: [{ id: TABLE_ID, guest_id: GUEST_ID }] };
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

const writes = (requests: Recorded[]) =>
  requests.filter((r) => r.method !== "GET" && r.url.pathname.startsWith("/rest/v1/seating_"));

const dbError = (code: string, message: string): Reply => ({ status: 400, body: { code, message, details: "raw detail" } });

// ---------------------------------------------------------------- mapping

describe("seatingFailure", () => {
  it.each([
    [{ code: "23514", message: "seating_table_full" }, "table_full"],
    [{ code: "23514", message: "seating_capacity_below_assigned" }, "capacity_below_assigned"],
    [{ code: "23514", message: "seating_guest_declined" }, "guest_declined"],
    [{ code: "23514", message: 'new row violates check constraint "seating_tables_name_valid"' }, "invalid_input"],
    [{ code: "23505", message: "duplicate key value violates unique constraint" }, "already_seated"],
    [{ code: "23503", message: "violates foreign key constraint" }, "invalid_target"],
    [{ code: "42501", message: "new row violates row-level security policy" }, "forbidden"],
    [{ code: "XX000", message: "boom" }, "database_error"],
    [{}, "database_error"],
  ] as const)("%j → %s", (error, reason) => {
    expect(seatingFailure(error)).toBe(reason);
  });
});

// ---------------------------------------------------------------- writes

describe("seating service writes", () => {
  it.each(["owner", "collaborator"] as const)("%s seats a guest scoped to the authorized wedding", async (role) => {
    const { supabase, requests } = clientFor({ role });
    await expect(seatGuest(supabase, WEDDING_ID, GUEST_ID, TABLE_ID)).resolves.toEqual({ ok: true });
    const [insert, ...rest] = writes(requests);
    expect(rest).toEqual([]);
    expect(insert?.method).toBe("POST");
    expect(insert?.url.pathname).toBe("/rest/v1/seating_assignments");
    expect(insert?.body).toEqual({ guest_id: GUEST_ID, wedding_id: WEDDING_ID, seating_table_id: TABLE_ID });
  });

  it.each([
    [dbError("23514", "seating_table_full"), "table_full"],
    [dbError("23514", "seating_guest_declined"), "guest_declined"],
    [dbError("23505", "duplicate key value violates unique constraint \"seating_assignments_pkey\""), "already_seated"],
    [dbError("23503", "violates foreign key constraint \"seating_assignments_table_same_wedding\""), "invalid_target"],
  ] as const)("seat failure %j maps to %s without raw details", async (reply, reason) => {
    const { supabase } = clientFor({ write: reply });
    const result = await seatGuest(supabase, WEDDING_ID, GUEST_ID, TABLE_ID);
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toMatch(/constraint|raw detail|seating_/);
  });

  it("moves by sending only the table, scoped to (wedding, guest)", async () => {
    const { supabase, requests } = clientFor();
    await expect(moveGuest(supabase, WEDDING_ID, GUEST_ID, TABLE_ID)).resolves.toEqual({ ok: true });
    const [patch] = writes(requests);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ seating_table_id: TABLE_ID });
    expect(patch?.url.searchParams.get("guest_id")).toBe(`eq.${GUEST_ID}`);
    expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("a move to a full table is table_full", async () => {
    const { supabase } = clientFor({ write: dbError("23514", "seating_table_full") });
    await expect(moveGuest(supabase, WEDDING_ID, GUEST_ID, TABLE_ID)).resolves.toEqual({ ok: false, reason: "table_full" });
  });

  it("zero affected rows (not in this wedding) is invalid_target", async () => {
    const { supabase } = clientFor({ write: { status: 200, body: [] } });
    await expect(unseatGuest(supabase, WEDDING_ID, GUEST_ID)).resolves.toEqual({ ok: false, reason: "invalid_target" });
    await expect(deleteSeatingTable(supabase, WEDDING_ID, TABLE_ID)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("unseat and delete are scoped to the authorized wedding", async () => {
    const { supabase, requests } = clientFor();
    await unseatGuest(supabase, WEDDING_ID, GUEST_ID);
    await deleteSeatingTable(supabase, WEDDING_ID, TABLE_ID);
    const [unseat, del] = writes(requests);
    expect(unseat?.method).toBe("DELETE");
    expect(unseat?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(del?.url.pathname).toBe("/rest/v1/seating_tables");
    expect(del?.url.searchParams.get("id")).toBe(`eq.${TABLE_ID}`);
    expect(del?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("creates a table with only wedding, trimmed name and capacity", async () => {
    const { supabase, requests } = clientFor();
    await expect(createSeatingTable(supabase, WEDDING_ID, { name: "  Mesa 1 ", capacity: 8 })).resolves.toEqual({
      ok: true,
    });
    expect(writes(requests).map((r) => r.body)).toEqual([{ wedding_id: WEDDING_ID, name: "Mesa 1", capacity: 8 }]);
  });

  it("a capacity below the people seated is capacity_below_assigned", async () => {
    const { supabase, requests } = clientFor({ write: dbError("23514", "seating_capacity_below_assigned") });
    await expect(updateSeatingTable(supabase, WEDDING_ID, TABLE_ID, { name: "Mesa", capacity: 2 })).resolves.toEqual({
      ok: false,
      reason: "capacity_below_assigned",
    });
    expect(writes(requests)[0]?.body).toEqual({ name: "Mesa", capacity: 2 });
  });

  it.each([
    { name: "", capacity: 4 },
    { name: "Mesa", capacity: 0 },
    { name: "Mesa", capacity: 51 },
    { name: "Mesa", capacity: 2.5 },
    { name: "a".repeat(81), capacity: 4 },
  ])("invalid input %j never reaches the database", async (input) => {
    const { supabase, requests } = clientFor();
    await expect(createSeatingTable(supabase, WEDDING_ID, input)).resolves.toEqual({ ok: false, reason: "invalid_input" });
    expect(writes(requests)).toEqual([]);
  });

  it.each(["not-a-uuid", `${GUEST_ID} `, "/rsvp/abc"])("a malformed id (%s) never reaches the database", async (id) => {
    const { supabase, requests } = clientFor();
    await expect(seatGuest(supabase, WEDDING_ID, id, TABLE_ID)).resolves.toEqual({ ok: false, reason: "invalid_target" });
    await expect(moveGuest(supabase, WEDDING_ID, GUEST_ID, id)).resolves.toEqual({ ok: false, reason: "invalid_target" });
    expect(writes(requests)).toEqual([]);
  });

  it("a non-member gets not_found and nothing is written", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(seatGuest(supabase, WEDDING_ID, GUEST_ID, TABLE_ID)).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(writes(requests)).toEqual([]);
  });
});

// ------------------------------------------------------------------ read

describe("getSeatingData", () => {
  const access = { userId: USER_ID, weddingId: WEDDING_ID, membershipId: MY_MEMBERSHIP, role: "owner" } as const;

  it("reads tables and the nested guest list in two queries, ordered", async () => {
    const { supabase, requests } = clientFor({
      get: {
        seating_tables: { status: 200, body: [{ id: TABLE_ID, name: "Mesa 1", capacity: 8 }] },
        guest_invitations: {
          status: 200,
          body: [
            {
              id: "p1",
              label: "Familia Pérez",
              created_at: "2026-10-01T00:00:00Z",
              guests: [
                { id: "g2", name: "Beto", created_at: "2026-10-01T00:00:02Z", rsvps: [], seating_assignments: [] },
                {
                  id: "g1",
                  name: "Ana",
                  created_at: "2026-10-01T00:00:01Z",
                  rsvps: [{ attending: false }],
                  seating_assignments: [{ seating_table_id: TABLE_ID }],
                },
              ],
            },
          ],
        },
      },
    });
    await expect(getSeatingData(supabase, access)).resolves.toEqual({
      tables: [{ id: TABLE_ID, name: "Mesa 1", capacity: 8 }],
      parties: [
        {
          id: "p1",
          label: "Familia Pérez",
          guests: [
            { id: "g1", name: "Ana", attending: false, tableId: TABLE_ID },
            { id: "g2", name: "Beto", attending: null, tableId: null },
          ],
        },
      ],
    });
    const reads = requests.filter((r) => r.method === "GET" && r.url.pathname.startsWith("/rest/v1/") && r.url.pathname !== "/rest/v1/wedding_memberships");
    expect(reads.map((r) => r.url.pathname)).toEqual(["/rest/v1/seating_tables", "/rest/v1/guest_invitations"]);
    expect(reads[0]?.url.searchParams.get("order")).toBe("sort_order.asc,created_at.asc,id.asc");
    for (const read of reads) expect(read.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    // Never contact emails, notes, link state or tokens.
    expect(reads[1]?.url.searchParams.get("select")).not.toMatch(/contact_email|dietary|token|revoked/);
  });

  it("returns null when a query fails", async () => {
    const { supabase } = clientFor({ get: { seating_tables: { status: 500, body: { message: "boom" } } } });
    await expect(getSeatingData(supabase, access)).resolves.toBeNull();
  });
});

// ------------------------------------------------------------- validation

describe("seating validation", () => {
  it("trims names and enforces 1–80 plain-text characters", () => {
    expect(parseTableName("  Mesa 1  ")).toEqual({ ok: true, value: "Mesa 1" });
    expect(parseTableName("   ").ok).toBe(false);
    expect(parseTableName("a".repeat(80)).ok).toBe(true);
    expect(parseTableName("a".repeat(81)).ok).toBe(false);
    expect(parseTableName("Mesa\u0000").ok).toBe(false);
  });

  it("accepts whole capacities 1–50 only", () => {
    expect(parseTableCapacity("1")).toEqual({ ok: true, value: 1 });
    expect(parseTableCapacity(" 50 ")).toEqual({ ok: true, value: 50 });
    for (const raw of ["", "0", "51", "-1", "2.5", "1e1", "+3", "abc", "0x10"]) {
      expect(parseTableCapacity(raw).ok, raw).toBe(false);
    }
  });

  it("reports each invalid field", () => {
    const result = parseTableInput({ name: "", capacity: "99" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(["capacity", "name"]);
  });
});
