import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  addMember,
  createWedding as createFixtureWedding,
  ctx,
  membershipRole,
  sql,
  users,
} from "./support";

vi.mock("server-only", () => ({}));
const { createWedding, listMyWeddings } = await import("@/lib/weddings/service");
const {
  acceptMembershipInvite,
  createMembershipInvite,
  listMembershipInvites,
  revokeMembershipInvite,
} = await import("@/lib/membership-invites/service");

// LB-04 application services against the real local stack: identity from
// the real Auth server, authority from real memberships, RLS underneath.

const ORIGIN = "http://localhost:3000";

// Users are shared with the LB-03 suites, which assert global visibility
// (e.g. "a collaborator sees no invites"). Every wedding created here is
// deleted afterwards (memberships and invites cascade) so those stay valid.
const createdWeddings: string[] = [];

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});
const TOKEN_IN_URL = /\/invite\/([A-Za-z0-9_-]{43})$/;

async function sessionClient(user: TestUserKey) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return supabase;
}

function tokenFrom(url: string): string {
  const token = TOKEN_IN_URL.exec(url)?.[1];
  if (!token) throw new Error("invite URL has an unexpected shape (value redacted)");
  return token;
}

describe("wedding creation service", () => {
  it("creates the wedding with the caller as owner; ids come from the database", async () => {
    const supabase = await sessionClient("ownerA");
    const result = await createWedding(supabase, { name: "Boda del servicio", weddingDate: "2027-05-01" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdWeddings.push(result.weddingId);

    expect(await membershipRole(result.weddingId, "ownerA")).toBe("owner");
    const rows = await sql<{ created_by: string; wedding_date: string }>(
      "select created_by, wedding_date::text from public.weddings where id = $1",
      [result.weddingId],
    );
    expect(rows).toEqual([{ created_by: users.ownerA.id, wedding_date: "2027-05-01" }]);
  });

  it("lists exactly the weddings the user is a member of, with their role", async () => {
    const mine = await fixtureWedding("ownerB", "Boda listada de B");
    const shared = await fixtureWedding("ownerA", "Boda compartida");
    await addMember(shared, "ownerB", "collaborator");
    const notMine = await fixtureWedding("ownerA", "Boda ajena");

    const weddings = await listMyWeddings(await sessionClient("ownerB"), users.ownerB.id);
    const ids = weddings?.map((w) => w.id) ?? [];
    expect(ids).toContain(mine);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(notMine);
    expect(weddings?.find((w) => w.id === shared)?.role).toBe("collaborator");
  });
});

describe("membership invite services", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda con invitaciones");
    await addMember(wedding, "collabA", "collaborator");
  });

  it("owner creates an invite: only the hash is stored, with role, email and 7-day expiry", async () => {
    const supabase = await sessionClient("ownerA");
    const result = await createMembershipInvite(
      supabase,
      wedding,
      { email: users.invitee.email, role: "owner" },
      ORIGIN,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const token = tokenFrom(result.inviteUrl);
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const rows = await sql<{
      intended_role: string;
      email: string;
      created_by: string;
      ttl_hours: number;
      whole_row: string;
    }>(
      `select intended_role, email, created_by,
              round(extract(epoch from expires_at - created_at) / 3600)::int as ttl_hours,
              row_to_json(i)::text as whole_row
       from public.membership_invites i where token_hash = $1`,
      [tokenHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intended_role: "owner",
      email: users.invitee.email,
      created_by: users.ownerA.id,
      ttl_hours: 7 * 24,
    });
    expect(rows[0].whole_row.includes(token), "plaintext token stored (redacted)").toBe(false);

    // Owners can list it; the listing never includes token_hash.
    const listed = await listMembershipInvites(supabase, wedding);
    expect(listed?.some((i) => i.email === users.invitee.email && i.status === "pending")).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(tokenHash);
  });

  it("collaborator gets forbidden and an outsider not_found; nothing is inserted", async () => {
    const before = await sql<{ n: number }>(
      "select count(*)::int as n from public.membership_invites where wedding_id = $1",
      [wedding],
    );
    const input = { email: null, role: "collaborator" as const };
    expect(await createMembershipInvite(await sessionClient("collabA"), wedding, input, ORIGIN)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await createMembershipInvite(await sessionClient("outsider"), wedding, input, ORIGIN)).toEqual({
      ok: false,
      reason: "not_found",
    });
    const after = await sql<{ n: number }>(
      "select count(*)::int as n from public.membership_invites where wedding_id = $1",
      [wedding],
    );
    expect(after).toEqual(before);
  });

  it("accepting with the plaintext link token joins the same wedding with the invite's role", async () => {
    const target = await fixtureWedding("ownerA", "Boda para aceptar");
    const created = await createMembershipInvite(
      await sessionClient("ownerA"),
      target,
      { email: null, role: "collaborator" },
      ORIGIN,
    );
    if (!created.ok) throw new Error("invite fixture failed");
    const token = tokenFrom(created.inviteUrl);

    const accepted = await acceptMembershipInvite(await sessionClient("outsider"), token);
    expect(accepted).toEqual({
      ok: true,
      weddingId: target,
      role: "collaborator",
      alreadyMember: false,
    });
    expect(await membershipRole(target, "outsider")).toBe("collaborator");

    // Single use: a second acceptance is the generic invalid outcome.
    expect(await acceptMembershipInvite(await sessionClient("collabA"), token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("an owner-role invite creates a co-owner", async () => {
    const target = await fixtureWedding("ownerB", "Boda de pareja");
    const created = await createMembershipInvite(
      await sessionClient("ownerB"),
      target,
      { email: null, role: "owner" },
      ORIGIN,
    );
    if (!created.ok) throw new Error("invite fixture failed");
    const accepted = await acceptMembershipInvite(
      await sessionClient("collabA"),
      tokenFrom(created.inviteUrl),
    );
    expect(accepted).toMatchObject({ ok: true, role: "owner", alreadyMember: false });
    expect(await membershipRole(target, "collabA")).toBe("owner");
  });

  it("revoked invites can't be accepted; revocation is owner-only", async () => {
    const target = await fixtureWedding("ownerA", "Boda con revocación");
    await addMember(target, "collabA", "collaborator");
    const owner = await sessionClient("ownerA");
    const created = await createMembershipInvite(owner, target, { email: null, role: "collaborator" }, ORIGIN);
    if (!created.ok) throw new Error("invite fixture failed");
    const invites = await listMembershipInvites(owner, target);
    const inviteId = invites?.[0]?.id ?? "";

    expect(await revokeMembershipInvite(await sessionClient("collabA"), target, inviteId)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await revokeMembershipInvite(owner, target, inviteId)).toEqual({ ok: true });
    // Already revoked: nothing left to revoke.
    expect(await revokeMembershipInvite(owner, target, inviteId)).toEqual({
      ok: false,
      reason: "not_found",
    });

    expect(
      await acceptMembershipInvite(await sessionClient("invitee"), tokenFrom(created.inviteUrl)),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(await membershipRole(target, "invitee")).toBeNull();
  });

  it("a malformed token is invalid without a database round-trip", async () => {
    expect(await acceptMembershipInvite(await sessionClient("invitee"), "not-a-real-token")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
