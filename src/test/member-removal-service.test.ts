import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { removeWeddingMember } = await import("@/lib/weddings/service");

// Application-layer tests for owner-only member removal: a real supabase-js
// client against a fake HTTP backend, asserting exactly what is sent. RLS,
// the final-owner trigger and the assignment cleanup are tested against
// local Supabase in tests/db/member-removal.test.ts.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";

type Recorded = { method: string; url: URL; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  remove?: { status: number; body: unknown };
  throwOnDelete?: boolean;
  noSession?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function clientFor(backend: Backend) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (url.pathname === "/auth/v1/user") {
      if (backend.noSession) return json({ message: "invalid JWT" }, 401);
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/wedding_memberships" && method === "GET") {
      return json(backend.role ? [{ id: MY_MEMBERSHIP, role: backend.role }] : []);
    }
    if (url.pathname === "/rest/v1/wedding_memberships" && method === "DELETE") {
      if (backend.throwOnDelete) throw new TypeError("network down");
      const remove = backend.remove ?? { status: 200, body: [{ id: TARGET }] };
      return json(remove.body, remove.status);
    }
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}

const deletes = (requests: Recorded[]) => requests.filter((r) => r.method === "DELETE");

describe("removeWeddingMember", () => {
  it("owner: deletes exactly one membership, scoped to the authorized wedding", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({ ok: true });

    const [del] = deletes(requests);
    expect(deletes(requests)).toHaveLength(1);
    expect(del?.url.pathname).toBe("/rest/v1/wedding_memberships");
    expect(del?.url.searchParams.get("id")).toBe(`eq.${TARGET}`);
    expect(del?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    // Nothing else is touched: no auth admin call, no items, no invites.
    expect(requests.some((r) => r.url.pathname.startsWith("/auth/v1/admin"))).toBe(false);
    expect(requests.some((r) => r.url.pathname.includes("checklist"))).toBe(false);
    expect(requests.some((r) => r.url.pathname.includes("membership_invites"))).toBe(false);
  });

  it("the caller's role comes from the database, never from input", async () => {
    // The signature has no caller id, membership id or role to forge.
    expect(removeWeddingMember.length).toBe(3);
    const { supabase, requests } = clientFor({ role: "owner" });
    await removeWeddingMember(supabase, WEDDING_ID, TARGET);
    const lookup = requests.find(
      (r) => r.method === "GET" && r.url.pathname === "/rest/v1/wedding_memberships",
    );
    expect(lookup?.url.searchParams.get("user_id")).toBe(`eq.${USER_ID}`);
    expect(lookup?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("self-target: refused before any delete", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(removeWeddingMember(supabase, WEDDING_ID, MY_MEMBERSHIP)).resolves.toEqual({
      ok: false,
      reason: "cannot_remove_self",
    });
    await expect(
      removeWeddingMember(supabase, WEDDING_ID, MY_MEMBERSHIP.toUpperCase()),
    ).resolves.toEqual({ ok: false, reason: "cannot_remove_self" });
    expect(deletes(requests)).toHaveLength(0);
  });

  it("collaborator: forbidden, nothing sent", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator" });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(deletes(requests)).toHaveLength(0);
  });

  it("non-member (outsider): not_found, nothing sent", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(deletes(requests)).toHaveLength(0);
  });

  it("anonymous: unauthenticated, nothing sent", async () => {
    const { supabase, requests } = clientFor({ role: "owner", noSession: true });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(deletes(requests)).toHaveLength(0);
  });

  it("a malformed wedding id is not_found; a malformed target is invalid_target", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(removeWeddingMember(supabase, "not-a-uuid", TARGET)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    for (const target of ["", "not-a-uuid", `${TARGET},${MY_MEMBERSHIP}`]) {
      await expect(removeWeddingMember(supabase, WEDDING_ID, target)).resolves.toEqual({
        ok: false,
        reason: "invalid_target",
      });
    }
    expect(deletes(requests)).toHaveLength(0);
  });

  it("zero deleted rows (other wedding, unknown or already removed): invalid_target", async () => {
    const { supabase } = clientFor({ role: "owner", remove: { status: 200, body: [] } });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("the final-owner trigger maps to last_owner", async () => {
    const { supabase } = clientFor({
      role: "owner",
      remove: { status: 400, body: { code: "23514", message: "wedding_must_have_owner" } },
    });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "last_owner",
    });
  });

  it("an RLS denial fails closed as forbidden", async () => {
    const { supabase } = clientFor({
      role: "owner",
      remove: { status: 403, body: { code: "42501", message: "permission denied" } },
    });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("a database error fails closed without exposing it", async () => {
    const { supabase } = clientFor({
      role: "owner",
      remove: { status: 500, body: { code: "XX000", message: "internal postgres detail" } },
    });
    const result = await removeWeddingMember(supabase, WEDDING_ID, TARGET);
    expect(result).toEqual({ ok: false, reason: "error" });
    expect(JSON.stringify(result)).not.toContain("postgres");
  });

  it("a network failure fails closed", async () => {
    const { supabase } = clientFor({ role: "owner", throwOnDelete: true });
    await expect(removeWeddingMember(supabase, WEDDING_ID, TARGET)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
