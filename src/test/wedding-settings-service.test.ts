import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { updateWeddingSettings } = await import("@/lib/weddings/service");

// Application-layer tests for the owner-only settings update: a real
// supabase-js client against a fake HTTP backend, asserting exactly what is
// sent. RLS itself is tested against local Supabase in tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";

type Recorded = { method: string; url: URL; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  update?: { status: number; body: unknown };
  throwOnUpdate?: boolean;
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
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/wedding_memberships") {
      return json(backend.role ? [{ id: "33333333-3333-4333-8333-333333333333", role: backend.role }] : []);
    }
    if (url.pathname === "/rest/v1/weddings" && method === "PATCH") {
      if (backend.throwOnUpdate) throw new TypeError("network down");
      const update = backend.update ?? { status: 200, body: [{ id: WEDDING_ID }] };
      return json(update.body, update.status);
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

const input = { name: "Boda de Ana y Luis", weddingDate: "2027-08-14" };
const patches = (requests: Recorded[]) => requests.filter((r) => r.method === "PATCH");

describe("updateWeddingSettings", () => {
  it("owner: sends only name and date, scoped to the authorized wedding", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({ ok: true });

    const [patch] = patches(requests);
    expect(patch?.url.pathname).toBe("/rest/v1/weddings");
    expect(patch?.url.searchParams.get("id")).toBe(`eq.${WEDDING_ID}`);
    expect(patch?.body).toEqual({ name: "Boda de Ana y Luis", wedding_date: "2027-08-14" });
  });

  it("a cleared date is sent as null", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await updateWeddingSettings(supabase, WEDDING_ID, { ...input, weddingDate: null });
    expect(patches(requests)[0]?.body).toEqual({ name: "Boda de Ana y Luis", wedding_date: null });
  });

  it("never touches checklist items", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await updateWeddingSettings(supabase, WEDDING_ID, input);
    expect(requests.some((r) => r.url.pathname.includes("checklist"))).toBe(false);
  });

  it("collaborator: forbidden, nothing sent", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator" });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(patches(requests)).toHaveLength(0);
  });

  it("non-member: not_found, nothing sent", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(patches(requests)).toHaveLength(0);
  });

  it("maps the name CHECK violation to invalid_name", async () => {
    const { supabase } = clientFor({
      role: "owner",
      update: { status: 400, body: { code: "23514", message: "weddings_name_not_blank" } },
    });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "invalid_name",
    });
  });

  it("zero updated rows (role changed meanwhile) is not_found", async () => {
    const { supabase } = clientFor({ role: "owner", update: { status: 200, body: [] } });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("an RLS denial fails closed as forbidden", async () => {
    const { supabase } = clientFor({
      role: "owner",
      update: { status: 403, body: { code: "42501", message: "permission denied" } },
    });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("a database error fails closed without exposing it", async () => {
    const { supabase } = clientFor({
      role: "owner",
      update: { status: 500, body: { code: "XX000", message: "internal postgres detail" } },
    });
    const result = await updateWeddingSettings(supabase, WEDDING_ID, input);
    expect(result).toEqual({ ok: false, reason: "error" });
    expect(JSON.stringify(result)).not.toContain("postgres");
  });

  it("a network failure fails closed", async () => {
    const { supabase } = clientFor({ role: "owner", throwOnUpdate: true });
    await expect(updateWeddingSettings(supabase, WEDDING_ID, input)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
