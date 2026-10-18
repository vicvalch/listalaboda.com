import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { OVERVIEW_SELECT, OVERVIEW_WEDDING_LIMIT, loadWeddingsOverview } = await import(
  "@/lib/weddings/overview/service"
);

// LB-24B (ADR-018) application layer: a real supabase-js client against a
// fake PostgREST, asserting what is requested (how many, for which ids,
// which columns) and how failures, missing rows and truncation map to
// `unavailable`. Real RLS and real max_rows behavior: tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-10T18:00:00Z");
const ACCESS_TOKEN = "test-access-token";

const weddingId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff";

type Domain = "checklist" | "guests" | "budget" | "timeline";

type Recorded = Readonly<{
  method: string;
  path: string;
  select: string | null;
  filters: Readonly<Record<string, string>>;
  authorization: string | null;
}>;

type Backend = Partial<{
  weddings: number;
  membershipStatus: number;
  userMetadata: Record<string, unknown>;
  /** A domain answers 500 / throws (network) / omits a wedding / adds a foreign row. */
  fail: Partial<Record<Domain | "parties", "status" | "throw">>;
  omit: Partial<Record<Domain, string>>;
  foreignRow: boolean;
  /** Override one wedding's row for a domain. */
  rows: Partial<Record<Domain, Record<string, unknown>>>;
  partyCount: number;
  /** Hold every domain response until all five domain requests arrived. */
  gate: boolean;
}>;

function memoryStorage(userMetadata: Record<string, unknown>): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>([
    [
      "test",
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated", user_metadata: userMetadata, app_metadata: userMetadata },
      }),
    ],
  ]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function domainOf(select: string): Domain {
  if (select.includes("checklist_items(")) return "checklist";
  if (select.includes("guest_invitations(")) return "guests";
  if (select.includes("wedding_vendors")) return "budget";
  return "timeline";
}

function emptyRow(domain: Domain, id: string): Record<string, unknown> {
  switch (domain) {
    case "checklist":
      return { id, checklist_items: [], checklist_item_count: [{ count: 0 }] };
    case "guests":
      return { id, guest_invitations: [] };
    case "budget":
      return {
        id,
        wedding_budget_totals: [],
        wedding_budget_allocations: [],
        wedding_vendors: [],
        vendor_count: [{ count: 0 }],
      };
    case "timeline":
      return { id, wedding_timeline_entries: [], timeline_entry_count: [{ count: 0 }] };
  }
}

function inList(value: string | undefined): string[] {
  const match = /^in\.\((.*)\)$/.exec(value ?? "");
  return match ? match[1].split(",").filter(Boolean) : [];
}

function setup(backend: Backend = {}) {
  const requests: Recorded[] = [];
  const count = backend.weddings ?? 2;
  const memberships = Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "owner" : "collaborator",
    weddings: {
      id: weddingId(i + 1),
      name: `Boda ${i + 1}`,
      wedding_date: "2026-12-12",
      city: null,
      time_zone: "America/Costa_Rica",
    },
  }));

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let domainRequests = 0;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const filters = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "select"));
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      select: url.searchParams.get("select"),
      filters,
      authorization: headers.get("Authorization"),
    });

    if (url.pathname === "/rest/v1/wedding_memberships") {
      return backend.membershipStatus ? json({ message: "boom" }, backend.membershipStatus) : json(memberships);
    }

    domainRequests += 1;
    if (backend.gate) {
      if (domainRequests === 5) release();
      await Promise.race([gate, new Promise((_, reject) => setTimeout(() => reject(new Error("waterfall")), 500))]);
    }

    if (url.pathname === "/rest/v1/guest_invitations") {
      if (backend.fail?.parties === "throw") throw new TypeError("network down");
      if (backend.fail?.parties === "status") return json({ message: "boom" }, 500);
      const total = backend.partyCount ?? 0;
      return new Response(null, { status: 200, headers: { "content-range": `*/${total}` } });
    }

    if (url.pathname === "/rest/v1/weddings") {
      const domain = domainOf(url.searchParams.get("select") ?? "");
      if (backend.fail?.[domain] === "throw") throw new TypeError("network down");
      if (backend.fail?.[domain] === "status") return json({ message: "boom" }, 500);
      const ids = inList(filters.id).filter((id) => id !== backend.omit?.[domain]);
      const rows = ids.map((id) => ({ ...emptyRow(domain, id), ...(backend.rows?.[domain]?.[id] ?? {}) }));
      if (backend.foreignRow) {
        rows.push({ ...emptyRow(domain, FOREIGN), checklist_items: [{ status: "pending", timing_mode: "absolute", relative_days: null, due_date: "2020-01-01" }], checklist_item_count: [{ count: 1 }] });
      }
      return json(rows);
    }
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(backend.userMetadata ?? {}),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests, ids: memberships.map((m) => m.weddings.id) };
}

