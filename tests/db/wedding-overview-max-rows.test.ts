import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { account, cleanupOverviewFixtures, join, seedVolume, wedding, type Account } from "./overview-fixtures";

vi.mock("server-only", () => ({}));
const { OVERVIEW_SELECT, loadWeddingsOverview } = await import("@/lib/weddings/overview/service");

// LB-24B gate (ADR-018), kept as a permanent regression. PostgREST's
// `max_rows` (1000 locally; Supabase's default) silently caps top-level rows
// AND every embedded child array, per parent row. Measured at the start of
// LB-24B: embedded arrays of 1100–1500 rows came back as exactly 1000. The
// overview therefore reads an exact `(count)` next to every child array
// that could pass the cap, in the same statement, and fails closed per
// wedding and domain when an array is shorter than its count.

const NOW = new Date("2026-10-11T18:00:00Z");

let owner: Account;
let helper: Account;
let big: string;
let nested: string;
let small: string;

beforeAll(async () => {
  owner = await account("max-rows");
  big = await wedding(owner, { name: "Boda grande" });
  nested = await wedding(owner, { name: "Boda anidada" });
  small = await wedding(owner, { name: "Boda pequeña" });
  // A collaborator on the two weddings without a truncated party list.
  helper = await account("max-rows-helper");
  await join(nested, helper, "collaborator");
  await join(small, helper, "collaborator");
  // > 1000 children directly under the wedding row, for every domain.
  await seedVolume(big, {
    checklistItems: 1500,
    parties: 1100,
    guestsPerParty: 1,
    vendors: 1100,
    itemsPerVendor: 1,
    paymentsPerVendor: 1,
    timelineEntries: 1100,
  });
  // > 1000 children one level deeper: guests of one party, items/payments of one vendor.
  await seedVolume(nested, {
    parties: 1,
    guestsPerParty: 1100,
    tables: 22,
    seatedPerTable: 50,
    vendors: 1,
    itemsPerVendor: 1100,
    paymentsPerVendor: 1100,
  });
  // Under the cap everywhere: must come back whole and be summarized.
  await seedVolume(small, {
    checklistItems: 700,
    parties: 7,
    guestsPerParty: 100,
    vendors: 3,
    itemsPerVendor: 2,
    paymentsPerVendor: 2,
    timelineEntries: 700,
  });
}, 180_000);

afterAll(cleanupOverviewFixtures);

const ids = () => [big, nested, small];

describe("PostgREST max_rows: the measured behavior", () => {
  it("control: a flat read is capped at 1000, and count: exact reveals it", async () => {
    const { data, count, error } = await owner.client
      .from("checklist_items")
      .select("id", { count: "exact" })
      .eq("wedding_id", big);
    expect(error).toBeNull();
    expect(count).toBe(1500);
    expect(data).toHaveLength(1000);
  });

  it("checklist embed: capped at 1000 per wedding; the count embed reports 1500", async () => {
    const { data, error } = await owner.client.from("weddings").select(OVERVIEW_SELECT.checklist).in("id", ids());
    expect(error).toBeNull();
    const row = (id: string) => data?.find((r) => r.id === id);
    expect(row(big)?.checklist_items).toHaveLength(1000);
    expect(row(big)?.checklist_item_count).toEqual([{ count: 1500 }]);
    expect(row(small)?.checklist_items).toHaveLength(700);
    expect(row(small)?.checklist_item_count).toEqual([{ count: 700 }]);
  });

  it("guests embed: parties capped per wedding, guests capped per party (with an exact guest count)", async () => {
    const { data, error } = await owner.client.from("weddings").select(OVERVIEW_SELECT.guests).in("id", ids());
    expect(error).toBeNull();
    const row = (id: string) => data?.find((r) => r.id === id);
    expect(row(big)?.guest_invitations).toHaveLength(1000);
    const party = row(nested)?.guest_invitations[0];
    expect(party?.guests).toHaveLength(1000);
    expect(party?.guest_count).toEqual([{ count: 1100 }]);
    expect(row(small)?.guest_invitations.flatMap((p) => p.guests)).toHaveLength(700);
  });

  it("parties: `(count)` is refused (column-only grants), the flat exact count is not", async () => {
    const refused = await owner.client.from("weddings").select("id, guest_invitations(count)").in("id", ids());
    expect(refused.error?.code).toBe("42501");
    const { count, error } = await owner.client
      .from("guest_invitations")
      .select("id", { count: "exact", head: true })
      .in("wedding_id", ids());
    expect(error).toBeNull();
    expect(count).toBe(1100 + 1 + 7);
  });

  it("budget embed: vendors capped per wedding, items and payments capped per vendor; counts exact", async () => {
    const { data, error } = await owner.client.from("weddings").select(OVERVIEW_SELECT.budget).in("id", ids());
    expect(error).toBeNull();
    const row = (id: string) => data?.find((r) => r.id === id);
    expect(row(big)?.wedding_vendors).toHaveLength(1000);
    expect(row(big)?.vendor_count).toEqual([{ count: 1100 }]);
    const vendor = row(nested)?.wedding_vendors[0];
    expect(vendor?.vendor_payment_schedule_items).toHaveLength(1000);
    expect(vendor?.item_count).toEqual([{ count: 1100 }]);
    expect(vendor?.vendor_payments).toHaveLength(1000);
    expect(vendor?.payment_count).toEqual([{ count: 1100 }]);
  });

  it("timeline embed: capped at 1000 per wedding; the count embed reports 1100", async () => {
    const { data, error } = await owner.client.from("weddings").select(OVERVIEW_SELECT.timeline).in("id", ids());
    expect(error).toBeNull();
    const row = (id: string) => data?.find((r) => r.id === id);
    expect(row(big)?.wedding_timeline_entries).toHaveLength(1000);
    expect(row(big)?.timeline_entry_count).toEqual([{ count: 1100 }]);
    expect(row(small)?.wedding_timeline_entries).toHaveLength(700);
  });
});

