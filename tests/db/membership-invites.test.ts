import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding,
  membershipRole,
  sql,
  users,
  type WeddingRole,
} from "./support";

vi.mock("server-only", () => ({}));
const { generateMembershipInviteToken, hashMembershipInviteToken, membershipInviteExpiresAt } =
  await import("@/lib/membership-invites/token");

const INVITE_INVALID = { code: "P0001", message: "membership_invite_invalid" };
const STATE_CLOSED = "23514";

type InviteOptions = { role?: WeddingRole; email?: string | null };

/** Creates an invite as `actor` exactly as server code would: hash only. */
async function createInvite(actor: keyof typeof as, weddingId: string, options: InviteOptions = {}) {
  const { token, tokenHash } = generateMembershipInviteToken();
  const { error } = await as[actor].from("membership_invites").insert({
    wedding_id: weddingId,
    token_hash: tokenHash,
    expires_at: membershipInviteExpiresAt().toISOString(),
    intended_role: options.role ?? "collaborator",
    email: options.email ?? null,
  });
  const rows = await sql<{ id: string }>(
    "select id from public.membership_invites where token_hash = $1",
    [tokenHash],
  );
  return { token, tokenHash, error, id: rows[0]?.id ?? null };
}

async function createValidInvite(weddingId: string, options: InviteOptions = {}) {
  const invite = await createInvite("ownerA", weddingId, options);
  if (invite.error || !invite.id) throw new Error(`invite fixture failed: ${invite.error?.message}`);
  return { ...invite, id: invite.id };
}

/** Accepts as `actor`, hashing the plaintext token as the server would. */
function accept(actor: keyof typeof as, token: string) {
  return as[actor].rpc("accept_membership_invite", {
    invite_token_hash: hashMembershipInviteToken(token),
  });
}

async function inviteState(id: string) {
  const rows = await sql<{
    accepted_at: Date | null;
    accepted_by: string | null;
    revoked_at: Date | null;
  }>("select accepted_at, accepted_by, revoked_at from public.membership_invites where id = $1", [
    id,
  ]);
  return rows[0];
}

