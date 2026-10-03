import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const {
  addGuest,
  createGuestParty,
  deleteGuestParty,
  listGuestParties,
  removeGuest,
  revokeGuestPartyLink,
  rotateGuestPartyLink,
  updateGuestName,
  updateGuestPartyLabel,
} = await import("@/lib/guests/service");
const { getGuestPartyByToken, submitGuestRsvp } = await import("@/lib/rsvp/service");

// LB-09 services (what the Server Actions call) against the real local
// stack: organizer identity from the real Auth server, authority from real
// memberships, RLS underneath; guests as plain anon clients holding a link.

const ORIGIN = "http://localhost:3100";
const LINK = /^http:\/\/localhost:3100\/rsvp\/([A-Za-z0-9_-]{43})$/;

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

/** A guest's client: no session at all. */
function guestClient() {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function tokenOf(link: string): string {
  const token = LINK.exec(link)?.[1];
  if (!token) throw new Error("unexpected link shape (value redacted)");
  return token;
}

async function partiesOf(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  const parties = await listGuestParties(supabase, access.access);
  if (!parties) throw new Error("guest list failed to load");
  return parties;
}

async function newParty(user: TestUserKey, weddingId: string, label: string, guestNames: string[]) {
  const result = await createGuestParty(await sessionClient(user), weddingId, { label, guestNames }, ORIGIN);
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  const party = (await partiesOf(user, weddingId)).find((p) => p.id === result.guestInvitationId);
  if (!party) throw new Error("party not listed");
  return { ...result, token: tokenOf(result.link), party };
}

describe("organizer guest services", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda servicio invitados A");
    weddingB = await fixtureWedding("ownerB", "Boda servicio invitados B");
    await addMember(weddingA, "collabA", "collaborator");
  });

  it("creates a party with its guests and returns a working link once; only the hash is stored", async () => {
    const created = await newParty("ownerA", weddingA, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
    expect(created.party.guests.map((g) => [g.name, g.rsvp])).toEqual([
      ["Ana Pérez", null],
      ["Carlos Pérez", null],
    ]);
    const stored = await sql<{ token_hash: string }>(
      "select token_hash from public.guest_invitations where id = $1",
      [created.guestInvitationId],
    );
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.token_hash).not.toContain(created.token);
    const dump = JSON.stringify(
      await sql("select * from public.guest_invitations where id = $1", [created.guestInvitationId]),
    );
    expect(dump).not.toContain(created.token);

    const guest = await getGuestPartyByToken(guestClient(), created.token);
    expect(guest.ok && guest.party.label).toBe("Familia Pérez");
  });

  it("collaborators manage content and read RSVPs; only owners rotate or revoke", async () => {
    const supabase = await sessionClient("collabA");
    const created = await newParty("collabA", weddingA, "Amigos", ["Uno", "Dos"]);
    const id = created.guestInvitationId;
    expect(await updateGuestPartyLabel(supabase, weddingA, id, "Amigos de la uni")).toEqual({ ok: true });
    expect(await addGuest(supabase, weddingA, id, "Tres")).toEqual({ ok: true });
    expect(await updateGuestName(supabase, weddingA, created.party.guests[0].id, "Uno bis")).toEqual({ ok: true });
    expect(await removeGuest(supabase, weddingA, created.party.guests[1].id)).toEqual({ ok: true });

    // The collaborator's initial link works; they read the answers.
    const guests = (await partiesOf("collabA", weddingA)).find((p) => p.id === id)?.guests ?? [];
    const answered = await submitGuestRsvp(
      guestClient(),
      created.token,
      guests.map((g) => ({ guestId: g.id, attending: true, dietaryNote: null })),
    );
    expect(answered.ok).toBe(true);
    const seen = (await partiesOf("collabA", weddingA)).find((p) => p.id === id);
    expect(seen?.guests.map((g) => g.rsvp?.attending)).toEqual([true, true]);

    // Link administration is owner-only, and nothing changes.
    expect(await rotateGuestPartyLink(supabase, weddingA, id, ORIGIN)).toEqual({ ok: false, reason: "forbidden" });
    expect(await revokeGuestPartyLink(supabase, weddingA, id)).toEqual({ ok: false, reason: "forbidden" });
    expect((await getGuestPartyByToken(guestClient(), created.token)).ok).toBe(true);

    const owner = await sessionClient("ownerA");
    const rotated = await rotateGuestPartyLink(owner, weddingA, id, ORIGIN);
    expect(rotated.ok).toBe(true);
    expect(await revokeGuestPartyLink(owner, weddingA, id)).toEqual({ ok: true });
    // Revoking again is a calm no-op.
    expect(await revokeGuestPartyLink(owner, weddingA, id)).toEqual({ ok: true });

    const party = (await partiesOf("ownerA", weddingA)).find((p) => p.id === id);
    expect(party?.label).toBe("Amigos de la uni");
    expect(party?.guests.map((g) => g.name)).toEqual(["Uno bis", "Tres"]);
    expect(party?.revokedAt).not.toBeNull();

    expect(await deleteGuestParty(supabase, weddingA, id)).toEqual({ ok: true });
    expect((await partiesOf("ownerA", weddingA)).some((p) => p.id === id)).toBe(false);
  });

  it("outsiders get not_found for every operation, and nothing changes", async () => {
    const created = await newParty("ownerA", weddingA, "Protegido", ["Paz", "Pía"]);
    const supabase = await sessionClient("outsider");
    const id = created.guestInvitationId;
    const guestId = created.party.guests[0].id;
    const results = [
      await createGuestParty(supabase, weddingA, { label: "X", guestNames: ["X"] }, ORIGIN),
      await updateGuestPartyLabel(supabase, weddingA, id, "Hackeado"),
      await deleteGuestParty(supabase, weddingA, id),
      await addGuest(supabase, weddingA, id, "Colado"),
      await updateGuestName(supabase, weddingA, guestId, "Hackeado"),
      await removeGuest(supabase, weddingA, guestId),
      await rotateGuestPartyLink(supabase, weddingA, id, ORIGIN),
      await revokeGuestPartyLink(supabase, weddingA, id),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, reason: "not_found" });
    // Even a forged access object can't list it: RLS returns nothing.
    const forgedAccess = { weddingId: weddingA, userId: users.outsider.id, membershipId: guestId, role: "owner" as const };
    expect(await listGuestParties(supabase, forgedAccess)).toEqual([]);

    const party = (await partiesOf("ownerA", weddingA)).find((p) => p.id === id);
    expect(party?.label).toBe("Protegido");
    expect(party?.guests).toHaveLength(2);
    expect(party?.revokedAt).toBeNull();
    expect((await getGuestPartyByToken(guestClient(), created.token)).ok).toBe(true);
  });

  it("organizer A can't touch wedding B's party through A's wedding (invalid_target)", async () => {
    const foreign = await newParty("ownerB", weddingB, "Ajeno", ["Ajeno"]);
    const supabase = await sessionClient("ownerA");
    const id = foreign.guestInvitationId;
    const guestId = foreign.party.guests[0].id;
    for (const result of [
      await updateGuestPartyLabel(supabase, weddingA, id, "Cruzado"),
      await deleteGuestParty(supabase, weddingA, id),
      await addGuest(supabase, weddingA, id, "Cruzado"),
      await updateGuestName(supabase, weddingA, guestId, "Cruzado"),
      await removeGuest(supabase, weddingA, guestId),
      await rotateGuestPartyLink(supabase, weddingA, id, ORIGIN),
      await revokeGuestPartyLink(supabase, weddingA, id),
    ]) {
      expect(result).toEqual({ ok: false, reason: "invalid_target" });
    }
    // And through B's id, A isn't a member at all.
    expect(await updateGuestPartyLabel(supabase, weddingB, id, "Cruzado")).toEqual({
      ok: false,
      reason: "not_found",
    });
    const party = (await partiesOf("ownerB", weddingB)).find((p) => p.id === id);
    expect(party?.label).toBe("Ajeno");
    expect(party?.guests.map((g) => g.name)).toEqual(["Ajeno"]);
    expect((await getGuestPartyByToken(guestClient(), foreign.token)).ok).toBe(true);
  });

  it("maps party rules to clear reasons", async () => {
    const supabase = await sessionClient("ownerA");
    const solo = await newParty("ownerA", weddingA, "Solo", ["Única"]);
    expect(await removeGuest(supabase, weddingA, solo.party.guests[0].id)).toEqual({
      ok: false,
      reason: "last_guest",
    });
    // No fixed maximum party size.
    const large = await newParty(
      "ownerA",
      weddingA,
      "Grande",
      Array.from({ length: 24 }, (_, i) => `Persona ${i + 1}`),
    );
    expect(await addGuest(supabase, weddingA, large.guestInvitationId, "Persona 25")).toEqual({ ok: true });
    expect(await addGuest(supabase, weddingA, "not-a-uuid", "X")).toEqual({ ok: false, reason: "invalid_target" });
    expect(await addGuest(supabase, weddingA, crypto.randomUUID(), "X")).toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("rotation keeps the party, guests and RSVPs; the old link stops working", async () => {
    const created = await newParty("ownerA", weddingA, "Rotación", ["Ana", "Carlos"]);
    const [ana, carlos] = created.party.guests;
    await submitGuestRsvp(guestClient(), created.token, [
      { guestId: ana.id, attending: true, dietaryNote: null },
      { guestId: carlos.id, attending: false, dietaryNote: null },
    ]);
    const rotated = await rotateGuestPartyLink(await sessionClient("ownerA"), weddingA, created.guestInvitationId, ORIGIN);
    if (!rotated.ok) throw new Error(rotated.reason);
    const newToken = tokenOf(rotated.link);
    expect(newToken).not.toBe(created.token);

    expect(await getGuestPartyByToken(guestClient(), created.token)).toEqual({ ok: false, reason: "unavailable" });
    const fresh = await getGuestPartyByToken(guestClient(), newToken);
    expect(fresh.ok && fresh.party.guests.map((g) => [g.name, g.attending])).toEqual([
      ["Ana", true],
      ["Carlos", false],
    ]);
  });
});

