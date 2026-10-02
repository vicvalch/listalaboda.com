import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { setChecklistItemAssignee } = await import("@/lib/checklist/service");
const { listWeddingMembers, updateMyDisplayName } = await import("@/lib/weddings/service");

// Application-layer tests for LB-07: a real supabase-js client against a
// fake HTTP backend, asserting exactly what is sent and how failures map.
// The database invariants themselves are tested in tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const OTHER_MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  signedIn?: boolean;
  role?: "owner" | "collaborator" | null;
  patch?: Reply;
  rpc?: Reply;
  members?: Reply;
  network?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(signedIn: boolean): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>();
  if (signedIn) {
    items.set(
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    );
  }
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function clientFor(backend: Backend) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (url.pathname === "/auth/v1/user") {
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/wedding_memberships" && url.searchParams.has("user_id")) {
      const role = backend.role === undefined ? "collaborator" : backend.role;
      return json(role ? [{ id: MY_MEMBERSHIP, role }] : []);
    }
    if (url.pathname === "/rest/v1/wedding_memberships") {
      const reply = backend.members ?? { status: 200, body: [] };
      return json(reply.body, reply.status);
    }
    if (backend.network) throw new TypeError("network down");
    if (url.pathname === "/rest/v1/checklist_items" && method === "PATCH") {
      const reply = backend.patch ?? { status: 200, body: [{ id: ITEM_ID }] };
      return json(reply.body, reply.status);
    }
    if (url.pathname === "/rest/v1/rpc/set_wedding_display_name") {
      const reply = backend.rpc ?? { status: 200, body: "Sofía" };
      return json(reply.body, reply.status);
    }
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(backend.signedIn ?? true),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}

const writes = (requests: Recorded[]) =>
  requests.filter((r) => r.method === "PATCH" || r.url.pathname.startsWith("/rest/v1/rpc/"));

// --------------------------------------------------------------- assignment

describe("setChecklistItemAssignee", () => {
  it.each(["owner", "collaborator"] as const)(
    "%s: sends only the assignee, scoped to the authorized wedding and item",
    async (role) => {
      const { supabase, requests } = clientFor({ role });
      await expect(
        setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, OTHER_MEMBERSHIP),
      ).resolves.toEqual({ ok: true });

      const [patch] = writes(requests);
      expect(patch?.url.pathname).toBe("/rest/v1/checklist_items");
      expect(patch?.url.searchParams.get("id")).toBe(`eq.${ITEM_ID}`);
      expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
      expect(patch?.body).toEqual({ assignee_membership_id: OTHER_MEMBERSHIP });
    },
  );

  it("unassign sends null and nothing else (no status, timing or order)", async () => {
    const { supabase, requests } = clientFor({});
    await expect(setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, null)).resolves.toEqual({
      ok: true,
    });
    expect(writes(requests)[0]?.body).toEqual({ assignee_membership_id: null });
  });

  it("a target outside the wedding (FK violation) is invalid_assignee, without details", async () => {
    const { supabase } = clientFor({
      patch: {
        status: 409,
        body: {
          code: "23503",
          message: 'insert or update on table "checklist_items" violates foreign key constraint',
          details: "Key (assignee_membership_id, wedding_id)=(…) is not present",
        },
      },
    });
    const result = await setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, OTHER_MEMBERSHIP);
    expect(result).toEqual({ ok: false, reason: "invalid_assignee" });
    expect(JSON.stringify(result)).not.toContain("constraint");
  });

  it("a malformed target never reaches the database", async () => {
    const { supabase, requests } = clientFor({});
    await expect(
      setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, "not-a-uuid"),
    ).resolves.toEqual({ ok: false, reason: "invalid_assignee" });
    expect(writes(requests)).toHaveLength(0);
  });

  it("an item that isn't in the wedding is item_not_found", async () => {
    const { supabase } = clientFor({ patch: { status: 200, body: [] } });
    await expect(
      setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, OTHER_MEMBERSHIP),
    ).resolves.toEqual({ ok: false, reason: "item_not_found" });

    const malformed = clientFor({});
    await expect(
      setChecklistItemAssignee(malformed.supabase, WEDDING_ID, "nope", OTHER_MEMBERSHIP),
    ).resolves.toEqual({ ok: false, reason: "item_not_found" });
    expect(writes(malformed.requests)).toHaveLength(0);
  });

  it("an outsider gets not_found and nothing is sent", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(
      setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, MY_MEMBERSHIP),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(writes(requests)).toHaveLength(0);
  });

  it("unauthenticated: nothing is sent", async () => {
    const { supabase, requests } = clientFor({ signedIn: false });
    await expect(
      setChecklistItemAssignee(supabase, WEDDING_ID, ITEM_ID, MY_MEMBERSHIP),
    ).resolves.toEqual({ ok: false, reason: "unauthenticated" });
    expect(writes(requests)).toHaveLength(0);
  });

  it("database and network errors fail closed", async () => {
    const db = clientFor({ patch: { status: 500, body: { code: "XX000", message: "pg detail" } } });
    const dbResult = await setChecklistItemAssignee(db.supabase, WEDDING_ID, ITEM_ID, null);
    expect(dbResult).toEqual({ ok: false, reason: "error" });
    expect(JSON.stringify(dbResult)).not.toContain("pg detail");

    const net = clientFor({ network: true });
    await expect(setChecklistItemAssignee(net.supabase, WEDDING_ID, ITEM_ID, null)).resolves.toEqual(
      { ok: false, reason: "error" },
    );
  });
});

