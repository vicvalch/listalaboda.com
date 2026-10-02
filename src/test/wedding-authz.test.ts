import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { requireWeddingMembership, requireWeddingRole } = await import(
  "@/lib/authz/wedding"
);

// Unit tests for the decision logic around the database answer. They run a
// real supabase-js client against a fake HTTP backend; RLS itself is tested
// against local Supabase in tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";
const STORAGE_KEY = "authz-test";

type Backend = {
  /** HTTP status for GET /auth/v1/user; 200 returns the signed-in user. */
  authStatus?: number;
  /** Membership rows PostgREST returns, or an HTTP error status. */
  memberships?: ReadonlyArray<{ role: string; id?: string }> | { status: number };
  /** Throw from fetch, as on a network failure. */
  networkError?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(session: object | null): SupportedStorage {
  const items = new Map<string, string>();
  if (session) items.set(STORAGE_KEY, JSON.stringify(session));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function clientFor(backend: Backend, { signedIn = true } = {}) {
  const requests: URL[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (backend.networkError) throw new TypeError("fetch failed");

    if (url.pathname === "/auth/v1/user") {
      const status = backend.authStatus ?? 200;
      return status === 200
        ? json({ id: USER_ID, aud: "authenticated", role: "authenticated" })
        : json({ code: status, msg: "invalid JWT" }, status);
    }
    if (url.pathname === "/rest/v1/wedding_memberships") {
      const memberships = backend.memberships ?? [];
      return "status" in memberships
        ? json({ code: "XX000", message: "boom" }, memberships.status)
        : json(memberships.map((m) => ({ id: MEMBERSHIP_ID, ...m })));
    }
    return json({ message: "unexpected request" }, 500);
  };

  const now = Math.floor(Date.now() / 1000);
  const session = signedIn
    ? {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }
    : null;

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(session),
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}

describe("requireWeddingMembership", () => {
  it.each(["owner", "collaborator"] as const)("allows a %s", async (role) => {
    const { supabase, requests } = clientFor({ memberships: [{ role }] });

    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: true,
      access: { weddingId: WEDDING_ID, userId: USER_ID, membershipId: MEMBERSHIP_ID, role },
    });

    // The lookup is scoped to the validated user, not to any client input.
    const lookup = requests.find((r) => r.pathname === "/rest/v1/wedding_memberships");
    expect(lookup?.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(lookup?.searchParams.get("user_id")).toBe(`eq.${USER_ID}`);
  });

  it("returns not_found for a wedding the user can't see (or that doesn't exist)", async () => {
    const { supabase } = clientFor({ memberships: [] });
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("returns not_found for a malformed wedding id without querying", async () => {
    const { supabase, requests } = clientFor({ memberships: [{ role: "owner" }] });
    await expect(requireWeddingMembership(supabase, "not-a-uuid")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(requests.some((r) => r.pathname.startsWith("/rest/"))).toBe(false);
  });

  it("denies without a session", async () => {
    const { supabase, requests } = clientFor(
      { memberships: [{ role: "owner" }] },
      { signedIn: false },
    );
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(requests.some((r) => r.pathname.startsWith("/rest/"))).toBe(false);
  });

  it("denies when the Auth server rejects the session", async () => {
    const { supabase } = clientFor({ authStatus: 401, memberships: [{ role: "owner" }] });
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("fails closed on a database error", async () => {
    const { supabase } = clientFor({ memberships: { status: 500 } });
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("fails closed on a network error", async () => {
    const { supabase } = clientFor({ networkError: true });
    const result = await requireWeddingMembership(supabase, WEDDING_ID);
    expect(result.ok).toBe(false);
  });

  it("fails closed on an unknown role value", async () => {
    const { supabase } = clientFor({ memberships: [{ role: "admin" }] });
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("fails closed when the membership id is missing or malformed", async () => {
    const { supabase } = clientFor({ memberships: [{ role: "owner", id: "not-a-uuid" }] });
    await expect(requireWeddingMembership(supabase, WEDDING_ID)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});

describe("requireWeddingRole", () => {
  it("allows an owner where owner is required", async () => {
    const { supabase } = clientFor({ memberships: [{ role: "owner" }] });
    const result = await requireWeddingRole(supabase, WEDDING_ID, ["owner"]);
    expect(result).toEqual({
      ok: true,
      access: { weddingId: WEDDING_ID, userId: USER_ID, membershipId: MEMBERSHIP_ID, role: "owner" },
    });
  });

  it("forbids a collaborator where owner is required", async () => {
    const { supabase } = clientFor({ memberships: [{ role: "collaborator" }] });
    await expect(requireWeddingRole(supabase, WEDDING_ID, ["owner"])).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("answers not_found, not forbidden, to a non-member", async () => {
    const { supabase } = clientFor({ memberships: [] });
    await expect(requireWeddingRole(supabase, WEDDING_ID, ["owner"])).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("denies everyone when no role is allowed", async () => {
    const { supabase } = clientFor({ memberships: [{ role: "owner" }] });
    await expect(requireWeddingRole(supabase, WEDDING_ID, [])).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});
