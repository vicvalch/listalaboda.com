import { beforeAll, describe, expect, it } from "vitest";

import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding,
  membershipRole,
  sql,
  superuser,
  users,
} from "./support";
import type { TestUserKey } from "./context";

const OWNER_REQUIRED = "23514";

function updateRole(actor: keyof typeof as, weddingId: string, target: TestUserKey, role: "owner" | "collaborator") {
  return as[actor]
    .from("wedding_memberships")
    .update({ role })
    .eq("wedding_id", weddingId)
    .eq("user_id", users[target].id)
    .select("role");
}

function removeMember(actor: keyof typeof as, weddingId: string, target: TestUserKey) {
  return as[actor]
    .from("wedding_memberships")
    .delete()
    .eq("wedding_id", weddingId)
    .eq("user_id", users[target].id)
    .select("user_id");
}

describe("wedding_memberships RLS", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await createWedding("ownerA");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await createWedding("ownerB");
  });

  async function visibleMembers(actor: keyof typeof as, weddingId: string) {
    const { data } = await as[actor]
      .from("wedding_memberships")
      .select("user_id, role")
      .eq("wedding_id", weddingId);
    return (data ?? []).map((m) => m.user_id).sort();
  }

  it("anon cannot read memberships", async () => {
    const { data, error } = await as.anon.from("wedding_memberships").select("user_id");
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it("owner and collaborator see their wedding's members", async () => {
    const expected = [users.ownerA.id, users.collabA.id].sort();
    expect(await visibleMembers("ownerA", weddingA)).toEqual(expected);
    expect(await visibleMembers("collabA", weddingA)).toEqual(expected);
  });

  it("cross-wedding: members of A see nothing of B, and vice versa", async () => {
    expect(await visibleMembers("ownerA", weddingB)).toEqual([]);
    expect(await visibleMembers("collabA", weddingB)).toEqual([]);
    expect(await visibleMembers("ownerB", weddingA)).toEqual([]);
  });

  it("outsider sees no memberships of weddings they don't belong to", async () => {
    expect(await visibleMembers("outsider", weddingA)).toEqual([]);
    expect(await visibleMembers("outsider", weddingB)).toEqual([]);
  });

  it("cross-wedding: owner A cannot change or remove members of B", async () => {
    await addMember(weddingB, "invitee", "collaborator");

    const { data: updated } = await updateRole("ownerA", weddingB, "invitee", "owner");
    expect(updated).toEqual([]);
    const { data: removed } = await removeMember("ownerA", weddingB, "invitee");
    expect(removed).toEqual([]);

    expect(await membershipRole(weddingB, "invitee")).toBe("collaborator");
    expect(await membershipRole(weddingB, "ownerB")).toBe("owner");
  });

  it("members cannot move a membership to another wedding or user", async () => {
    const { error } = await as.ownerA
      .from("wedding_memberships")
      .update({ wedding_id: weddingB })
      .eq("wedding_id", weddingA)
      .eq("user_id", users.collabA.id);
    expect(error?.code).toBe(PERMISSION_DENIED);

    const { error: userError } = await as.ownerA
      .from("wedding_memberships")
      .update({ user_id: users.outsider.id })
      .eq("wedding_id", weddingA)
      .eq("user_id", users.collabA.id);
    expect(userError?.code).toBe(PERMISSION_DENIED);
  });
});

describe("role escalation protection", () => {
  let wedding: string;

  beforeAll(async () => {
    wedding = await createWedding("ownerA");
    await addMember(wedding, "collabA", "collaborator");
    await addMember(wedding, "invitee", "collaborator");
  });

  it("collaborator cannot promote self to owner", async () => {
    const { data, error } = await updateRole("collabA", wedding, "collabA", "owner");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await membershipRole(wedding, "collabA")).toBe("collaborator");
  });

  it("collaborator cannot change another member's role", async () => {
    await updateRole("collabA", wedding, "invitee", "owner");
    await updateRole("collabA", wedding, "ownerA", "collaborator");
    expect(await membershipRole(wedding, "invitee")).toBe("collaborator");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("collaborator cannot create an owner membership", async () => {
    const { error } = await as.collabA
      .from("wedding_memberships")
      .insert({ wedding_id: wedding, user_id: users.outsider.id, role: "owner" });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await membershipRole(wedding, "outsider")).toBeNull();
  });

  it("collaborator cannot remove members (owner or collaborator)", async () => {
    const { data } = await removeMember("collabA", wedding, "ownerA");
    expect(data).toEqual([]);
    await removeMember("collabA", wedding, "invitee");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
    expect(await membershipRole(wedding, "invitee")).toBe("collaborator");
  });

  it("owner can promote a collaborator to owner and remove a collaborator", async () => {
    const { data, error } = await updateRole("ownerA", wedding, "collabA", "owner");
    expect(error).toBeNull();
    expect(data).toEqual([{ role: "owner" }]);

    const { data: removed } = await removeMember("ownerA", wedding, "invitee");
    expect(removed).toEqual([{ user_id: users.invitee.id }]);
    expect(await membershipRole(wedding, "invitee")).toBeNull();
  });
});

