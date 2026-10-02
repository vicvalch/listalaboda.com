import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  ctx,
  membershipRole,
  sql,
  users,
} from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { getWeddingChecklist } = await import("@/lib/checklist/service");
const { removeWeddingMember } = await import("@/lib/weddings/service");

// LB-08: owner-only removal of a current member (Constitution §3, §7.12),
// through the real service (what the Server Action calls) and the real
// Data API. Removal deletes ONE wedding_memberships row: never the auth
// user, their other memberships or checklist items. The superuser
// connection only arranges fixtures and reads ground truth.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

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

async function membershipId(weddingId: string, user: TestUserKey): Promise<string> {
  const rows = await sql<{ id: string }>(
    "select id from public.wedding_memberships where wedding_id = $1 and user_id = $2",
    [weddingId, users[user].id],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no membership for ${user}`);
  return id;
}

/** A wedding owned by ownerA with collabA as collaborator. */
async function weddingWithCollaborator(name: string) {
  const weddingId = await fixtureWedding("ownerA", name);
  await addMember(weddingId, "collabA", "collaborator");
  return {
    weddingId,
    owner: await membershipId(weddingId, "ownerA"),
    collab: await membershipId(weddingId, "collabA"),
  };
}

type ItemState = {
  id: string;
  wedding_id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  timing_mode: string;
  relative_days: number | null;
  due_date: string | null;
  sort_order: number;
  assignee_membership_id: string | null;
};

async function itemState(itemId: string): Promise<ItemState | undefined> {
  const rows = await sql<ItemState>(
    `select id, wedding_id, title, description, category::text, status::text,
            completed_at::text, completed_by, created_by, timing_mode::text, relative_days,
            due_date::text, sort_order, assignee_membership_id
     from public.checklist_items where id = $1`,
    [itemId],
  );
  return rows[0];
}

async function memberCount(weddingId: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    "select count(*)::int as n from public.wedding_memberships where wedding_id = $1",
    [weddingId],
  );
  return rows[0]?.n ?? 0;
}

async function authUserExists(user: TestUserKey): Promise<boolean> {
  const rows = await sql("select 1 from auth.users where id = $1", [users[user].id]);
  return rows.length === 1;
}

// ------------------------------------------------------------ service

describe("removeWeddingMember", () => {
  it("owner removes a collaborator: only that membership is deleted", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda que quita a alguien");
    // The collaborator's other wedding must survive.
    const otherWedding = await fixtureWedding("ownerB", "Otra boda del colaborador");
    await addMember(otherWedding, "collabA", "collaborator");

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, collab)).toEqual({
      ok: true,
    });

    expect(await membershipRole(weddingId, "collabA")).toBeNull();
    expect(await membershipRole(weddingId, "ownerA")).toBe("owner");
    expect(await membershipRole(otherWedding, "collabA")).toBe("collaborator");
    expect(await authUserExists("collabA")).toBe(true);
  });

  it("owner removes another owner when one owner remains", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda con dos organizadores");
    await addMember(weddingId, "invitee", "owner");
    const coOwner = await membershipId(weddingId, "invitee");

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, coOwner)).toEqual({
      ok: true,
    });
    expect(await membershipRole(weddingId, "invitee")).toBeNull();
    expect(await membershipRole(weddingId, "ownerA")).toBe("owner");
  });

  it("the caller can't target their own membership (no 'leave wedding' here), even with a co-owner", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda sin autoexpulsión");
    await addMember(weddingId, "invitee", "owner");
    const self = await membershipId(weddingId, "ownerA");

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, self)).toEqual({
      ok: false,
      reason: "cannot_remove_self",
    });
    // Also with different casing of the same id.
    expect(
      await removeWeddingMember(await sessionClient("ownerA"), weddingId, self.toUpperCase()),
    ).toEqual({ ok: false, reason: "cannot_remove_self" });
    expect(await membershipRole(weddingId, "ownerA")).toBe("owner");
  });

  it("a collaborator is forbidden from removing anyone; nothing changes", async () => {
    const { weddingId, owner } = await weddingWithCollaborator("Boda con colaborador sin poder");
    await addMember(weddingId, "invitee", "collaborator");
    const other = await membershipId(weddingId, "invitee");
    const collab = await sessionClient("collabA");

    for (const target of [owner, other]) {
      expect(await removeWeddingMember(collab, weddingId, target)).toEqual({
        ok: false,
        reason: "forbidden",
      });
    }
    expect(await memberCount(weddingId)).toBe(3);
  });

  it("an outsider gets not_found (no disclosure); nothing changes", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda vista desde afuera");
    expect(await removeWeddingMember(await sessionClient("outsider"), weddingId, collab)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await memberCount(weddingId)).toBe(2);
  });

  it("anonymous callers are unauthenticated; nothing changes", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda sin sesión");
    expect(await removeWeddingMember(await sessionClient(null), weddingId, collab)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(await memberCount(weddingId)).toBe(2);
  });

  it("cross-wedding: owner A can't remove a member of wedding B through wedding A", async () => {
    const weddingA = await fixtureWedding("ownerA", "Boda A de la prueba cruzada");
    const weddingB = await fixtureWedding("ownerB", "Boda B de la prueba cruzada");
    await addMember(weddingB, "collabA", "collaborator");
    const memberOfB = await membershipId(weddingB, "collabA");
    const ownerOfB = await membershipId(weddingB, "ownerB");
    const ownerA = await sessionClient("ownerA");

    // Same answer as an id that doesn't exist at all: nothing about B leaks.
    for (const target of [memberOfB, ownerOfB, "00000000-0000-4000-8000-000000000000"]) {
      expect(await removeWeddingMember(ownerA, weddingA, target)).toEqual({
        ok: false,
        reason: "invalid_target",
      });
    }
    // And through wedding B itself owner A is not a member: not_found.
    expect(await removeWeddingMember(ownerA, weddingB, memberOfB)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await memberCount(weddingB)).toBe(2);
  });

  it("malformed and already-removed targets are invalid_target", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda con ids raros");
    const ownerA = await sessionClient("ownerA");
    for (const target of ["", "not-a-uuid", "'; delete from wedding_memberships; --"]) {
      expect(await removeWeddingMember(ownerA, weddingId, target)).toEqual({
        ok: false,
        reason: "invalid_target",
      });
    }
    expect(await removeWeddingMember(ownerA, weddingId, collab)).toEqual({ ok: true });
    expect(await removeWeddingMember(ownerA, weddingId, collab)).toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("doesn't create, change or revoke invites", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda con invitaciones intactas");
    const { error } = await as.ownerA.from("membership_invites").insert({
      wedding_id: weddingId,
      token_hash: "a".repeat(64),
      intended_role: "collaborator",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(error).toBeNull();
    const before = await sql("select * from public.membership_invites where wedding_id = $1", [weddingId]);

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, collab)).toEqual({
      ok: true,
    });
    expect(await sql("select * from public.membership_invites where wedding_id = $1", [weddingId])).toEqual(
      before,
    );
  });
});

// --------------------------------------------- assignment cleanup and access

describe("after removal", () => {
  it("assigned items stay, unchanged except the assignee (now NULL)", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda con pendientes asignados");
    const insert = await as.collabA
      .from("checklist_items")
      .insert({
        wedding_id: weddingId,
        title: "Confirmar fotógrafo",
        description: "Llamar el lunes",
        category: "vendors",
        timing_mode: "absolute",
        due_date: "2027-03-01",
      })
      .select("id")
      .single();
    if (insert.error || !insert.data) throw new Error(insert.error?.message);
    const itemId = insert.data.id;
    const done = await as.collabA
      .from("checklist_items")
      .insert({ wedding_id: weddingId, title: "Reservar transporte", timing_mode: "none" })
      .select("id")
      .single();
    if (done.error || !done.data) throw new Error(done.error?.message);
    const doneId = done.data.id;

    for (const id of [itemId, doneId]) {
      const { error } = await as.ownerA
        .from("checklist_items")
        .update({ assignee_membership_id: collab })
        .eq("id", id);
      expect(error).toBeNull();
    }
    await as.collabA.from("checklist_items").update({ status: "done" }).eq("id", doneId);

    const before = [await itemState(itemId), await itemState(doneId)];
    expect(before.map((item) => item?.assignee_membership_id)).toEqual([collab, collab]);
    expect(before[1]?.completed_by).toBe(users.collabA.id);

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, collab)).toEqual({
      ok: true,
    });

    const after = [await itemState(itemId), await itemState(doneId)];
    expect(after).toEqual(before.map((item) => item && { ...item, assignee_membership_id: null }));
    // Provenance stays as it was: created_by / completed_by are not authority.
    expect(after[0]?.created_by).toBe(users.collabA.id);
    expect(after[1]?.completed_by).toBe(users.collabA.id);
  });

  it("the removed member loses access to this wedding but keeps their session", async () => {
    const { weddingId, collab } = await weddingWithCollaborator("Boda que deja de ver");
    const collabSession = await sessionClient("collabA");

    const before = await requireWeddingMembership(collabSession, weddingId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(await getWeddingChecklist(collabSession, before.access)).not.toBeNull();

    expect(await removeWeddingMember(await sessionClient("ownerA"), weddingId, collab)).toEqual({
      ok: true,
    });

    // Same session, same token: identity is fine, wedding access is gone.
    const { data: user } = await collabSession.auth.getUser();
    expect(user.user?.id).toBe(users.collabA.id);
    expect(await requireWeddingMembership(collabSession, weddingId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    const wedding = await collabSession.from("weddings").select("id").eq("id", weddingId);
    expect(wedding.data).toEqual([]);
    const items = await collabSession.from("checklist_items").select("id").eq("wedding_id", weddingId);
    expect(items.data).toEqual([]);
  });
});

// ------------------------------------------------------ database boundary

describe("membership deletion at the database boundary", () => {
  it("the final owner can never be removed, whoever asks", async () => {
    const { weddingId, owner } = await weddingWithCollaborator("Boda con una sola organizadora");

    // The owner themself (the service refuses earlier; the database too).
    const self = await as.ownerA.from("wedding_memberships").delete().eq("id", owner).select("id");
    expect(self.error?.code).toBe("23514");
    expect(self.error?.message).toBe("wedding_must_have_owner");

    // A collaborator: RLS filters the row before the trigger is reached.
    const collab = await as.collabA.from("wedding_memberships").delete().eq("id", owner).select("id");
    expect(collab.data ?? []).toEqual([]);

    // Even a superuser delete keeps the invariant.
    await expect(
      sql("delete from public.wedding_memberships where id = $1", [owner]),
    ).rejects.toThrow(/wedding_must_have_owner/);
    expect(await membershipRole(weddingId, "ownerA")).toBe("owner");
  });

  it("an owner can't remove every owner at once (co-owner and self in one statement)", async () => {
    // The final-owner trigger sees the statement's final state.
    const weddingId = await fixtureWedding("ownerA", "Boda de carrera de organizadores");
    await addMember(weddingId, "invitee", "owner");
    const both = await as.ownerA
      .from("wedding_memberships")
      .delete()
      .eq("wedding_id", weddingId)
      .select("id");
    expect(both.error?.code).toBe("23514");
    expect(await memberCount(weddingId)).toBe(2);
  });

  it("collaborators, outsiders and anonymous callers can't delete memberships directly", async () => {
    const { weddingId, owner, collab } = await weddingWithCollaborator("Boda blindada");
    for (const actor of ["collabA", "outsider", "ownerB"] as const) {
      for (const target of [owner, collab]) {
        const { data } = await as[actor].from("wedding_memberships").delete().eq("id", target).select("id");
        expect(data ?? [], `${actor}`).toEqual([]);
      }
    }
    const anon = await as.anon.from("wedding_memberships").delete().eq("id", collab);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
    expect(await memberCount(weddingId)).toBe(2);
  });
});
