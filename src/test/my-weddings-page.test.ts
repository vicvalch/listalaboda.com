import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { loadMyWeddingsPage } = await import("@/lib/weddings/my-weddings-page");
const { loadSwitcherWeddings } = await import("@/lib/weddings/switcher");
const { OVERVIEW_WEDDING_LIMIT } = await import("@/lib/weddings/overview/service");

// LB-24C (ADR-017 §7, ADR-018 §12): what `/app` and the wedding switcher
// request. A real supabase-js client against a fake PostgREST: every request
// is counted, so "the overview ran" is visible as its 6 requests.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-10T18:00:00Z");

const weddingId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function memoryStorage(userMetadata: Record<string, unknown>): SupportedStorage {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function emptyRow(select: string, id: string): Record<string, unknown> {
  if (select.includes("checklist_items(")) return { id, checklist_items: [], checklist_item_count: [{ count: 0 }] };
  if (select.includes("guest_invitations(")) return { id, guest_invitations: [] };
  if (select.includes("wedding_vendors")) {
    return { id, wedding_budget_totals: [], wedding_budget_allocations: [], wedding_vendors: [], vendor_count: [{ count: 0 }] };
  }
  return { id, wedding_timeline_entries: [], timeline_entry_count: [{ count: 0 }] };
}

type Backend = Readonly<{
  weddings: number;
  /** Membership reads that fail, by 1-based call number. */
  failMembershipCalls?: readonly number[];
  userMetadata?: Record<string, unknown>;
}>;

function setup(backend: Backend) {
  const requests: string[] = [];
  let membershipCalls = 0;
  const memberships = Array.from({ length: backend.weddings }, (_, i) => ({
    role: i % 2 === 0 ? "owner" : "collaborator",
    weddings: {
      id: weddingId(i + 1),
      name: `Boda ${i + 1}`,
      wedding_date: i % 3 === 0 ? null : "2026-12-12",
      city: i % 2 === 0 ? "Escazú" : null,
      time_zone: "America/Costa_Rica",
    },
  }));

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/rest/v1/wedding_memberships") {
      membershipCalls += 1;
      return backend.failMembershipCalls?.includes(membershipCalls) ? json({ message: "boom" }, 500) : json(memberships);
    }
    if (url.pathname === "/rest/v1/guest_invitations") {
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }
    if (url.pathname === "/rest/v1/weddings") {
      const ids = /^in\.\((.*)\)$/.exec(url.searchParams.get("id") ?? "")?.[1].split(",") ?? [];
      return json(ids.map((id) => emptyRow(url.searchParams.get("select") ?? "", id)));
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
  return { supabase, requests };
}

const MEMBERSHIPS = "GET /rest/v1/wedding_memberships";

async function page(backend: Backend, showList: boolean) {
  const env = setup(backend);
  const result = await loadMyWeddingsPage(env.supabase, USER_ID, { showList, now: NOW });
  return { ...env, result };
}

describe("loadMyWeddingsPage: the overview runs only in list mode, once", () => {
  it("0 weddings → empty, 1 request (with or without ?all=1)", async () => {
    for (const showList of [false, true]) {
      const { result, requests } = await page({ weddings: 0 }, showList);
      expect(result).toEqual({ kind: "empty" });
      expect(requests).toEqual([MEMBERSHIPS]);
    }
  });

  it("1 wedding → redirect into it, 1 request", async () => {
    const { result, requests } = await page({ weddings: 1 }, false);
    expect(result).toEqual({ kind: "redirect", path: `/app/weddings/${weddingId(1)}` });
    expect(requests).toEqual([MEMBERSHIPS]);
  });

  it("list failed → error, 1 request (never empty, never the overview)", async () => {
    const { result, requests } = await page({ weddings: 3, failMembershipCalls: [1] }, true);
    expect(result).toEqual({ kind: "error" });
    expect(requests).toEqual([MEMBERSHIPS]);
  });

  it.each([
    ["1 wedding + ?all=1", 1, true],
    ["2 weddings", 2, false],
    ["25 weddings", 25, false],
  ] as const)("%s → list with a ready overview: exactly 7 requests", async (_label, n, showList) => {
    const { result, requests } = await page({ weddings: n }, showList);
    if (result.kind !== "list") throw new Error(`expected list, got ${result.kind}`);
    expect(result.weddings).toHaveLength(n);
    expect(result.overview.status).toBe("ready");
    expect(requests).toHaveLength(7);
    // The page's list + the overview's own list: the overview ran exactly once.
    expect(requests.filter((r) => r === MEMBERSHIPS)).toHaveLength(2);
    expect(requests.filter((r) => r === "HEAD /rest/v1/guest_invitations")).toHaveLength(1);
  });

  it("overview error → list kept from the first read, 2 requests", async () => {
    const { result, requests } = await page({ weddings: 3, failMembershipCalls: [2] }, false);
    if (result.kind !== "list") throw new Error(`expected list, got ${result.kind}`);
    expect(result.overview).toEqual({ status: "error" });
    expect(result.weddings.map((w) => w.id)).toHaveLength(3);
    expect(requests).toEqual([MEMBERSHIPS, MEMBERSHIPS]);
  });

  it("over the overview limit → every wedding listed, 2 requests, nothing summarized", async () => {
    const n = OVERVIEW_WEDDING_LIMIT + 1;
    const { result, requests } = await page({ weddings: n }, false);
    if (result.kind !== "list") throw new Error(`expected list, got ${result.kind}`);
    expect(result.overview).toEqual({ status: "over_limit", weddingCount: n, limit: OVERVIEW_WEDDING_LIMIT });
    expect(result.weddings).toHaveLength(n);
    expect(requests).toEqual([MEMBERSHIPS, MEMBERSHIPS]);
  });

  it("planner/persona metadata changes nothing", async () => {
    const plain = await page({ weddings: 2 }, false);
    const planner = await page({ weddings: 2, userMetadata: { planner: true, persona: "planner" } }, false);
    expect(planner.requests).toEqual(plain.requests);
    expect(planner.result).toEqual(plain.result);
  });
});

describe("loadSwitcherWeddings: one membership request, never the overview", () => {
  it("2+ weddings → serializable identity data only, 1 request", async () => {
    const { supabase, requests } = setup({ weddings: 3 });
    const weddings = await loadSwitcherWeddings(supabase, USER_ID);
    expect(requests).toEqual([MEMBERSHIPS]);
    expect(weddings).toHaveLength(3);
    for (const wedding of weddings ?? []) {
      expect(Object.keys(wedding).sort()).toEqual(["city", "dateLabel", "id", "name", "role"]);
    }
    // Plain JSON round-trips (no bigint, no Date).
    expect(JSON.parse(JSON.stringify(weddings))).toEqual(weddings);
    expect(weddings?.find((w) => w.dateLabel !== null)?.dateLabel).toBe("12 de diciembre de 2026");
  });

  it("50 weddings → still 1 request", async () => {
    const { supabase, requests } = setup({ weddings: 50 });
    expect(await loadSwitcherWeddings(supabase, USER_ID)).toHaveLength(50);
    expect(requests).toEqual([MEMBERSHIPS]);
  });

  it("0 or 1 wedding → no switcher", async () => {
    for (const n of [0, 1]) {
      const { supabase, requests } = setup({ weddings: n });
      expect(await loadSwitcherWeddings(supabase, USER_ID)).toBeNull();
      expect(requests).toEqual([MEMBERSHIPS]);
    }
  });

  it("list failure → no switcher (the page still renders)", async () => {
    const { supabase, requests } = setup({ weddings: 3, failMembershipCalls: [1] });
    expect(await loadSwitcherWeddings(supabase, USER_ID)).toBeNull();
    expect(requests).toEqual([MEMBERSHIPS]);
  });
});
