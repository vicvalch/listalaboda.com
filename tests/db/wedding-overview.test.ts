import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./support";
import {
  account,
  cleanupOverviewFixtures,
  countingClient,
  join,
  seedVolume,
  wedding,
  type Account,
} from "./overview-fixtures";

vi.mock("server-only", () => ({}));
const { OVERVIEW_SELECT, loadWeddingsOverview } = await import("@/lib/weddings/overview/service");
const { attentionPath } = await import("@/lib/weddings/overview/attention");

// LB-24B (ADR-018) against real memberships, RLS and PostgREST: which
// weddings the overview covers comes ONLY from the caller's memberships.
// Planner/subscription metadata is set the way any user could set it
// (sign-up `data`) and must change nothing; `created_by` must not matter.

const NOW = new Date("2026-10-11T18:00:00Z");

let planner: Account;
let plain: Account;
let other: Account;
let owned: string;
let collaborating: string;
let foreign: string;
let createdButLeft: string;

beforeAll(async () => {
  [planner, plain, other] = await Promise.all([
    account("planner", { planner: true, persona: "planner", subscription: "pro", entitlements: ["overview"] }),
    account("plain"),
    account("other"),
  ]);

  owned = await wedding(planner, { name: "Boda propia", weddingDate: "2026-12-12", timeZone: "America/Costa_Rica" });
  collaborating = await wedding(other, {
    name: "Boda colaborada",
    weddingDate: "2026-11-01",
    timeZone: "America/Costa_Rica",
  });
  foreign = await wedding(other, { name: "Boda ajena", weddingDate: "2026-10-20", timeZone: "America/Costa_Rica" });
  // Created by the planner (created_by = planner), then handed over: no membership left.
  createdButLeft = await wedding(planner, { name: "Boda entregada" });
  await join(createdButLeft, other, "owner");
  await sql("delete from public.wedding_memberships where wedding_id = $1 and user_id = $2", [
    createdButLeft,
    planner.id,
  ]);

  await join(collaborating, planner, "collaborator");
  await join(owned, plain, "owner");
  await join(collaborating, plain, "collaborator");

  // Work in every wedding, the foreign ones included: it must never surface.
  for (const id of [collaborating, foreign, createdButLeft]) {
    await seedVolume(id, {
      checklistItems: 4,
      parties: 2,
      guestsPerParty: 5,
      tables: 1,
      seatedPerTable: 10,
      vendors: 2,
      itemsPerVendor: 2,
      paymentsPerVendor: 1,
      timelineEntries: 5,
    });
  }
}, 120_000);

afterAll(cleanupOverviewFixtures);

describe("authorized weddings (memberships only)", () => {
  it("owned and collaborator weddings, nothing else; created_by is ignored", async () => {
    const result = await loadWeddingsOverview(planner.client, planner.id, NOW);
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.weddings.map((w) => [w.wedding.id, w.wedding.role])).toEqual([
      [collaborating, "collaborator"],
      [owned, "owner"],
    ]);
    const ids = new Set([...result.weddings.map((w) => w.wedding.id), ...result.attention.map((a) => a.weddingId)]);
    expect(ids.has(foreign)).toBe(false);
    expect(ids.has(createdButLeft)).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("a collaborator wedding is summarized from real rows, with attention and links", async () => {
    const result = await loadWeddingsOverview(planner.client, planner.id, NOW);
    if (result.status !== "ready") throw new Error(result.status);
    const collab = result.weddings.find((w) => w.wedding.id === collaborating);
    expect(collab?.checklist).toMatchObject({ status: "ok", value: { progress: { done: 2, pending: 2 } } });
    expect(collab?.guests).toMatchObject({
      status: "ok",
      value: { guests: { parties: 2, total: 10 }, seating: { seated: 10, seatedDeclined: 1 } },
    });
    expect(collab?.timeline).toMatchObject({ status: "ok", value: { entryCount: 5, untimedCount: 1 } });
    expect(collab?.vendors).toMatchObject({ status: "ok", value: { total: 2, byStatus: { booked: 2 } } });
    expect(collab?.attention.map((a) => a.kind)).toEqual(["payment_overdue", "checklist_overdue", "seated_declined"]);
    expect(collab?.attention.map((a) => attentionPath(collaborating, a.destination, "collaborator"))).toEqual([
      `/app/weddings/${collaborating}/budget`,
      `/app/weddings/${collaborating}?view=plan`,
      `/app/weddings/${collaborating}/seating`,
    ]);
    const owner = result.weddings.find((w) => w.wedding.id === owned);
    expect(owner?.attention).toEqual([]);
    expect(result.allClear).toBe(false);
  });

  it("planner / subscription metadata widens nothing: same weddings as a plain account with the same memberships", async () => {
    const { data } = await planner.client.auth.getUser();
    expect(data.user?.user_metadata).toMatchObject({ planner: true, subscription: "pro" });
    const withMeta = await loadWeddingsOverview(planner.client, planner.id, NOW);
    const without = await loadWeddingsOverview(plain.client, plain.id, NOW);
    if (withMeta.status !== "ready" || without.status !== "ready") throw new Error("not ready");
    expect(withMeta.weddings.map((w) => w.wedding.id)).toEqual(without.weddings.map((w) => w.wedding.id));
    expect(withMeta.attention).toEqual(without.attention);
  });

  it("forcing a foreign id into a domain read returns nothing for it (RLS is the backstop)", async () => {
    for (const select of Object.values(OVERVIEW_SELECT) as string[]) {
      const { data, error } = await planner.client.from("weddings").select(select).in("id", [owned, foreign, createdButLeft]);
      expect(error).toBeNull();
      expect(((data ?? []) as unknown as { id: string }[]).map((row) => row.id)).toEqual([owned]);
    }
    const { count } = await planner.client
      .from("guest_invitations")
      .select("id", { count: "exact", head: true })
      .in("wedding_id", [foreign, createdButLeft]);
    expect(count).toBe(0);
  });

  it("asking with another user's id never reveals their other weddings", async () => {
    // RLS shows co-members' memberships of SHARED weddings only.
    const result = await loadWeddingsOverview(planner.client, other.id, NOW);
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.weddings.map((w) => w.wedding.id)).toEqual([collaborating]);
  });

  it("6 requests on the real stack: memberships, four domain reads, the party count; no writes", async () => {
    const counted = countingClient(planner);
    const result = await loadWeddingsOverview(counted.client, planner.id, NOW);
    expect(result.status).toBe("ready");
    expect(counted.requests.sort()).toEqual(
      [
        "GET /rest/v1/wedding_memberships",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "GET /rest/v1/weddings",
        "HEAD /rest/v1/guest_invitations",
      ].sort(),
    );
  });
});