const load = (backend: Backend = {}) => {
  const env = setup(backend);
  return loadWeddingsOverview(env.supabase, USER_ID, NOW).then((result) => ({ ...env, result }));
};

function ready<T extends { status: string }>(result: T): Extract<T, { status: "ready" }> {
  if (result.status !== "ready") throw new Error(`expected ready, got ${result.status}`);
  return result as Extract<T, { status: "ready" }>;
}

// ---------------------------------------------------------- query shape

describe("fixed query count, independent of the number of weddings", () => {
  it.each([1, 10, 50])("%i weddings → exactly 6 requests, all reads", async (n) => {
    const { requests, result } = await load({ weddings: n });
    expect(ready(result).weddings).toHaveLength(n);
    expect(requests).toHaveLength(6);
    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "GET /rest/v1/wedding_memberships",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "HEAD /rest/v1/guest_invitations",
      ].sort(),
    );
    // No RPC, no write of any kind: attention is never persisted.
    expect(requests.some((r) => r.path.startsWith("/rest/v1/rpc"))).toBe(false);
  });

  it("the memberships read comes first; every other read filters by exactly the authorized ids", async () => {
    const { requests, ids } = await load({ weddings: 10 });
    expect(requests[0]).toMatchObject({ path: "/rest/v1/wedding_memberships", filters: { user_id: `eq.${USER_ID}` } });
    for (const request of requests.slice(1)) {
      const key = request.path === "/rest/v1/guest_invitations" ? "wedding_id" : "id";
      expect(Object.keys(request.filters)).toEqual([key]);
      expect(inList(request.filters[key]).sort()).toEqual([...ids].sort());
    }
    expect(requests.filter((r) => r.path === "/rest/v1/weddings").map((r) => domainOf(r.select ?? "")).sort()).toEqual(
      ["budget", "checklist", "guests", "timeline"],
    );
  });

  it("the four domain reads and the party count run in parallel, not as a waterfall", async () => {
    const { result } = await load({ weddings: 3, gate: true });
    expect(ready(result).complete).toBe(true);
  });

  it("every request carries the caller's own session (never another key)", async () => {
    const { requests } = await load({ weddings: 3 });
    expect(requests.every((r) => r.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it("planner, persona or subscription metadata changes neither the requests nor the result", async () => {
    const plain = await load({ weddings: 4 });
    const planner = await load({
      weddings: 4,
      userMetadata: { planner: true, persona: "planner", account_type: "planner", subscription: "pro", entitlements: ["overview"] },
    });
    expect(planner.requests).toEqual(plain.requests);
    expect(planner.result).toEqual(plain.result);
  });
});

describe("the 100-wedding limit", () => {
  it("0 weddings: only the memberships read, an empty complete overview", async () => {
    const { requests, result } = await load({ weddings: 0 });
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      status: "ready",
      weddings: [],
      attention: [],
      weddingsNeedingAttention: 0,
      unavailableDomains: [],
      complete: true,
      allClear: true,
    });
  });

  it.each([1, 50, 100])("%i weddings are summarized, every one of them", async (n) => {
    const { requests, result, ids } = await load({ weddings: n });
    expect(ready(result).weddings.map((w) => w.wedding.id).sort()).toEqual([...ids].sort());
    expect(requests).toHaveLength(6);
  });

  it("101 weddings → over_limit, nothing summarized, no domain read", async () => {
    expect(OVERVIEW_WEDDING_LIMIT).toBe(100);
    const { requests, result } = await load({ weddings: 101 });
    expect(result).toEqual({ status: "over_limit", weddingCount: 101, limit: 100 });
    expect(requests).toHaveLength(1);
  });

  it("a failed memberships read is an error, never an empty overview", async () => {
    const { requests, result } = await load({ membershipStatus: 500 });
    expect(result).toEqual({ status: "error" });
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------- privacy

describe("minimal projections", () => {
  /** Whole column names (allocations ≠ location), anywhere in any domain read. */
  const FORBIDDEN = [
    "label",
    "contact_email",
    "token_hash",
    "dietary_note",
    "email",
    "phone",
    "instagram_handle",
    "contact_name",
    "notes",
    "note",
    "quoted_amount_minor",
    "location",
    "responsible_name",
    "created_by",
  ];

  it("the exact select strings", () => {
    expect(OVERVIEW_SELECT).toEqual({
      checklist:
        "id, checklist_items(status, timing_mode, relative_days, due_date, source_template_item_id, created_at), checklist_item_count:checklist_items(count)",
      guests:
        "id, guest_invitations(id, guests(id, rsvps(attending), seating_assignments(seating_table_id)), guest_count:guests(count))",
      budget:
        "id, wedding_budget_totals(currency, amount_minor), wedding_budget_allocations(category, currency, amount_minor), wedding_vendors!wedding_vendors_wedding_id_fkey(id, name, category, custom_category, status, currency, contracted_amount_minor, vendor_payment_schedule_items!vendor_payment_schedule_items_vendor_same_wedding(id, amount_minor, due_on), item_count:vendor_payment_schedule_items!vendor_payment_schedule_items_vendor_same_wedding(count), vendor_payments!vendor_payments_vendor_same_wedding(id, amount_minor, paid_on, schedule_item_id), payment_count:vendor_payments!vendor_payments_vendor_same_wedding(count)), vendor_count:wedding_vendors!wedding_vendors_wedding_id_fkey(count)",
      timeline:
        "id, wedding_timeline_entries(id, title, day_offset, start_time, duration_minutes, phase, wedding_vendor_id, created_at), timeline_entry_count:wedding_timeline_entries(count)",
    });
  });

  it("no request asks for contact data, tokens, notes, labels or quotes", async () => {
    const { requests } = await load({ weddings: 2 });
    for (const request of requests.slice(1)) {
      const columns = (request.select ?? "").split(/[^a-z_]+/);
      for (const column of FORBIDDEN) expect(columns).not.toContain(column);
    }
    // Guests: no names (parties' labels included); ids, RSVP answer and seat only.
    const guests = requests.find((r) => r.select?.includes("guest_invitations("))?.select ?? "";
    expect(guests.split(/[^a-z_]+/)).not.toContain("name");
  });
});

// ------------------------------------------------------- failure model

describe("failures are unavailable, never zero", () => {
  it.each([
    ["checklist", "status"],
    ["checklist", "throw"],
    ["guests", "status"],
    ["guests", "throw"],
    ["budget", "status"],
    ["budget", "throw"],
    ["timeline", "status"],
    ["timeline", "throw"],
  ] as const)("%s read fails (%s) → that domain unavailable for every wedding", { timeout: 60_000 }, async (domain, how) => {
    const { result } = await load({ weddings: 3, fail: { [domain]: how } });
    const overview = ready(result);
    expect(overview.complete).toBe(false);
    expect(overview.allClear).toBe(false);
    expect(overview.unavailableDomains).toEqual([domain]);
    for (const wedding of overview.weddings) {
      expect(wedding.unavailableDomains).toEqual([domain]);
      expect(wedding[domain]).toEqual({ status: "unavailable" });
      if (domain === "budget") expect(wedding.vendors).toEqual({ status: "unavailable" });
    }
  });

  it.each(["status", "throw"] as const)("the party count fails (%s) → guests unavailable", { timeout: 60_000 }, async (how) => {
    const { result } = await load({ weddings: 2, fail: { parties: how } });
    expect(ready(result).unavailableDomains).toEqual(["guests"]);
  });

  it.each(["checklist", "guests", "budget", "timeline"] as const)(
    "a wedding missing from the %s response is unavailable there (not empty)",
    async (domain) => {
      const env = setup({ weddings: 3 });
      const missing = env.ids[1];
      const { result } = await load({ weddings: 3, omit: { [domain]: missing } });
      const overview = ready(result);
      const by = (id: string) => overview.weddings.find((w) => w.wedding.id === id);
      expect(by(missing)?.unavailableDomains).toEqual([domain]);
      expect(by(env.ids[0])?.unavailableDomains).toEqual([]);
      expect(overview.allClear).toBe(false);
    },
  );

  it("a row for a wedding that isn't the caller's is ignored", async () => {
    const { result } = await load({ weddings: 2, foreignRow: true });
    const overview = ready(result);
    expect(overview.weddings.map((w) => w.wedding.id)).not.toContain(FOREIGN);
    expect(overview.attention.some((a) => a.weddingId === FOREIGN)).toBe(false);
    expect(overview.allClear).toBe(true);
  });
});

describe("truncation (child arrays shorter than their exact count)", () => {
  const items = (n: number) =>
    Array.from({ length: n }, () => ({ status: "pending", timing_mode: "absolute", relative_days: null, due_date: "2020-01-01" }));

  it("a checklist array shorter than its count → unavailable for that wedding only (no partial overdue count)", async () => {
    const env = setup({ weddings: 2 });
    const [a, b] = env.ids;
    const { result } = await load({
      weddings: 2,
      rows: {
        checklist: {
          [a]: { checklist_items: items(1000), checklist_item_count: [{ count: 1500 }] },
          [b]: { checklist_items: items(3), checklist_item_count: [{ count: 3 }] },
        },
      },
    });
    const overview = ready(result);
    const [wa, wb] = overview.weddings;
    expect(wa.checklist).toEqual({ status: "unavailable" });
    expect(wa.attention.map((i) => i.kind)).toEqual([]);
    expect(wb.checklist).toMatchObject({ status: "ok", value: { overdueCount: 3 } });
    expect(overview.unavailableDomains).toEqual(["checklist"]);
  });

  it("vendors, or one vendor's items or payments, short of their counts → budget unavailable", async () => {
    const env = setup({ weddings: 3 });
    const [a, b, c] = env.ids;
    const vendor = (over: Record<string, unknown>) => ({
      id: "v",
      name: "Foto",
      category: "photography",
      custom_category: null,
      status: "booked",
      currency: "CRC",
      contracted_amount_minor: 10,
      vendor_payment_schedule_items: [],
      item_count: [{ count: 0 }],
      vendor_payments: [],
      payment_count: [{ count: 0 }],
      ...over,
    });
    const { result } = await load({
      weddings: 3,
      rows: {
        budget: {
          [a]: { wedding_vendors: [vendor({})], vendor_count: [{ count: 2 }] },
          [b]: { wedding_vendors: [vendor({ item_count: [{ count: 1 }] })], vendor_count: [{ count: 1 }] },
          [c]: { wedding_vendors: [vendor({ payment_count: [{ count: 9 }] })], vendor_count: [{ count: 1 }] },
        },
      },
    });
    for (const wedding of ready(result).weddings) {
      expect(wedding.unavailableDomains).toEqual(["budget"]);
      expect(wedding.vendors).toEqual({ status: "unavailable" });
    }
  });

  it("a party's guests short of their count → guests unavailable for that wedding", async () => {
    const env = setup({ weddings: 2 });
    const [a] = env.ids;
    const party = { id: "p", guests: [{ id: "g", rsvps: [], seating_assignments: [] }], guest_count: [{ count: 2 }] };
    const { result } = await load({ weddings: 2, partyCount: 1, rows: { guests: { [a]: { guest_invitations: [party] } } } });
    const [wa, wb] = ready(result).weddings;
    expect(wa.unavailableDomains).toEqual(["guests"]);
    expect(wb.unavailableDomains).toEqual([]);
  });

  it("fewer parties than the exact party count → guests unavailable for every wedding", async () => {
    const env = setup({ weddings: 2 });
    const [a] = env.ids;
    const party = { id: "p", guests: [], guest_count: [{ count: 0 }] };
    const { result } = await load({ weddings: 2, partyCount: 2, rows: { guests: { [a]: { guest_invitations: [party] } } } });
    for (const wedding of ready(result).weddings) expect(wedding.unavailableDomains).toEqual(["guests"]);
  });

  it("complete arrays are summarized exactly (guests, seating, timeline)", async () => {
    const env = setup({ weddings: 1 });
    const [a] = env.ids;
    const guests = [
      { id: "g1", rsvps: [{ attending: false }], seating_assignments: [{ seating_table_id: "t" }] },
      { id: "g2", rsvps: [{ attending: true }], seating_assignments: [] },
      { id: "g3", rsvps: [], seating_assignments: [] },
    ];
    const { result } = await load({
      weddings: 1,
      partyCount: 1,
      rows: {
        guests: { [a]: { guest_invitations: [{ id: "p", guests, guest_count: [{ count: 3 }] }] } },
        timeline: {
          [a]: {
            wedding_timeline_entries: [
              { id: "e1", title: "Ceremonia", day_offset: 0, start_time: "16:00:00", duration_minutes: 45, phase: "ceremony", wedding_vendor_id: null, created_at: "2026-01-01T00:00:00Z" },
              { id: "e2", title: "Fotos", day_offset: 0, start_time: null, duration_minutes: null, phase: null, wedding_vendor_id: "v", created_at: "2026-01-01T00:00:01Z" },
            ],
            timeline_entry_count: [{ count: 2 }],
          },
        },
      },
    });
    const [wedding] = ready(result).weddings;
    expect(wedding.guests).toEqual({
      status: "ok",
      value: {
        guests: { parties: 1, total: 3, responded: 2, attending: 1, notAttending: 1, pending: 1 },
        seating: { confirmed: 1, seated: 1, confirmedUnseated: 1, seatedDeclined: 1 },
      },
    });
    expect(wedding.timeline).toEqual({
      status: "ok",
      value: { entryCount: 2, timedCount: 1, untimedCount: 1, now: null },
    });
    expect(wedding.attention.map((i) => i.kind)).toEqual(["seated_declined"]);
  });

  it("a drifted timeline row fails closed (timeline unavailable), like the timeline page", async () => {
    const env = setup({ weddings: 1 });
    const [a] = env.ids;
    const { result } = await load({
      weddings: 1,
      rows: {
        timeline: {
          [a]: {
            wedding_timeline_entries: [
              { id: "e1", title: "X", day_offset: 2, start_time: "16:00:00", duration_minutes: null, phase: null, wedding_vendor_id: null, created_at: "2026-01-01T00:00:00Z" },
            ],
            timeline_entry_count: [{ count: 1 }],
          },
        },
      },
    });
    expect(ready(result).weddings[0].unavailableDomains).toEqual(["timeline"]);
  });
});
