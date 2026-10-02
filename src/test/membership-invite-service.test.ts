import { createHash } from "node:crypto";

import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const {
  acceptMembershipInvite,
  createMembershipInvite,
  inviteStatus,
  revokeMembershipInvite,
} = await import("@/lib/membership-invites/service");
const { MEMBERSHIP_INVITE_TTL_MS } = await import("@/lib/membership-invites/token");
const { createWedding } = await import("@/lib/weddings/service");

// Application-layer tests: a real supabase-js client against a fake HTTP
// backend, asserting exactly what is sent. RLS and the RPCs themselves are
// tested against local Supabase in tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://listalaboda.test";

type Recorded = { method: string; url: URL; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  insertStatus?: number;
  rpc?: { status: number; body: unknown };
  revokeRows?: unknown[];
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
    if (url.pathname === "/rest/v1/membership_invites" && method === "POST") {
      const status = backend.insertStatus ?? 201;
      return status === 201
        ? new Response(null, { status })
        : json({ code: "42501", message: "denied" }, status);
    }
    if (url.pathname === "/rest/v1/membership_invites" && method === "PATCH") {
      return json(backend.revokeRows ?? [{ id: INVITE_ID }]);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const rpc = backend.rpc ?? { status: 200, body: [] };
      return json(rpc.body, rpc.status);
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("createMembershipInvite", () => {
  const input = { email: "pareja@example.test", role: "owner" as const };

  it("owner: inserts only the hash and allowed columns, returns the one link", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    const now = new Date("2026-10-01T12:00:00Z");

    const result = await createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = /^https:\/\/listalaboda\.test\/invite\/([A-Za-z0-9_-]{43})$/.exec(
      result.inviteUrl,
    );
    expect(match, "invite URL shape (value redacted)").not.toBeNull();
    const token = match?.[1] ?? "";

    const insert = requests.find((r) => r.method === "POST");
    expect(insert?.url.pathname).toBe("/rest/v1/membership_invites");
    expect(Object.keys(insert?.body as object).sort()).toEqual([
      "email",
      "expires_at",
      "intended_role",
      "token_hash",
      "wedding_id",
    ]);
    expect(insert?.body).toMatchObject({
      wedding_id: WEDDING_ID,
      intended_role: "owner",
      email: "pareja@example.test",
      token_hash: sha256(token),
      expires_at: new Date(now.getTime() + MEMBERSHIP_INVITE_TTL_MS).toISOString(),
    });
    // The plaintext token never leaves the server towards the database.
    const sent = requests.map((r) => `${r.url.toString()} ${JSON.stringify(r.body ?? "")}`);
    expect(sent.some((s) => s.includes(token)), "plaintext token sent (redacted)").toBe(false);
    // Nothing is read back (no `select`/representation of the inserted row).
    expect(insert?.url.searchParams.get("select")).toBeNull();
  });

  it("generates a fresh token per invite", async () => {
    const { supabase } = clientFor({ role: "owner" });
    const a = await createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN);
    const b = await createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN);
    expect(a.ok && b.ok && a.inviteUrl !== b.inviteUrl).toBe(true);
  });

  it("collaborator: forbidden, nothing inserted", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator" });
    await expect(createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("non-member: not_found, nothing inserted", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("an RLS denial on insert fails closed without echoing the token", async () => {
    const { supabase } = clientFor({ role: "owner", insertStatus: 403 });
    const result = await createMembershipInvite(supabase, WEDDING_ID, input, ORIGIN);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("acceptMembershipInvite", () => {
  const token = "A".repeat(43);

  it("sends only the SHA-256 hash to the RPC: no plaintext, no user id, no role", async () => {
    const { supabase, requests } = clientFor({
      rpc: { status: 200, body: [{ wedding_id: WEDDING_ID, role: "collaborator", already_member: false }] },
    });

    await expect(acceptMembershipInvite(supabase, token)).resolves.toEqual({
      ok: true,
      weddingId: WEDDING_ID,
      role: "collaborator",
      alreadyMember: false,
    });

    const rpc = requests.find((r) => r.url.pathname === "/rest/v1/rpc/accept_membership_invite");
    expect(rpc?.body).toEqual({ invite_token_hash: sha256(token) });
    const sent = requests.map((r) => `${r.url.toString()} ${JSON.stringify(r.body ?? "")}`);
    expect(sent.some((s) => s.includes(token))).toBe(false);
  });

  it("reports an existing member without changing anything", async () => {
    const { supabase } = clientFor({
      rpc: { status: 200, body: [{ wedding_id: WEDDING_ID, role: "owner", already_member: true }] },
    });
    await expect(acceptMembershipInvite(supabase, token)).resolves.toMatchObject({
      ok: true,
      alreadyMember: true,
      role: "owner",
    });
  });

  it.each(["", "not-a-real-token", `${"A".repeat(42)}=`, "A".repeat(44)])(
    "rejects malformed token %# before any network call",
    async (bad) => {
      const { supabase, requests } = clientFor({});
      await expect(acceptMembershipInvite(supabase, bad)).resolves.toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(requests).toHaveLength(0);
    },
  );

  it("maps the database's single invalid-invite error to a generic invalid", async () => {
    const { supabase } = clientFor({
      rpc: { status: 400, body: { code: "P0001", message: "membership_invite_invalid" } },
    });
    await expect(acceptMembershipInvite(supabase, token)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("treats other database failures as transient errors", async () => {
    const { supabase } = clientFor({ rpc: { status: 500, body: { code: "XX000", message: "boom" } } });
    await expect(acceptMembershipInvite(supabase, token)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("fails closed on an unexpected RPC result", async () => {
    const { supabase } = clientFor({ rpc: { status: 200, body: [{ wedding_id: "../evil" }] } });
    await expect(acceptMembershipInvite(supabase, token)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});

describe("revokeMembershipInvite", () => {
  it("owner: sends only revoked_at, scoped to the wedding and to pending invites", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(revokeMembershipInvite(supabase, WEDDING_ID, INVITE_ID)).resolves.toEqual({
      ok: true,
    });
    const patch = requests.find((r) => r.method === "PATCH");
    expect(Object.keys(patch?.body as object)).toEqual(["revoked_at"]);
    expect(patch?.url.searchParams.get("id")).toBe(`eq.${INVITE_ID}`);
    expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
    expect(patch?.url.searchParams.get("revoked_at")).toBe("is.null");
    expect(patch?.url.searchParams.get("accepted_at")).toBe("is.null");
  });

  it("collaborator: forbidden before any update", async () => {
    const { supabase, requests } = clientFor({ role: "collaborator" });
    await expect(revokeMembershipInvite(supabase, WEDDING_ID, INVITE_ID)).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("a closed or foreign invite (no row updated) is not_found", async () => {
    const { supabase } = clientFor({ role: "owner", revokeRows: [] });
    await expect(revokeMembershipInvite(supabase, WEDDING_ID, INVITE_ID)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("a malformed invite id never reaches the database", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(revokeMembershipInvite(supabase, WEDDING_ID, "1 or 1=1")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const base = { accepted_at: null, revoked_at: null, expires_at: "2026-10-08T12:00:00Z" };

  it("derives the status shown to owners", () => {
    expect(inviteStatus(base, now)).toBe("pending");
    expect(inviteStatus({ ...base, accepted_at: "2026-10-02T00:00:00Z" }, now)).toBe("accepted");
    expect(inviteStatus({ ...base, revoked_at: "2026-10-02T00:00:00Z" }, now)).toBe("revoked");
    expect(inviteStatus({ ...base, expires_at: "2026-10-01T11:59:59Z" }, now)).toBe("expired");
  });
});

describe("createWedding", () => {
  it("calls create_wedding with name and date only — never a user, owner or role", async () => {
    const { supabase, requests } = clientFor({
      rpc: { status: 200, body: { id: WEDDING_ID, name: "Boda", wedding_date: "2027-06-12" } },
    });
    await expect(
      createWedding(supabase, { name: "Boda", weddingDate: "2027-06-12" }),
    ).resolves.toEqual({ ok: true, weddingId: WEDDING_ID });

    const rpc = requests.find((r) => r.url.pathname === "/rest/v1/rpc/create_wedding");
    expect(rpc?.body).toEqual({ wedding_name: "Boda", wedding_date: "2027-06-12" });
  });

  it("omits the date when there is none", async () => {
    const { supabase, requests } = clientFor({
      rpc: { status: 200, body: { id: WEDDING_ID } },
    });
    await createWedding(supabase, { name: "Boda", weddingDate: null });
    const rpc = requests.find((r) => r.url.pathname === "/rest/v1/rpc/create_wedding");
    expect(rpc?.body).toEqual({ wedding_name: "Boda" });
  });

  it("maps database rejections without leaking them", async () => {
    const cases = [
      [{ code: "23514", message: "check" }, "invalid_name"],
      [{ code: "22008", message: "date" }, "invalid_date"],
      [{ code: "42501", message: "not_authenticated" }, "unauthenticated"],
      [{ code: "XX000", message: "internal detail" }, "error"],
    ] as const;
    for (const [body, reason] of cases) {
      const { supabase } = clientFor({ rpc: { status: 400, body } });
      await expect(createWedding(supabase, { name: "Boda", weddingDate: null })).resolves.toEqual({
        ok: false,
        reason,
      });
    }
  });
});
