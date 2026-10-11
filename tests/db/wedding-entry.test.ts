import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { createWedding as createFixtureWedding, ctx, sql, type DbClient, type WeddingRole } from "./support";

vi.mock("server-only", () => ({}));
const { createWedding, listMyWeddings } = await import("@/lib/weddings/service");
const { decideWeddingEntry } = await import("@/lib/weddings/entry");

// LB-24A (ADR-017): the account entry's 0 / 1 / N decision against real
// memberships and RLS. Fresh accounts per run, so other suites' weddings
// can't change the counts. Planner/persona metadata is set the way any user
// could set it (sign-up `data`) and must change nothing.

type Account = { id: string; client: DbClient };

const PASSWORD = "local-test-password-lb24a";
const accountIds: string[] = [];
const weddingIds: string[] = [];

async function account(label: string, metadata?: Record<string, unknown>): Promise<Account> {
  const client = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const email = `lb24a-${label}-${randomBytes(6).toString("hex")}@example.test`;
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
    ...(metadata ? { options: { data: metadata } } : {}),
  });
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message}`);
  accountIds.push(data.user.id);
  return { id: data.user.id, client };
}

async function wedding(
  owner: Account,
  name: string,
  details: { weddingDate?: string; city?: string } = {},
): Promise<string> {
  const result = await createWedding(owner.client, {
    name,
    weddingDate: details.weddingDate ?? null,
    city: details.city ?? null,
    timeZone: null,
  });
  if (!result.ok) throw new Error(`create_wedding failed: ${result.reason}`);
  weddingIds.push(result.weddingId);
  return result.weddingId;
}

/** Fixture: memberships have no client insert path outside invites. */
async function join(weddingId: string, who: Account, role: WeddingRole) {
  await sql("insert into public.wedding_memberships (wedding_id, user_id, role) values ($1, $2, $3)", [
    weddingId,
    who.id,
    role,
  ]);
}

const list = (who: Account) => listMyWeddings(who.client, who.id);

let none: Account;
let soloOwner: Account;
let soloCollaborator: Account;
let mixed: Account;
let mixedPlanner: Account;
let other: Account;
let a: string;
let b: string;
let c: string;
let foreign: string;

beforeAll(async () => {
  [none, soloOwner, soloCollaborator, mixed, other] = await Promise.all([
    account("none"),
    account("solo-owner"),
    account("solo-collab"),
    account("mixed"),
    account("other"),
  ]);
  mixedPlanner = await account("planner-meta", {
    planner: true,
    is_planner: true,
    persona: "planner",
    account_type: "planner",
  });

  await wedding(soloOwner, "Boda propia");
  a = await wedding(mixed, "Boda A", { weddingDate: "2027-08-14", city: "Escazú" });
  b = await wedding(other, "Boda B", { weddingDate: "2027-03-02" });
  c = await wedding(mixed, "Boda C");
  foreign = await wedding(other, "Boda ajena", { weddingDate: "2027-01-01", city: "Cartago" });
  await join(b, soloCollaborator, "collaborator");
  await join(b, mixed, "collaborator");
  await join(a, mixedPlanner, "owner");
  await join(b, mixedPlanner, "collaborator");
  await join(c, mixedPlanner, "owner");
});

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [weddingIds]);
  await sql("delete from auth.users where id = any($1::uuid[])", [accountIds]);
});

describe("account entry listing (LB-24A)", () => {
  it("zero memberships: [] → the empty state, never a redirect", async () => {
    const weddings = await list(none);
    expect(weddings).toEqual([]);
    expect(decideWeddingEntry(weddings, { showList: false })).toEqual({ kind: "empty" });
  });

  it("one owned wedding → redirect into it", async () => {
    const weddings = await list(soloOwner);
    expect(weddings).toHaveLength(1);
    expect(weddings?.[0]?.role).toBe("owner");
    expect(decideWeddingEntry(weddings, { showList: false })).toEqual({
      kind: "redirect",
      path: `/app/weddings/${weddings?.[0]?.id}`,
    });
  });

  it("one collaborator membership (created by someone else) → redirect into it", async () => {
    const weddings = await list(soloCollaborator);
    expect(weddings).toEqual([
      { id: b, name: "Boda B", weddingDate: "2027-03-02", city: null, role: "collaborator" },
    ]);
    expect(decideWeddingEntry(weddings, { showList: false })).toEqual({
      kind: "redirect",
      path: `/app/weddings/${b}`,
    });
  });

  it("three weddings, mixed roles: exactly those, soonest first, city only where set", async () => {
    const weddings = await list(mixed);
    expect(weddings).toEqual([
      { id: b, name: "Boda B", weddingDate: "2027-03-02", city: null, role: "collaborator" },
      { id: a, name: "Boda A", weddingDate: "2027-08-14", city: "Escazú", role: "owner" },
      { id: c, name: "Boda C", weddingDate: null, city: null, role: "owner" },
    ]);
    expect(weddings?.map((w) => w.id)).not.toContain(foreign);
    expect(JSON.stringify(weddings)).not.toContain("Cartago");
    expect(decideWeddingEntry(weddings, { showList: false })).toMatchObject({ kind: "list" });
  });

  it("each wedding appears once, and no duplicate membership can be added", async () => {
    const ids = (await list(mixed))?.map((w) => w.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    await expect(join(a, mixed, "collaborator")).rejects.toThrow(/duplicate key|unique/i);
  });

  it("planner/persona metadata widens nothing: same memberships, same list", async () => {
    const { data } = await mixedPlanner.client.auth.getUser();
    expect(data.user?.user_metadata).toMatchObject({ planner: true, persona: "planner" });

    const weddings = await list(mixedPlanner);
    expect(weddings?.map((w) => [w.id, w.role])).toEqual([
      [b, "collaborator"],
      [a, "owner"],
      [c, "owner"],
    ]);
    expect(weddings?.map((w) => w.id)).not.toContain(foreign);

    // Even asking for another user's memberships, RLS shows only weddings the
    // caller shares with them (co-members are visible), never the foreign one.
    const theirs = await listMyWeddings(mixedPlanner.client, other.id);
    expect(theirs?.map((w) => w.id)).toEqual([b]);
    // And the foreign wedding itself stays invisible.
    const { data: rows } = await mixedPlanner.client.from("weddings").select("id").eq("id", foreign);
    expect(rows).toEqual([]);
  });

  it("an unrelated fixture wedding never shows up in a fresh account's list", async () => {
    const unrelated = await createFixtureWedding("ownerA", "Boda de otra suite");
    weddingIds.push(unrelated);
    expect((await list(none))?.map((w) => w.id)).not.toContain(unrelated);
  });
});
