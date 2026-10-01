import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import { addMember, createWedding, ctx, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership, requireWeddingRole } = await import("@/lib/authz/wedding");

// The server authorization layer against the real local stack: identity is
// validated by the real Auth server, roles come from the real database.

async function sessionClient(user: TestUserKey | null) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  if (user) {
    const { error } = await supabase.auth.setSession({
      access_token: users[user].accessToken,
      refresh_token: users[user].refreshToken,
    });
    if (error) throw new Error(`setSession failed: ${error.message}`);
  }
  return supabase;
}

describe("server wedding authorization (real database)", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await createWedding("ownerA");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await createWedding("ownerB");
  });

  it("owner: member and owner of A", async () => {
    const supabase = await sessionClient("ownerA");
    expect(await requireWeddingRole(supabase, weddingA, ["owner"])).toEqual({
      ok: true,
      access: { weddingId: weddingA, userId: users.ownerA.id, role: "owner" },
    });
  });

  it("collaborator: member of A, forbidden where owner is required", async () => {
    const supabase = await sessionClient("collabA");
    const membership = await requireWeddingMembership(supabase, weddingA);
    expect(membership).toMatchObject({ ok: true, access: { role: "collaborator" } });
    expect(await requireWeddingRole(supabase, weddingA, ["owner"])).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("another wedding and a nonexistent wedding look the same: not_found", async () => {
    const supabase = await sessionClient("ownerA");
    const other = await requireWeddingMembership(supabase, weddingB);
    const missing = await requireWeddingMembership(supabase, randomUUID());
    expect(other).toEqual({ ok: false, reason: "not_found" });
    expect(missing).toEqual(other);
  });

  it("outsider: not_found everywhere", async () => {
    const supabase = await sessionClient("outsider");
    expect(await requireWeddingMembership(supabase, weddingA)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("no session: unauthenticated", async () => {
    const supabase = await sessionClient(null);
    expect(await requireWeddingMembership(supabase, weddingA)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });
});