// ------------------------------------------------------------------ members

describe("listWeddingMembers", () => {
  const access = {
    weddingId: WEDDING_ID,
    userId: USER_ID,
    membershipId: MY_MEMBERSHIP,
    role: "collaborator" as const,
  };

  it("reads only safe columns and marks the caller by their own membership", async () => {
    const { supabase, requests } = clientFor({
      members: {
        status: 200,
        body: [
          { id: OTHER_MEMBERSHIP, role: "owner", display_name: null, created_at: "2026-10-01T10:00:00Z" },
          { id: MY_MEMBERSHIP, role: "collaborator", display_name: "Sofía", created_at: "2026-10-01T11:00:00Z" },
        ],
      },
    });
    await expect(listWeddingMembers(supabase, access)).resolves.toEqual([
      {
        membershipId: OTHER_MEMBERSHIP,
        role: "owner",
        displayName: null,
        isCurrentUser: false,
        joinedAt: "2026-10-01T10:00:00Z",
      },
      {
        membershipId: MY_MEMBERSHIP,
        role: "collaborator",
        displayName: "Sofía",
        isCurrentUser: true,
        joinedAt: "2026-10-01T11:00:00Z",
      },
    ]);

    const read = requests.find((r) => r.url.pathname === "/rest/v1/wedding_memberships");
    expect(read?.url.searchParams.get("select")).toBe("id,role,display_name,created_at");
    expect(read?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("returns null on failure, never a misleading empty list", async () => {
    const { supabase } = clientFor({ members: { status: 500, body: { code: "XX000" } } });
    await expect(listWeddingMembers(supabase, access)).resolves.toBeNull();
  });
});

// ------------------------------------------------------------ display name

describe("updateMyDisplayName", () => {
  it.each(["owner", "collaborator"] as const)(
    "%s: calls the self-only RPC with the wedding and the name, and no member id",
    async (role) => {
      const { supabase, requests } = clientFor({ role });
      await expect(updateMyDisplayName(supabase, WEDDING_ID, "Sofía")).resolves.toEqual({
        ok: true,
        displayName: "Sofía",
      });
      const [call] = writes(requests);
      expect(call?.url.pathname).toBe("/rest/v1/rpc/set_wedding_display_name");
      expect(call?.body).toEqual({ target_wedding_id: WEDDING_ID, new_display_name: "Sofía" });
    },
  );

  it("clearing sends a blank name and reports null", async () => {
    const { supabase, requests } = clientFor({ rpc: { status: 200, body: null } });
    await expect(updateMyDisplayName(supabase, WEDDING_ID, null)).resolves.toEqual({
      ok: true,
      displayName: null,
    });
    expect(writes(requests)[0]?.body).toEqual({
      target_wedding_id: WEDDING_ID,
      new_display_name: "",
    });
  });

  it("maps the database CHECK to invalid", async () => {
    const { supabase } = clientFor({
      rpc: { status: 400, body: { code: "23514", message: "wedding_memberships_display_name_valid" } },
    });
    await expect(updateMyDisplayName(supabase, WEDDING_ID, "x")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("outsider and unauthenticated: nothing is sent", async () => {
    const outsider = clientFor({ role: null });
    await expect(updateMyDisplayName(outsider.supabase, WEDDING_ID, "x")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(writes(outsider.requests)).toHaveLength(0);

    const anon = clientFor({ signedIn: false });
    await expect(updateMyDisplayName(anon.supabase, WEDDING_ID, "x")).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(writes(anon.requests)).toHaveLength(0);
  });

  it("database and network errors fail closed", async () => {
    const db = clientFor({ rpc: { status: 500, body: { code: "XX000", message: "pg detail" } } });
    await expect(updateMyDisplayName(db.supabase, WEDDING_ID, "x")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
    const net = clientFor({ network: true });
    await expect(updateMyDisplayName(net.supabase, WEDDING_ID, "x")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