describe("guest RSVP services", () => {
  let wedding: string;
  let otherWedding: string;

  beforeAll(async () => {
    wedding = await fixtureWedding("ownerA", "Boda servicio RSVP");
    otherWedding = await fixtureWedding("ownerB", "Boda servicio RSVP B");
    await sql("update public.weddings set wedding_date = '2090-06-01' where id = $1", [wedding]);
  });

  it("valid link: mixed answers, then a change, one row per guest; organizers see it", async () => {
    const created = await newParty("ownerA", wedding, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
    const [ana, carlos] = created.party.guests;

    const first = await submitGuestRsvp(guestClient(), created.token, [
      { guestId: ana.id, attending: true, dietaryNote: "Vegetariana" },
      { guestId: carlos.id, attending: false, dietaryNote: null },
    ]);
    expect(first.ok && first.party.guests.map((g) => [g.name, g.attending, g.dietaryNote])).toEqual([
      ["Ana Pérez", true, "Vegetariana"],
      ["Carlos Pérez", false, null],
    ]);
    const changed = await submitGuestRsvp(guestClient(), created.token, [
      { guestId: ana.id, attending: true, dietaryNote: "Vegetariana" },
      { guestId: carlos.id, attending: true, dietaryNote: null },
    ]);
    expect(changed.ok).toBe(true);

    const party = (await partiesOf("ownerA", wedding)).find(
      (p) => p.id === created.guestInvitationId,
    );
    expect(party?.guests.map((g) => [g.name, g.rsvp])).toEqual([
      ["Ana Pérez", { attending: true, dietaryNote: "Vegetariana" }],
      ["Carlos Pérez", { attending: true, dietaryNote: null }],
    ]);
    const count = await sql<{ n: number }>(
      "select count(*)::int as n from public.rsvps where guest_id = any($1::uuid[])",
      [[ana.id, carlos.id]],
    );
    expect(count[0]?.n).toBe(2);
  });

  it("malformed, unknown, revoked, expired and deleted links are all `unavailable`", async () => {
    const client = guestClient();
    expect(await getGuestPartyByToken(client, "")).toEqual({ ok: false, reason: "unavailable" });
    expect(await getGuestPartyByToken(client, "short")).toEqual({ ok: false, reason: "unavailable" });
    expect(await getGuestPartyByToken(client, "A".repeat(43))).toEqual({ ok: false, reason: "unavailable" });

    const revoked = await newParty("ownerA", wedding, "Revocado", ["Rita"]);
    await revokeGuestPartyLink(await sessionClient("ownerA"), wedding, revoked.guestInvitationId);
    expect(await getGuestPartyByToken(client, revoked.token)).toEqual({ ok: false, reason: "unavailable" });
    expect(
      await submitGuestRsvp(client, revoked.token, [
        { guestId: revoked.party.guests[0].id, attending: true, dietaryNote: null },
      ]),
    ).toEqual({ ok: false, reason: "unavailable" });

    const expiring = await fixtureWedding("ownerA", "Boda pasada");
    const expired = await newParty("ownerA", expiring, "Pasado", ["Pía"]);
    await sql("update public.weddings set wedding_date = '2020-01-01' where id = $1", [expiring]);
    expect(await getGuestPartyByToken(client, expired.token)).toEqual({ ok: false, reason: "unavailable" });

    const deleted = await newParty("ownerA", wedding, "Borrado", ["Bea"]);
    await deleteGuestParty(await sessionClient("ownerA"), wedding, deleted.guestInvitationId);
    expect(await getGuestPartyByToken(client, deleted.token)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a forged guest makes the whole submission `stale` and saves nothing", async () => {
    const created = await newParty("ownerA", wedding, "Atómico", ["Ana", "Carlos"]);
    const foreign = await newParty("ownerB", otherWedding, "Ajeno", ["Ajeno"]);
    const result = await submitGuestRsvp(guestClient(), created.token, [
      { guestId: created.party.guests[0].id, attending: true, dietaryNote: null },
      { guestId: foreign.party.guests[0].id, attending: true, dietaryNote: null },
    ]);
    expect(result).toEqual({ ok: false, reason: "stale" });
    const rows = await sql("select 1 from public.rsvps where guest_id = any($1::uuid[])", [
      [created.party.guests[0].id, created.party.guests[1].id, foreign.party.guests[0].id],
    ]);
    expect(rows).toEqual([]);
  });

  it("a signed-in organizer of the wedding gains nothing without the token", async () => {
    const created = await newParty("ownerA", wedding, "Sin token", ["Ana"]);
    const organizer = await sessionClient("ownerA");
    const other = await newParty("ownerA", wedding, "Otro", ["Otra"]);
    // Their own valid session + another party's token: only that party.
    const result = await submitGuestRsvp(organizer, other.token, [
      { guestId: created.party.guests[0].id, attending: true, dietaryNote: null },
    ]);
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});
