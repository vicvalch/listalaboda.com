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
  setChecklistItemStatus,
  updateChecklistItem,
} = await import("@/lib/checklist/service");

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