describe("the overview fails closed on truncation, per wedding and domain", () => {
  it("truncated domains are unavailable (never partial sums); complete weddings are summarized exactly", async () => {
    const result = await loadWeddingsOverview(owner.client, owner.id, NOW);
    if (result.status !== "ready") throw new Error(`unexpected ${result.status}`);
    const by = (id: string) => result.weddings.find((w) => w.wedding.id === id);

    expect(by(big)?.unavailableDomains).toEqual(["checklist", "guests", "budget", "timeline"]);
    expect(by(big)?.vendors).toEqual({ status: "unavailable" });
    // One wedding's truncated party list makes guests untrusted for the whole request.
    expect(by(nested)?.unavailableDomains).toEqual(["guests", "budget"]);
    expect(by(nested)?.checklist).toMatchObject({ status: "ok", value: { progress: { applicable: 0 } } });
    expect(by(small)?.unavailableDomains).toEqual(["guests"]);
    expect(by(small)?.checklist).toMatchObject({
      status: "ok",
      value: { progress: { done: 350, pending: 350 } },
    });
    expect(by(small)?.budget).toMatchObject({ status: "ok", value: { isEmpty: false } });
    expect(by(small)?.timeline).toMatchObject({ status: "ok", value: { entryCount: 700 } });

    expect(result.complete).toBe(false);
    expect(result.allClear).toBe(false);
    expect(result.unavailableDomains).toEqual(["checklist", "guests", "budget", "timeline"]);
    // No attention is derived from a truncated domain.
    expect(result.attention.filter((a) => a.weddingId === big).map((a) => a.kind)).toEqual([
      "wedding_date_missing",
      "wedding_time_zone_missing",
    ]);
  });

  it("a party with more guests than the cap fails closed for its wedding only", async () => {
    const result = await loadWeddingsOverview(helper.client, helper.id, NOW);
    if (result.status !== "ready") throw new Error(`unexpected ${result.status}`);
    const by = (id: string) => result.weddings.find((w) => w.wedding.id === id);
    expect(result.weddings.map((w) => w.wedding.id).sort()).toEqual([nested, small].sort());
    expect(by(nested)?.unavailableDomains).toEqual(["guests", "budget"]);
    expect(by(small)?.unavailableDomains).toEqual([]);
    expect(by(small)?.guests).toMatchObject({ status: "ok", value: { guests: { total: 700, parties: 7 } } });
    expect(result.complete).toBe(false);
  });
});
