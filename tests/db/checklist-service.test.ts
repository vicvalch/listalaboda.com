import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const {
  createChecklistItem,
  deleteChecklistItem,
  getWeddingChecklist,
  initializeWeddingChecklist,
  setChecklistItemAssignee,
  setChecklistItemStatus,
  updateChecklistItem,
} = await import("@/lib/checklist/service");
const { listWeddingMembers, updateMyDisplayName } = await import("@/lib/weddings/service");

// LB-05 checklist services (what the Server Actions call) against the real
// local stack: identity from the real Auth server, authority from real
// memberships, RLS underneath.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

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

async function checklistOf(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  const checklist = await getWeddingChecklist(supabase, access.access);
  if (!checklist) throw new Error("checklist failed to load");
  return checklist;
}

const customInput = {
  title: "Reservar el ensayo",
  description: null,
  category: "ceremony" as const,
  timing: { mode: "relative_to_wedding" as const, relativeDays: -2 },
};

describe("checklist services", () => {
  let weddingId: string;
  let otherWedding: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda del servicio de lista");
    await addMember(weddingId, "collabA", "collaborator");
    otherWedding = await fixtureWedding("ownerB", "Otra boda del servicio");
  });

  it("an uninitialized wedding has an empty, not-initialized checklist", async () => {
    const checklist = await checklistOf("ownerA", weddingId);
    expect(checklist).toEqual({ initialized: false, items: [] });
  });

  it("a collaborator can't initialize; nothing changes", async () => {
    const result = await initializeWeddingChecklist(await sessionClient("collabA"), weddingId);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect((await checklistOf("ownerA", weddingId)).initialized).toBe(false);
  });

  it("an outsider gets not_found", async () => {
    const result = await initializeWeddingChecklist(await sessionClient("outsider"), weddingId);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("the owner initializes once; the list comes back in template order", async () => {
    const supabase = await sessionClient("ownerA");
    expect(await initializeWeddingChecklist(supabase, weddingId)).toEqual({
      ok: true,
      alreadyInitialized: false,
      itemCount: 38,
    });
    expect(await initializeWeddingChecklist(supabase, weddingId)).toEqual({
      ok: true,
      alreadyInitialized: true,
      itemCount: 0,
    });

    const checklist = await checklistOf("collabA", weddingId);
    expect(checklist.initialized).toBe(true);
    expect(checklist.items).toHaveLength(38);
    const orders = checklist.items.map((item) => item.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(checklist.items[0]).toMatchObject({
      title: "Definir el presupuesto aproximado",
      category: "first_steps",
      status: "pending",
      timing: { mode: "relative_to_wedding", relativeDays: -365 },
    });
  });

  it("a collaborator adds, edits, completes and deletes a custom item", async () => {
    const supabase = await sessionClient("collabA");
    expect(await createChecklistItem(supabase, weddingId, customInput)).toEqual({ ok: true });

    let items = (await checklistOf("ownerA", weddingId)).items;
    const created = items.at(-1);
    expect(created).toMatchObject({
      title: "Reservar el ensayo",
      category: "ceremony",
      status: "pending",
      timing: { mode: "relative_to_wedding", relativeDays: -2 },
    });
    const itemId = created?.id ?? "";

    expect(
      await updateChecklistItem(supabase, weddingId, itemId, {
        ...customInput,
        title: "Reservar el ensayo general",
        category: null,
        timing: { mode: "absolute", dueDate: "2027-05-30" },
      }),
    ).toEqual({ ok: true });
    expect(await setChecklistItemStatus(supabase, weddingId, itemId, "done")).toEqual({ ok: true });

    items = (await checklistOf("ownerA", weddingId)).items;
    expect(items.find((item) => item.id === itemId)).toMatchObject({
      title: "Reservar el ensayo general",
      category: null,
      status: "done",
      timing: { mode: "absolute", dueDate: "2027-05-30" },
    });

    expect(await deleteChecklistItem(supabase, weddingId, itemId)).toEqual({ ok: true });
    items = (await checklistOf("ownerA", weddingId)).items;
    expect(items.some((item) => item.id === itemId)).toBe(false);
    // Deleting again: the wedding is fine, the item is gone.
    expect(await deleteChecklistItem(supabase, weddingId, itemId)).toEqual({
      ok: false,
      reason: "item_not_found",
    });
  });

  it("an item id from another wedding is never touched through this wedding", async () => {
    await initializeWeddingChecklist(await sessionClient("ownerB"), otherWedding);
    const foreignItem = (await checklistOf("ownerB", otherWedding)).items[0];

    // Owner A passes their own wedding id with wedding B's item id.
    const supabase = await sessionClient("ownerA");
    expect(await setChecklistItemStatus(supabase, weddingId, foreignItem.id, "done")).toEqual({
      ok: false,
      reason: "item_not_found",
    });
    expect(await deleteChecklistItem(supabase, weddingId, foreignItem.id)).toEqual({
      ok: false,
      reason: "item_not_found",
    });
    // And wedding B's id directly: not a member, so not_found (404).
    expect(await setChecklistItemStatus(supabase, otherWedding, foreignItem.id, "done")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await createChecklistItem(supabase, otherWedding, customInput)).toEqual({
      ok: false,
      reason: "not_found",
    });

    const [row] = await sql<{ status: string }>(
      "select status from public.checklist_items where id = $1",
      [foreignItem.id],
    );
    expect(row?.status).toBe("pending");
  });

  it("malformed ids fail closed without touching anything", async () => {
    const supabase = await sessionClient("ownerA");
    expect(await setChecklistItemStatus(supabase, weddingId, "not-a-uuid", "done")).toEqual({
      ok: false,
      reason: "item_not_found",
    });
    expect(await createChecklistItem(supabase, "not-a-uuid", customInput)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("values the database rejects come back as invalid, not as an error", async () => {
    const supabase = await sessionClient("ownerA");
    const result = await createChecklistItem(supabase, weddingId, {
      ...customInput,
      timing: { mode: "relative_to_wedding", relativeDays: 5000 },
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

// LB-07: assignment and display-name services against the real stack.
describe("assignment services", () => {
  let weddingId: string;
  let otherWedding: string;
  let itemId: string;
  let ownerMembership: string;
  let collabMembership: string;
  let foreignMembership: string;

  async function membershipOf(wedding: string, user: TestUserKey): Promise<string> {
    const [row] = await sql<{ id: string }>(
      "select id from public.wedding_memberships where wedding_id = $1 and user_id = $2",
      [wedding, users[user].id],
    );
    if (!row) throw new Error("membership missing");
    return row.id;
  }

  async function assigneeOf(id: string): Promise<string | null> {
    const [row] = await sql<{ assignee_membership_id: string | null }>(
      "select assignee_membership_id from public.checklist_items where id = $1",
      [id],
    );
    return row?.assignee_membership_id ?? null;
  }

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda de responsables (servicio)");
    await addMember(weddingId, "collabA", "collaborator");
    otherWedding = await fixtureWedding("ownerB", "Otra boda de responsables (servicio)");
    ownerMembership = await membershipOf(weddingId, "ownerA");
    collabMembership = await membershipOf(weddingId, "collabA");
    foreignMembership = await membershipOf(otherWedding, "ownerB");

    const supabase = await sessionClient("ownerA");
    expect(await createChecklistItem(supabase, weddingId, customInput)).toEqual({ ok: true });
    const items = (await checklistOf("ownerA", weddingId)).items;
    itemId = items[0]?.id ?? "";
    expect(items[0]?.assigneeMembershipId).toBeNull();
  });

  it("owner → self, owner → collaborator; the checklist read reflects it", async () => {
    const owner = await sessionClient("ownerA");
    expect(await setChecklistItemAssignee(owner, weddingId, itemId, ownerMembership)).toEqual({
      ok: true,
    });
    expect(await assigneeOf(itemId)).toBe(ownerMembership);

    expect(await setChecklistItemAssignee(owner, weddingId, itemId, collabMembership)).toEqual({
      ok: true,
    });
    const item = (await checklistOf("collabA", weddingId)).items.find((i) => i.id === itemId);
    expect(item?.assigneeMembershipId).toBe(collabMembership);
  });

  it("collaborator → self, collaborator → owner, then unassign", async () => {
    const collab = await sessionClient("collabA");
    for (const target of [collabMembership, ownerMembership, null]) {
      expect(await setChecklistItemAssignee(collab, weddingId, itemId, target)).toEqual({ ok: true });
      expect(await assigneeOf(itemId)).toBe(target);
    }
  });

  it("a membership of another wedding is invalid_assignee and changes nothing", async () => {
    const owner = await sessionClient("ownerA");
    await setChecklistItemAssignee(owner, weddingId, itemId, collabMembership);
    expect(await setChecklistItemAssignee(owner, weddingId, itemId, foreignMembership)).toEqual({
      ok: false,
      reason: "invalid_assignee",
    });
    expect(
      await setChecklistItemAssignee(owner, weddingId, itemId, crypto.randomUUID()),
    ).toEqual({ ok: false, reason: "invalid_assignee" });
    expect(await assigneeOf(itemId)).toBe(collabMembership);
  });

  it("an item of another wedding is item_not_found; an outsider gets not_found", async () => {
    const owner = await sessionClient("ownerA");
    expect(
      await setChecklistItemAssignee(owner, weddingId, crypto.randomUUID(), ownerMembership),
    ).toEqual({ ok: false, reason: "item_not_found" });

    const outsider = await sessionClient("outsider");
    expect(await setChecklistItemAssignee(outsider, weddingId, itemId, null)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await assigneeOf(itemId)).toBe(collabMembership);
  });

  it("members are listed with safe fields; the caller is resolved server-side", async () => {
    const supabase = await sessionClient("collabA");
    const access = await requireWeddingMembership(supabase, weddingId);
    if (!access.ok) throw new Error("no access");
    expect(access.access.membershipId).toBe(collabMembership);

    const members = await listWeddingMembers(supabase, access.access);
    expect(members?.map((m) => [m.membershipId, m.role, m.isCurrentUser]).sort()).toEqual(
      [
        [ownerMembership, "owner", false],
        [collabMembership, "collaborator", true],
      ].sort(),
    );
    expect(JSON.stringify(members)).not.toContain(users.collabA.id);
    expect(JSON.stringify(members)).not.toContain(users.collabA.email);
  });

  it("each member sets only their own display name", async () => {
    const collab = await sessionClient("collabA");
    expect(await updateMyDisplayName(collab, weddingId, "Sofía")).toEqual({
      ok: true,
      displayName: "Sofía",
    });
    const owner = await sessionClient("ownerA");
    expect(await updateMyDisplayName(owner, weddingId, "Victor")).toEqual({
      ok: true,
      displayName: "Victor",
    });
    const names = await sql<{ id: string; display_name: string | null }>(
      "select id, display_name from public.wedding_memberships where wedding_id = $1",
      [weddingId],
    );
    expect(Object.fromEntries(names.map((n) => [n.id, n.display_name]))).toEqual({
      [ownerMembership]: "Victor",
      [collabMembership]: "Sofía",
    });

    expect(await updateMyDisplayName(collab, weddingId, null)).toEqual({
      ok: true,
      displayName: null,
    });
    expect(await updateMyDisplayName(collab, weddingId, "x".repeat(81))).toEqual({
      ok: false,
      reason: "invalid",
    });
    const outsider = await sessionClient("outsider");
    expect(await updateMyDisplayName(outsider, weddingId, "Intrusa")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