describe("final-owner invariant", () => {
  it("single owner: delete own membership -> DENIED", async () => {
    const wedding = await createWedding("ownerA");
    const { error } = await removeMember("ownerA", wedding, "ownerA");
    expect(error?.code).toBe(OWNER_REQUIRED);
    expect(error?.message).toBe("wedding_must_have_owner");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("single owner: demote self to collaborator -> DENIED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "collabA", "collaborator");
    const { error } = await updateRole("ownerA", wedding, "ownerA", "collaborator");
    expect(error?.code).toBe(OWNER_REQUIRED);
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("two owners: delete one -> ALLOWED, the other remains", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "ownerB", "owner");
    const { data, error } = await removeMember("ownerA", wedding, "ownerB");
    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: users.ownerB.id }]);
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("two owners: an owner may leave, leaving the other -> ALLOWED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "ownerB", "owner");
    const { error } = await removeMember("ownerA", wedding, "ownerA");
    expect(error).toBeNull();
    expect(await membershipRole(wedding, "ownerA")).toBeNull();
    expect(await membershipRole(wedding, "ownerB")).toBe("owner");
  });

  it("two owners: demote one -> ALLOWED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "ownerB", "owner");
    const { error } = await updateRole("ownerA", wedding, "ownerB", "collaborator");
    expect(error).toBeNull();
    expect(await membershipRole(wedding, "ownerB")).toBe("collaborator");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("two owners: removing both in one statement -> DENIED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "ownerB", "owner");
    const { error } = await as.ownerA
      .from("wedding_memberships")
      .delete()
      .eq("wedding_id", wedding)
      .eq("role", "owner");
    expect(error?.code).toBe(OWNER_REQUIRED);
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
    expect(await membershipRole(wedding, "ownerB")).toBe("owner");
  });

  it("collaborator demotes owner -> DENIED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "collabA", "collaborator");
    await updateRole("collabA", wedding, "ownerA", "collaborator");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("collaborator deletes owner -> DENIED", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "collabA", "collaborator");
    await removeMember("collabA", wedding, "ownerA");
    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
  });

  it("two owners demoting each other concurrently cannot leave zero owners", async () => {
    const wedding = await createWedding("ownerA");
    await addMember(wedding, "ownerB", "owner");

    // Two real transactions as the `authenticated` role, each owner demoting
    // the other. Without serialization both would see one remaining owner.
    const demote = async (actor: TestUserKey, target: TestUserKey) => {
      const conn = await superuser.connect();
      await conn.query("begin");
      await conn.query("set local role authenticated");
      await conn.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: users[actor].id, role: "authenticated" }),
      ]);
      return {
        run: () =>
          conn.query(
            "update public.wedding_memberships set role = 'collaborator' where wedding_id = $1 and user_id = $2",
            [wedding, users[target].id],
          ),
        finish: async (outcome: "commit" | "rollback") => {
          await conn.query(outcome);
          conn.release();
        },
      };
    };

    const first = await demote("ownerA", "ownerB");
    const second = await demote("ownerB", "ownerA");

    await first.run();
    const secondResult = second.run().then(
      () => "ok" as const,
      (error: { code?: string }) => error.code,
    );
    // Commit the first only once the second is provably waiting on the
    // wedding lock taken by the final-owner trigger.
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: number }>(
              `select count(*)::int as waiting from pg_stat_activity
               where wait_event_type = 'Lock' and query like 'update public.wedding_memberships%'`,
            )
          )[0]?.waiting,
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);
    await first.finish("commit");
    expect(await secondResult).toBe(OWNER_REQUIRED);
    await second.finish("rollback");

    expect(await membershipRole(wedding, "ownerA")).toBe("owner");
    expect(await membershipRole(wedding, "ownerB")).toBe("collaborator");
  });
});
