import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { getMessages } from "@/lib/i18n";
import type { Database } from "@/lib/supabase/database.types";
import {
  decideWeddingEntry,
  MY_WEDDINGS_LIST_PATH,
  wantsWeddingList,
} from "@/lib/weddings/entry";
import type { WeddingSummary } from "@/lib/weddings/service";

vi.mock("server-only", () => ({}));

const { listMyWeddings } = await import("@/lib/weddings/service");

// LB-24A account entry (ADR-017): 0 / 1 / N weddings, decided only from the
// membership-based list. The database side of the list is in tests/db.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function wedding(id: string, role: WeddingSummary["role"] = "owner"): WeddingSummary {
  return { id, name: `Boda ${id.slice(0, 1)}`, weddingDate: null, city: null, role };
}

describe("decideWeddingEntry", () => {
  const plain = { showList: false };

  it("a failed list is an error: never empty, never a redirect", () => {
    expect(decideWeddingEntry(null, plain)).toEqual({ kind: "error" });
    expect(decideWeddingEntry(null, { showList: true })).toEqual({ kind: "error" });
  });

  it("no weddings → empty state, with or without the list request", () => {
    expect(decideWeddingEntry([], plain)).toEqual({ kind: "empty" });
    expect(decideWeddingEntry([], { showList: true })).toEqual({ kind: "empty" });
  });

  it("exactly one wedding → straight into it, without any query", () => {
    expect(decideWeddingEntry([wedding(A)], plain)).toEqual({
      kind: "redirect",
      path: `/app/weddings/${A}`,
    });
  });

  it("a single collaborator membership redirects the same as an owner one", () => {
    expect(decideWeddingEntry([wedding(A, "collaborator")], plain)).toEqual({
      kind: "redirect",
      path: `/app/weddings/${A}`,
    });
  });

  it("two or three weddings → the list, whatever the roles", () => {
    const two = [wedding(A), wedding(B, "collaborator")];
    const three = [wedding(A, "collaborator"), wedding(B), wedding(C, "collaborator")];
    expect(decideWeddingEntry(two, plain)).toEqual({ kind: "list", weddings: two });
    expect(decideWeddingEntry(three, plain)).toEqual({ kind: "list", weddings: three });
  });

  it('"Mis bodas" (?all=1) lists even a single wedding, adding nothing to it', () => {
    const one = [wedding(A, "collaborator")];
    expect(decideWeddingEntry(one, { showList: true })).toEqual({ kind: "list", weddings: one });
  });
});

describe("wantsWeddingList", () => {
  it("only all=1 asks for the list", () => {
    expect(wantsWeddingList("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", ["1"], ["1", "1"], B]) {
      expect(wantsWeddingList(value)).toBe(false);
    }
  });

  it("the header path is exactly the closed list request", () => {
    const url = new URL(MY_WEDDINGS_LIST_PATH, "http://localhost");
    expect(url.pathname).toBe("/app");
    expect([...url.searchParams.keys()]).toEqual(["all"]);
    expect(wantsWeddingList(url.searchParams.get("all") ?? undefined)).toBe(true);
  });
});

// ------------------------------------------------------------- listMyWeddings

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";

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
        user: { id: USER_ID, aud: "authenticated", user_metadata: userMetadata },
      }),
    ],
  ]);
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

type Backend = { status?: number; body?: unknown; userMetadata?: Record<string, unknown> };

function clientFor(backend: Backend) {
  const requests: URL[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.pathname === "/rest/v1/wedding_memberships") {
      return new Response(JSON.stringify(backend.body ?? []), {
        status: backend.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), { status: 500 });
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

const rows = [
  { role: "collaborator", weddings: { id: B, name: "Boda B", wedding_date: null, city: null } },
  { role: "owner", weddings: { id: A, name: "Boda A", wedding_date: "2027-08-14", city: "Escazú" } },
];

describe("listMyWeddings", () => {
  it("reads only the caller's memberships and projects the city", async () => {
    const { supabase, requests } = clientFor({ body: rows });
    await expect(listMyWeddings(supabase, USER_ID)).resolves.toEqual([
      { id: A, name: "Boda A", weddingDate: "2027-08-14", city: "Escazú", role: "owner" },
      { id: B, name: "Boda B", weddingDate: null, city: null, role: "collaborator" },
    ]);
    const [request] = requests;
    expect(request?.searchParams.get("user_id")).toBe(`eq.${USER_ID}`);
    expect(request?.searchParams.get("select")).toBe("role,weddings(id,name,wedding_date,city)");
  });

  it("a membership whose wedding RLS hides is dropped, never shown", async () => {
    const { supabase } = clientFor({ body: [...rows, { role: "owner", weddings: null }] });
    const result = await listMyWeddings(supabase, USER_ID);
    expect(result?.map((w) => w.id)).toEqual([A, B]);
  });

  it("an error is null (not an empty list) so /app shows the error state", async () => {
    const { supabase } = clientFor({ status: 500, body: { message: "boom" } });
    const result = await listMyWeddings(supabase, USER_ID);
    expect(result).toBeNull();
    expect(decideWeddingEntry(result, { showList: false })).toEqual({ kind: "error" });
  });

  it("planner/persona metadata changes neither the query nor the result", async () => {
    const plain = clientFor({ body: rows });
    const planner = clientFor({
      body: rows,
      userMetadata: { planner: true, is_planner: true, persona: "planner", account_type: "planner" },
    });
    const expected = await listMyWeddings(plain.supabase, USER_ID);
    await expect(listMyWeddings(planner.supabase, USER_ID)).resolves.toEqual(expected);
    expect(planner.requests.map(String)).toEqual(plain.requests.map(String));
  });
});

describe("account-level copy (LB-24A)", () => {
  it("serves couples and planners alike before entering a wedding", () => {
    const { app, weddingNew, auth } = getMessages();
    const shell = [
      app.nav.myWeddings,
      app.nav.createWedding,
      app.weddings.title,
      app.weddings.emptyTitle,
      app.weddings.emptyBody,
      app.weddings.emptyInviteHint,
      app.weddings.emptyCta,
      app.weddings.createAnother,
      weddingNew.title,
      auth.login.title,
    ];
    for (const text of shell) {
      expect(text).not.toMatch(/\bmi boda\b|\btu boda\b|\btu pareja\b/i);
      expect(text).not.toMatch(/portfolio|portafolio|workspace|tenant|planner/i);
    }
    expect(app.weddings.emptyCta).toBe("Crear una boda");
    expect(app.weddings.emptyInviteHint).toMatch(/enlace/);
  });
});