describe("membership invite creation and token storage", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await createWedding("ownerA");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await createWedding("ownerB");
  });

  it("owner can create an invite; only the SHA-256 hash is stored", async () => {
    const { token, tokenHash, error, id } = await createInvite("ownerA", weddingA);
    expect(error).toBeNull();

    const rows = await sql<{ token_hash: string; created_by: string; whole_row: string }>(
      "select token_hash, created_by, row_to_json(i)::text as whole_row from public.membership_invites i where id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.token_hash).toBe(tokenHash);
    expect(row.created_by).toBe(users.ownerA.id);
    // Redacted assertion: a failure must not print the token itself.
    expect(row.whole_row.includes(token), "plaintext token found in a stored column").toBe(false);
  });

  it("the token hash is never readable through the API, even by owners", async () => {
    const { error } = await as.ownerA.from("membership_invites").select("token_hash");
    expect(error?.code).toBe(PERMISSION_DENIED);
    const { error: starError } = await as.ownerA.from("membership_invites").select("*");
    expect(starError?.code).toBe(PERMISSION_DENIED);
  });

  it("owner can list the wedding's invites", async () => {
    const { id } = await createValidInvite(weddingA);
    const { data, error } = await as.ownerA
      .from("membership_invites")
      .select("id, wedding_id, intended_role, expires_at")
      .eq("wedding_id", weddingA);
    expect(error).toBeNull();
    expect(data?.map((i) => i.id)).toContain(id);
  });

  it("collaborator, outsider and anon cannot list invites", async () => {
    await createValidInvite(weddingA);
    for (const actor of ["collabA", "outsider"] as const) {
      const { data } = await as[actor].from("membership_invites").select("id");
      expect(data).toEqual([]);
    }
    const { data, error } = await as.anon.from("membership_invites").select("id");
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it.each(["collabA", "outsider", "anon"] as const)("%s cannot create an invite", async (actor) => {
    const { error, id } = await createInvite(actor, weddingA);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(id).toBeNull();
  });

  it("cross-wedding: owner A cannot create, list or revoke invites of wedding B", async () => {
    const created = await createInvite("ownerA", weddingB);
    expect(created.error?.code).toBe(PERMISSION_DENIED);
    expect(created.id).toBeNull();

    const bInvite = await createInvite("ownerB", weddingB);
    expect(bInvite.error).toBeNull();

    const { data: listed } = await as.ownerA
      .from("membership_invites")
      .select("id")
      .eq("wedding_id", weddingB);
    expect(listed).toEqual([]);

    const { data: revoked } = await as.ownerA
      .from("membership_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", bInvite.id ?? "")
      .select("id");
    expect(revoked).toEqual([]);
    expect((await inviteState(bInvite.id ?? ""))?.revoked_at).toBeNull();
  });

  it("clients cannot set acceptance state or provenance on insert", async () => {
    const { tokenHash } = generateMembershipInviteToken();
    const { error } = await as.ownerA.from("membership_invites").insert({
      wedding_id: weddingA,
      token_hash: tokenHash,
      expires_at: membershipInviteExpiresAt().toISOString(),
      accepted_at: new Date().toISOString(),
      accepted_by: users.outsider.id,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);

    const { error: provenanceError } = await as.ownerA.from("membership_invites").insert({
      wedding_id: weddingA,
      token_hash: tokenHash,
      expires_at: membershipInviteExpiresAt().toISOString(),
      created_by: users.collabA.id,
    });
    expect(provenanceError?.code).toBe(PERMISSION_DENIED);
  });

  it("rejects invites that are already expired or valid for more than 30 days", async () => {
    for (const expiresAt of [
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    ]) {
      const { error } = await as.ownerA.from("membership_invites").insert({
        wedding_id: weddingA,
        token_hash: generateMembershipInviteToken().tokenHash,
        expires_at: expiresAt.toISOString(),
      });
      expect(error?.code).toBe("23514");
    }
  });

  it("rejects malformed token hashes and unnormalized emails", async () => {
    const base = { wedding_id: weddingA, expires_at: membershipInviteExpiresAt().toISOString() };
    const { error } = await as.ownerA
      .from("membership_invites")
      .insert({ ...base, token_hash: "not-a-sha256-hex-digest" });
    expect(error?.code).toBe("23514");

    const { error: emailError } = await as.ownerA.from("membership_invites").insert({
      ...base,
      token_hash: generateMembershipInviteToken().tokenHash,
      email: " Invitee@Example.Test ",
    });
    expect(emailError?.code).toBe("23514");
  });

  it("owners can only revoke; other invite fields are immutable", async () => {
    const { id } = await createValidInvite(weddingA);
    for (const patch of [
      { intended_role: "owner" as const },
      { email: "x@example.test" },
      { token_hash: generateMembershipInviteToken().tokenHash },
      { expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      { wedding_id: weddingB },
    ]) {
      const { error } = await as.ownerA.from("membership_invites").update(patch).eq("id", id);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("owners cannot delete invites (revoke instead)", async () => {
    const { id } = await createValidInvite(weddingA);
    const { error } = await as.ownerA.from("membership_invites").delete().eq("id", id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await inviteState(id)).toBeDefined();
  });
});

describe("membership invite revocation", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await createWedding("ownerA");
    await addMember(wedding, "collabA", "collaborator");
  });

  it("owner revokes; the server clock sets revoked_at", async () => {
    const { id } = await createValidInvite(wedding);
    const { error } = await as.ownerA
      .from("membership_invites")
      .update({ revoked_at: "2000-01-01T00:00:00Z" })
      .eq("id", id);
    expect(error).toBeNull();
    const revokedAt = (await inviteState(id))?.revoked_at;
    expect(revokedAt).toBeInstanceOf(Date);
    expect(Math.abs((revokedAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it("a revoked invite cannot be un-revoked", async () => {
    const { id } = await createValidInvite(wedding);
    await as.ownerA.from("membership_invites").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    const { error } = await as.ownerA
      .from("membership_invites")
      .update({ revoked_at: null })
      .eq("id", id);
    expect(error?.code).toBe(STATE_CLOSED);
    expect((await inviteState(id))?.revoked_at).not.toBeNull();
  });

  it("collaborator cannot revoke", async () => {
    const { id } = await createValidInvite(wedding);
    const { data } = await as.collabA
      .from("membership_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    expect(data).toEqual([]);
    expect((await inviteState(id))?.revoked_at).toBeNull();
  });

  it("an accepted invite cannot be revoked", async () => {
    const { id, token } = await createValidInvite(wedding);
    const { error: acceptError } = await accept("invitee", token);
    expect(acceptError).toBeNull();
    const { error } = await as.ownerA
      .from("membership_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    expect(error?.code).toBe(STATE_CLOSED);
  });
});

describe("membership invite acceptance", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await createWedding("ownerA");
    weddingB = await createWedding("ownerB");
  });

  /** A fresh wedding owned by ownerA, so acceptances don't interfere. */
  async function freshWedding() {
    return createWedding("ownerA");
  }

  it("valid invite -> PASS: creates a collaborator membership and marks the invite accepted", async () => {
    const wedding = await freshWedding();
    const { id, token } = await createValidInvite(wedding);

    const { data, error } = await accept("invitee", token);
    expect(error).toBeNull();
    expect(data).toEqual([{ wedding_id: wedding, role: "collaborator", already_member: false }]);

    expect(await membershipRole(wedding, "invitee")).toBe("collaborator");
    const state = await inviteState(id);
    expect(state?.accepted_by).toBe(users.invitee.id);
    expect(state?.accepted_at).toBeInstanceOf(Date);

    // The new member now sees the wedding through RLS.
    const { data: visible } = await as.invitee.from("weddings").select("id").eq("id", wedding);
    expect(visible).toEqual([{ id: wedding }]);
  });

  it("an owner invite (partner) creates an owner membership", async () => {
    const wedding = await freshWedding();
    const { token } = await createValidInvite(wedding, { role: "owner" });
    const { data, error } = await accept("invitee", token);
    expect(error).toBeNull();
    expect(data?.[0]?.role).toBe("owner");
    expect(await membershipRole(wedding, "invitee")).toBe("owner");
  });

  it("is single-use: a second acceptance fails and creates nothing", async () => {
    const wedding = await freshWedding();
    const { token } = await createValidInvite(wedding);
    expect((await accept("invitee", token)).error).toBeNull();

    const again = await accept("invitee", token);
    expect(again.error).toMatchObject(INVITE_INVALID);
    const other = await accept("outsider", token);
    expect(other.error).toMatchObject(INVITE_INVALID);

    expect(await membershipRole(wedding, "outsider")).toBeNull();
    const rows = await sql(
      "select 1 from public.wedding_memberships where wedding_id = $1 and user_id = $2",
      [wedding, users.invitee.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("expired invite -> DENIED", async () => {
    const wedding = await freshWedding();
    const { id, token } = await createValidInvite(wedding);
    // Fixture: no client can create an already-expired invite.
    await sql(
      `update public.membership_invites
       set created_at = now() - interval '8 days', expires_at = now() - interval '1 second'
       where id = $1`,
      [id],
    );
    const { error } = await accept("invitee", token);
    expect(error).toMatchObject(INVITE_INVALID);
    expect(await membershipRole(wedding, "invitee")).toBeNull();
    expect((await inviteState(id))?.accepted_at).toBeNull();
  });

  it("revoked invite -> DENIED", async () => {
    const wedding = await freshWedding();
    const { id, token } = await createValidInvite(wedding);
    await as.ownerA
      .from("membership_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    const { error } = await accept("invitee", token);
    expect(error).toMatchObject(INVITE_INVALID);
    expect(await membershipRole(wedding, "invitee")).toBeNull();
  });

  it("anonymous acceptance -> DENIED", async () => {
    const wedding = await freshWedding();
    const { id, token } = await createValidInvite(wedding);
    const { data, error } = await accept("anon", token);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
    expect((await inviteState(id))?.accepted_at).toBeNull();
  });

  it("unknown token -> DENIED with the same error as every other invalid case", async () => {
    const { token } = generateMembershipInviteToken();
    const { error } = await accept("invitee", token);
    expect(error).toMatchObject(INVITE_INVALID);
  });

  it("existing member: no duplicate, role unchanged, invite left pending", async () => {
    const wedding = await freshWedding();
    await addMember(wedding, "collabA", "collaborator");
    const { id, token } = await createValidInvite(wedding, { role: "owner" });

    const { data, error } = await accept("collabA", token);
    expect(error).toBeNull();
    expect(data).toEqual([{ wedding_id: wedding, role: "collaborator", already_member: true }]);
    expect(await membershipRole(wedding, "collabA")).toBe("collaborator");
    expect((await inviteState(id))?.accepted_at).toBeNull();

    // Same for an owner opening their own link.
    const own = await accept("ownerA", token);
    expect(own.data).toEqual([{ wedding_id: wedding, role: "owner", already_member: true }]);
  });

  describe("email binding", () => {
    it("an email-bound invite can't be accepted by a different account", async () => {
      const wedding = await freshWedding();
      const { id, token } = await createValidInvite(wedding, { email: users.invitee.email });

      const { error } = await accept("outsider", token);
      expect(error).toMatchObject(INVITE_INVALID);
      expect(await membershipRole(wedding, "outsider")).toBeNull();
      expect((await inviteState(id))?.accepted_at).toBeNull();
    });

    it("an email-bound invite is accepted by the matching, confirmed account", async () => {
      const wedding = await freshWedding();
      const { token } = await createValidInvite(wedding, { email: users.invitee.email });
      const { error } = await accept("invitee", token);
      expect(error).toBeNull();
      expect(await membershipRole(wedding, "invitee")).toBe("collaborator");
    });

    it("an unconfirmed matching account can't accept", async () => {
      const wedding = await freshWedding();
      const { token } = await createValidInvite(wedding, { email: users.invitee.email });
      const confirmed = await sql<{ email_confirmed_at: Date | null }>(
        "select email_confirmed_at from auth.users where id = $1",
        [users.invitee.id],
      );
      try {
        await sql("update auth.users set email_confirmed_at = null where id = $1", [
          users.invitee.id,
        ]);
        const { error } = await accept("invitee", token);
        expect(error).toMatchObject(INVITE_INVALID);
      } finally {
        await sql("update auth.users set email_confirmed_at = $2 where id = $1", [
          users.invitee.id,
          confirmed[0]?.email_confirmed_at ?? new Date(),
        ]);
      }
      expect(await membershipRole(wedding, "invitee")).toBeNull();
    });
  });

  it("cross-wedding: a member of A gains nothing in B without B's token", async () => {
    // Owner A can't see B's invites, so can't obtain a hash to submit, and a
    // guessed hash is just an unknown invite.
    const { id } = await createInvite("ownerB", weddingB);
    const { data } = await as.ownerA.from("membership_invites").select("id").eq("id", id ?? "");
    expect(data).toEqual([]);

    const guessed = createHash("sha256").update("guess").digest("hex");
    const { error } = await as.ownerA.rpc("accept_membership_invite", {
      invite_token_hash: guessed,
    });
    expect(error).toMatchObject(INVITE_INVALID);
    expect(await membershipRole(weddingB, "ownerA")).toBeNull();
    expect((await inviteState(id ?? ""))?.accepted_at).toBeNull();
  });

  it("cross-wedding: accepting B's invite (legitimately holding the token) grants only B", async () => {
    const { token } = await createInvite("ownerB", weddingB);
    const before = await membershipRole(weddingA, "outsider");
    const { data, error } = await accept("outsider", token);
    expect(error).toBeNull();
    expect(data?.[0]?.wedding_id).toBe(weddingB);
    expect(await membershipRole(weddingA, "outsider")).toBe(before);
  });
});
