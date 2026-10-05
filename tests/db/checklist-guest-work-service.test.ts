import { createHash, randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import { addMember, as, createWedding as createFixtureWedding, ctx, shapedEnvelope, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { createChecklistItem, deleteChecklistItem, getWeddingChecklist, setChecklistItemGuestParty, setChecklistItemStatus } =
  await import("@/lib/checklist/service");
const { deleteGuestParty, listGuestParties, listGuestPartyOptions } = await import("@/lib/guests/service");

// LB-16 services (what the Server Actions and pages call) against the real
// local stack: identity from the real Auth server, authority from real
// memberships, RLS and the same-wedding FK underneath.

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

async function accessOf(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  return { supabase, access: access.access };
}

async function createParty(actor: TestUserKey, weddingId: string, label: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: ["Invitada"],
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return data;
}

async function newItem(weddingId: string, title: string): Promise<string> {
  const supabase = await sessionClient("ownerA");
  const created = await createChecklistItem(supabase, weddingId, {
    title,
    description: "Notas del pendiente",
    category: "invitations",
    timing: { mode: "relative_to_wedding", relativeDays: -30 },
  });
  expect(created).toEqual({ ok: true });
  const [row] = await sql<{ id: string }>(
    "select id from public.checklist_items where wedding_id = $1 and title = $2",
    [weddingId, title],
  );
  if (!row) throw new Error("item missing");
  return row.id;
}

/** The item's columns except the link itself and updated_at. */
async function contentOf(itemId: string) {
  const row = { ...(await rowOf(itemId)) };
  delete row.guest_invitation_id;
  delete row.updated_at;
  return row;
}

async function rowOf(itemId: string) {
  const [row] = await sql<Record<string, unknown>>("select * from public.checklist_items where id = $1", [itemId]);
  return row;
}

describe("checklist ↔ guest work services", () => {
  let weddingId: string;
  let otherWedding: string;
  let perez: string;
  let gomez: string;
  let foreign: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda servicios pendientes e invitados");
    await addMember(weddingId, "collabA", "collaborator");
    otherWedding = await fixtureWedding("ownerB", "Otra boda servicios pendientes e invitados");
    perez = await createParty("ownerA", weddingId, "Familia Pérez");
    gomez = await createParty("collabA", weddingId, "Familia Gómez");
    foreign = await createParty("ownerB", otherWedding, "Familia Ajena");
  });

  it("owner links, collaborator changes, owner unlinks; the checklist read follows", async () => {
    const itemId = await newItem(weddingId, "Transporte (servicio)");
    const owner = await sessionClient("ownerA");
    const collab = await sessionClient("collabA");

    expect(await setChecklistItemGuestParty(owner, weddingId, itemId, perez)).toEqual({ ok: true });
    const read = await accessOf("collabA", weddingId);
    const item = (await getWeddingChecklist(read.supabase, read.access))?.items.find((i) => i.id === itemId);
    expect(item?.guestInvitationId).toBe(perez);

    expect(await setChecklistItemGuestParty(collab, weddingId, itemId, gomez)).toEqual({ ok: true });
    // The same target again is fine (idempotent).
    expect(await setChecklistItemGuestParty(collab, weddingId, itemId, gomez)).toEqual({ ok: true });
    expect((await rowOf(itemId))?.guest_invitation_id).toBe(gomez);

    expect(await setChecklistItemGuestParty(owner, weddingId, itemId, null)).toEqual({ ok: true });
    expect((await rowOf(itemId))?.guest_invitation_id).toBeNull();
  });

  it("only the link moves: status, timing, content, order and assignee stay", async () => {
    const itemId = await newItem(weddingId, "Hecho (servicio)");
    const owner = await sessionClient("ownerA");
    expect(await setChecklistItemStatus(owner, weddingId, itemId, "done")).toEqual({ ok: true });
    const before = await contentOf(itemId);
    expect(before.status).toBe("done");
    for (const target of [perez, gomez, null]) {
      expect(await setChecklistItemGuestParty(owner, weddingId, itemId, target)).toEqual({ ok: true });
      expect(await contentOf(itemId)).toEqual(before);
    }
  });

  it("a party of another wedding, an unknown id and a malformed id are all invalid_guest_party", async () => {
    const itemId = await newItem(weddingId, "Forjado (servicio)");
    const owner = await sessionClient("ownerA");
    for (const target of [foreign, "00000000-0000-4000-8000-000000000000", "https://example.test/rsvp/x"]) {
      expect(await setChecklistItemGuestParty(owner, weddingId, itemId, target)).toEqual({
        ok: false,
        reason: "invalid_guest_party",
      });
    }
    expect((await rowOf(itemId))?.guest_invitation_id).toBeNull();
  });

  it("an item of another wedding, a missing item and a malformed item id are item_not_found", async () => {
    const owner = await sessionClient("ownerA");
    const ownerB = await sessionClient("ownerB");
    const theirs = await (async () => {
      const created = await createChecklistItem(ownerB, otherWedding, {
        title: "De la otra boda",
        description: null,
        category: null,
        timing: { mode: "none" },
      });
      expect(created).toEqual({ ok: true });
      const [row] = await sql<{ id: string }>("select id from public.checklist_items where wedding_id = $1", [otherWedding]);
      return row?.id ?? "";
    })();
    // Their item through MY wedding: scoped away, nothing written.
    expect(await setChecklistItemGuestParty(owner, weddingId, theirs, perez)).toEqual({
      ok: false,
      reason: "item_not_found",
    });
    expect(
      await setChecklistItemGuestParty(owner, weddingId, "00000000-0000-4000-8000-000000000000", perez),
    ).toEqual({ ok: false, reason: "item_not_found" });
    expect(await setChecklistItemGuestParty(owner, weddingId, "nope", perez)).toEqual({
      ok: false,
      reason: "item_not_found",
    });
    expect((await rowOf(theirs))?.guest_invitation_id).toBeNull();
  });

  it("an outsider and another wedding's owner get not_found and change nothing", async () => {
    const itemId = await newItem(weddingId, "Ajeno (servicio)");
    for (const user of ["outsider", "ownerB"] as const) {
      const client = await sessionClient(user);
      expect(await setChecklistItemGuestParty(client, weddingId, itemId, perez)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
    expect((await rowOf(itemId))?.guest_invitation_id).toBeNull();
  });

  it("party options are id + label only, of this wedding only", async () => {
    const { supabase, access } = await accessOf("collabA", weddingId);
    const options = await listGuestPartyOptions(supabase, access);
    expect(options).toEqual([
      { id: perez, label: "Familia Pérez" },
      { id: gomez, label: "Familia Gómez" },
    ]);
  });

  it("the guest list shows each party's related items (id, title, status) in checklist order", async () => {
    const first = await newItem(weddingId, "Relacionado 1");
    const second = await newItem(weddingId, "Relacionado 2");
    const owner = await sessionClient("ownerA");
    await setChecklistItemGuestParty(owner, weddingId, second, perez);
    await setChecklistItemGuestParty(owner, weddingId, first, perez);
    await setChecklistItemStatus(owner, weddingId, second, "not_applicable");

    const { supabase, access } = await accessOf("collabA", weddingId);
    const parties = await listGuestParties(supabase, access);
    const party = parties?.find((p) => p.id === perez);
    expect(party?.relatedChecklistItems).toEqual([
      { id: first, title: "Relacionado 1", status: "pending" },
      { id: second, title: "Relacionado 2", status: "not_applicable" },
    ]);
    expect(parties?.find((p) => p.id === gomez)?.relatedChecklistItems).toEqual([]);
    // Nothing else of the item crosses over (no description, assignee or timing).
    expect(JSON.stringify(party?.relatedChecklistItems)).not.toContain("Notas del pendiente");
  });

  it("deleting the party through the service unlinks; deleting the item leaves the party", async () => {
    const party = await createParty("ownerA", weddingId, "Familia Temporal");
    const itemId = await newItem(weddingId, "Sobrevive al grupo");
    const collab = await sessionClient("collabA");
    await setChecklistItemGuestParty(collab, weddingId, itemId, party);
    await setChecklistItemStatus(collab, weddingId, itemId, "done");

    expect(await deleteGuestParty(collab, weddingId, party)).toEqual({ ok: true });
    const row = await rowOf(itemId);
    expect(row).toMatchObject({ guest_invitation_id: null, status: "done", title: "Sobrevive al grupo" });
    const { supabase, access } = await accessOf("ownerA", weddingId);
    const item = (await getWeddingChecklist(supabase, access))?.items.find((i) => i.id === itemId);
    expect(item?.guestInvitationId).toBeNull();

    const kept = await createParty("ownerA", weddingId, "Familia Que Queda");
    const doomed = await newItem(weddingId, "Se borra el pendiente");
    await setChecklistItemGuestParty(collab, weddingId, doomed, kept);
    expect(await deleteChecklistItem(collab, weddingId, doomed)).toEqual({ ok: true });
    expect(await sql("select id from public.guest_invitations where id = $1", [kept])).toEqual([{ id: kept }]);
  });
});
