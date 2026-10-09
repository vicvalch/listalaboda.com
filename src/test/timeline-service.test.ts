import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { TimelineInput } from "@/lib/timeline/validation";

vi.mock("server-only", () => ({}));

const {
  TIMELINE_VENDOR_COLUMNS,
  createTimelineEntry,
  deleteTimelineEntry,
  getTimelineData,
  timelineFailure,
  toTimelineVendor,
  updateTimelineEntry,
} = await import("@/lib/timeline/service");

// Application-layer tests for LB-23 (ADR-016): a real supabase-js client
// against a fake HTTP backend, asserting exactly what is sent, what is read
// and how failures map to the closed reasons. The database invariants (CHECKs,
// grants, member RLS, the same-wedding vendor FK) are tested in
// tests/db/wedding-timeline.test.ts.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";
const VENDOR_ID = "55555555-5555-4555-8555-555555555555";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  write?: Reply;
  entries?: Reply;
  wedding?: Reply;
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
    if (url.pathname === "/rest/v1/weddings") {
      const reply = backend.wedding ?? { status: 200, body: null };
      return json(reply.body, reply.status);
    }
    if (url.pathname === "/rest/v1/wedding_timeline_entries") {
      if (method === "GET") {
        const reply = backend.entries ?? { status: 200, body: [] };
        return json(reply.body, reply.status);
      }
      const reply = backend.write ?? { status: 200, body: [{ id: ENTRY_ID }] };
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

const timelineRequests = (requests: Recorded[]) =>
  requests.filter((r) => r.url.pathname === "/rest/v1/wedding_timeline_entries");
const writes = (requests: Recorded[]) => timelineRequests(requests).filter((r) => r.method !== "GET");
const dataReads = (requests: Recorded[]) =>
  requests.filter((r) => r.method === "GET" && ["/rest/v1/weddings", "/rest/v1/wedding_timeline_entries"].includes(r.url.pathname));

const dbError = (code: string, message: string): Reply => ({ status: 400, body: { code, message, details: "raw detail" } });

const access = { userId: USER_ID, weddingId: WEDDING_ID, membershipId: MY_MEMBERSHIP, role: "collaborator" } as const;

const INPUT: TimelineInput = {
  title: "Ceremonia",
  dayOffset: 0,
  startTime: "15:30",
  durationMinutes: 45,
  phase: "ceremony",
  location: "Jardín",
  responsibleName: "Coordinadora",
  weddingVendorId: VENDOR_ID,
  notes: "Línea 1\nLínea 2",
};

const COLUMNS = {
  title: "Ceremonia",
  day_offset: 0,
  start_time: "15:30",
  duration_minutes: 45,
  phase: "ceremony",
  location: "Jardín",
  responsible_name: "Coordinadora",
  wedding_vendor_id: VENDOR_ID,
  notes: "Línea 1\nLínea 2",
};

// ---------------------------------------------------------------- mapping

describe("timelineFailure", () => {
  it.each([
    [{ code: "23503", message: 'violates foreign key constraint "wedding_timeline_entries_vendor_same_wedding"' }, "invalid_vendor"],
    [{ code: "23514", message: 'violates check constraint "wedding_timeline_entries_end_within_window"' }, "invalid_input"],
    [{ code: "23502", message: "null value" }, "invalid_input"],
    [{ code: "22P02", message: "invalid input value for enum" }, "invalid_input"],
    [{ code: "22007", message: "invalid input syntax for type time" }, "invalid_input"],
    [{ code: "22008", message: "date/time field value out of range" }, "invalid_input"],
    [{ code: "42501", message: "new row violates row-level security policy" }, "forbidden"],
    [{ code: "XX000", message: "boom" }, "database_error"],
    [{}, "database_error"],
  ] as const)("%j → %s", (error, reason) => {
    expect(timelineFailure(error)).toBe(reason);
  });
});

// ---------------------------------------------------------------- writes

describe("timeline service writes", () => {
  it.each(["owner", "collaborator"] as const)("%s creates an entry scoped to the authorized wedding", async (role) => {
    const { supabase, requests } = clientFor({ role });
    await expect(createTimelineEntry(supabase, WEDDING_ID, INPUT)).resolves.toEqual({ ok: true, entryId: ENTRY_ID });
    const [insert, ...rest] = writes(requests);
    expect(rest).toEqual([]);
    expect(insert?.method).toBe("POST");
    // Only the editable columns plus the authorized wedding: no id, provenance, timestamps or status.
    expect(insert?.body).toEqual({ wedding_id: WEDDING_ID, ...COLUMNS });
  });

  it("updates every editable field in one write, scoped to (id, wedding), never the wedding itself", async () => {
    const { supabase, requests } = clientFor();
    const moved: TimelineInput = { ...INPUT, dayOffset: 1, startTime: "00:30", durationMinutes: null, weddingVendorId: null };
    await expect(updateTimelineEntry(supabase, WEDDING_ID, ENTRY_ID, moved)).resolves.toEqual({ ok: true, entryId: ENTRY_ID });
    const [patch, ...rest] = writes(requests);
    expect(rest).toEqual([]);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ ...COLUMNS, day_offset: 1, start_time: "00:30", duration_minutes: null, wedding_vendor_id: null });
    expect(patch?.url.searchParams.get("id")).toBe(`eq.${ENTRY_ID}`);
    expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("deletes scoped to (id, wedding)", async () => {
    const { supabase, requests } = clientFor();
    await expect(deleteTimelineEntry(supabase, WEDDING_ID, ENTRY_ID)).resolves.toEqual({ ok: true, entryId: ENTRY_ID });
    const [del] = writes(requests);
    expect(del?.method).toBe("DELETE");
    expect(del?.url.searchParams.get("id")).toBe(`eq.${ENTRY_ID}`);
    expect(del?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("zero affected rows (another wedding's entry, deleted, made up) is invalid_target", async () => {
    const { supabase } = clientFor({ write: { status: 200, body: [] } });
    await expect(updateTimelineEntry(supabase, WEDDING_ID, ENTRY_ID, INPUT)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
    await expect(deleteTimelineEntry(supabase, WEDDING_ID, ENTRY_ID)).resolves.toEqual({ ok: false, reason: "invalid_target" });
  });

  it("a malformed entry id never reaches the database", async () => {
    const { supabase, requests } = clientFor();
    for (const bad of ["nope", `${ENTRY_ID}x`, ""]) {
      await expect(updateTimelineEntry(supabase, WEDDING_ID, bad, INPUT)).resolves.toEqual({ ok: false, reason: "invalid_target" });
      await expect(deleteTimelineEntry(supabase, WEDDING_ID, bad)).resolves.toEqual({ ok: false, reason: "invalid_target" });
    }
    expect(writes(requests)).toEqual([]);
  });

  it("a foreign vendor (FK violation) is invalid_vendor; raw messages never leak", async () => {
    const { supabase } = clientFor({
      write: dbError("23503", 'insert or update on table "wedding_timeline_entries" violates foreign key constraint'),
    });
    const result = await createTimelineEntry(supabase, WEDDING_ID, INPUT);
    expect(result).toEqual({ ok: false, reason: "invalid_vendor" });
    expect(JSON.stringify(result)).not.toContain("foreign key");
  });

  it("non-members get not_found, signed-out users unauthenticated, before any write", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(createTimelineEntry(supabase, WEDDING_ID, INPUT)).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(createTimelineEntry(supabase, "not-a-wedding", INPUT)).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(writes(requests)).toEqual([]);
  });

  it.each([
    ["spill into day 2", { dayOffset: 1 as const, startTime: "23:30", durationMinutes: 31 }],
    ["seconds", { startTime: "15:30:00" }],
    ["day 2", { dayOffset: 2 as never }],
    ["malformed vendor", { weddingVendorId: "nope" }],
  ])("re-validates before writing: %s", async (_name, change) => {
    const { supabase, requests } = clientFor();
    await expect(createTimelineEntry(supabase, WEDDING_ID, { ...INPUT, ...change })).resolves.toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(requests).toEqual([]);
  });
});

// -------------------------------------------------------------------- read

const ENTRY_ROW = {
  id: ENTRY_ID,
  title: "Ceremonia",
  day_offset: 0,
  start_time: "15:30:00",
  duration_minutes: 45,
  phase: "ceremony",
  location: "Jardín",
  responsible_name: null,
  notes: null,
  created_at: "2026-10-09T12:00:00+00:00",
  wedding_vendors: {
    id: VENDOR_ID,
    name: "Banda Sol",
    category: "music" as const,
    custom_category: null,
    status: "booked" as const,
    contact_name: "Ana",
    phone: "8888-1234",
  },
};

describe("getTimelineData", () => {
  it("reads in exactly two data queries, with the approved vendor projection", async () => {
    const { supabase, requests } = clientFor({
      wedding: {
        status: 200,
        body: {
          id: WEDDING_ID,
          name: "Boda",
          wedding_date: "2027-08-14",
          time_zone: "America/Costa_Rica",
          wedding_vendors: [
            { id: "b", name: "Zeta", category: "music", custom_category: null, status: "booked" },
            { id: "a", name: "Árbol", category: "flowers_decor", custom_category: null, status: "considering" },
          ],
        },
      },
      entries: { status: 200, body: [ENTRY_ROW, { ...ENTRY_ROW, id: "e2", start_time: null, wedding_vendors: null }] },
    });
    const data = await getTimelineData(supabase, access);
    expect(data).toEqual({
      weddingId: WEDDING_ID,
      weddingName: "Boda",
      weddingDate: "2027-08-14",
      timeZone: "America/Costa_Rica",
      entries: [
        {
          id: ENTRY_ID,
          title: "Ceremonia",
          dayOffset: 0,
          startTime: "15:30",
          durationMinutes: 45,
          phase: "ceremony",
          location: "Jardín",
          responsibleName: null,
          notes: null,
          vendor: {
            id: VENDOR_ID,
            name: "Banda Sol",
            category: "music",
            customCategory: null,
            status: "booked",
            contactName: "Ana",
            phone: "8888-1234",
          },
          createdAt: "2026-10-09T12:00:00+00:00",
        },
        expect.objectContaining({ id: "e2", startTime: null, vendor: null }),
      ],
      vendorOptions: [
        { id: "a", name: "Árbol", category: "flowers_decor", customCategory: null, status: "considering" },
        { id: "b", name: "Zeta", category: "music", customCategory: null, status: "booked" },
      ],
    });

    const reads = dataReads(requests);
    expect(reads).toHaveLength(2);
    const entriesRead = reads.find((r) => r.url.pathname === "/rest/v1/wedding_timeline_entries")!;
    const weddingRead = reads.find((r) => r.url.pathname === "/rest/v1/weddings")!;
    expect(entriesRead.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(entriesRead.url.searchParams.get("order")).toBe(
      "day_offset.asc,start_time.asc.nullslast,created_at.asc,id.asc",
    );

    // The projection: identification and day-of contact, never email, social,
    // notes, money or payments; the picker reads even less.
    const entrySelect = entriesRead.url.searchParams.get("select")!;
    const weddingSelect = weddingRead.url.searchParams.get("select")!;
    for (const select of [entrySelect, weddingSelect]) {
      for (const forbidden of [
        "email",
        "instagram",
        "notes)",
        "currency",
        "quoted_amount",
        "contracted_amount",
        "vendor_payments",
        "schedule_items",
      ]) {
        expect(select, forbidden).not.toContain(forbidden);
      }
    }
    // Exactly the approved vendor columns are embedded, nothing more.
    const embedded = /wedding_vendors!wedding_timeline_entries_vendor_same_wedding\(([^)]*)\)/.exec(entrySelect)?.[1];
    expect(embedded?.split(",")).toEqual(["id", "name", "category", "custom_category", "status", "contact_name", "phone"]);
    const options = /wedding_vendors!wedding_vendors_wedding_id_fkey\(([^)]*)\)/.exec(weddingSelect)?.[1];
    expect(options?.split(",")).toEqual(["id", "name", "category", "custom_category", "status"]);
  });

  it("the timeline vendor shape carries only the approved fields, whatever the row holds", () => {
    const leaky = {
      ...ENTRY_ROW.wedding_vendors,
      email: "x@y.cr",
      instagram_handle: "x",
      notes: "secreta",
      currency: "USD",
      quoted_amount_minor: 1,
      contracted_amount_minor: 2,
      vendor_payments: [],
      vendor_payment_schedule_items: [],
    } as const;
    const vendor = toTimelineVendor(leaky);
    expect(Object.keys(vendor).sort()).toEqual(["category", "contactName", "customCategory", "id", "name", "phone", "status"]);
    expect(TIMELINE_VENDOR_COLUMNS.split(", ")).toEqual([
      "id",
      "name",
      "category",
      "custom_category",
      "status",
      "contact_name",
      "phone",
    ]);
  });

  it("returns null on any read failure or a drifted row", async () => {
    const wedding = { status: 200, body: { id: WEDDING_ID, name: "B", wedding_date: null, time_zone: null, wedding_vendors: [] } };
    expect(await getTimelineData(clientFor({ wedding, entries: dbError("XX000", "boom") }).supabase, access)).toBeNull();
    expect(await getTimelineData(clientFor({ entries: { status: 200, body: [] } }).supabase, access)).toBeNull();
    expect(
      await getTimelineData(clientFor({ wedding, entries: { status: 200, body: [{ ...ENTRY_ROW, day_offset: 2 }] } }).supabase, access),
    ).toBeNull();
  });
});
