import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./support";
import { account, cleanupOverviewFixtures, countingClient, join, seedVolume, wedding, type Account } from "./overview-fixtures";

vi.mock("server-only", () => ({}));
const { loadWeddingsOverview } = await import("@/lib/weddings/overview/service");

// LB-24B (ADR-018) performance fixture: a planner with 50 realistic weddings
// (and a colleague on 25 of them). Diagnostics only (query count, elapsed
// time, row volume) are printed; the only assertions are correctness ones,
// never a timing threshold.
//
// Per wedding: 100 checklist items, 100 parties / 300 guests (~75% answered),
// 15 tables / 150 seated, 15 booked vendors with 5 schedule items and 5
// payments each, 50 timeline entries (20% untimed).

const NOW = new Date("2026-10-11T18:00:00Z");
const PER_WEDDING = {
  checklistItems: 100,
  parties: 100,
  guestsPerParty: 3,
  tables: 15,
  seatedPerTable: 10,
  vendors: 15,
  itemsPerVendor: 5,
  paymentsPerVendor: 5,
  timelineEntries: 50,
} as const;

let fifty: Account;
let twentyFive: Account;
const ids: string[] = [];

beforeAll(async () => {
  [fifty, twentyFive] = await Promise.all([account("perf-50"), account("perf-25")]);
  for (let i = 0; i < 50; i += 1) {
    const month = String((i % 12) + 1).padStart(2, "0");
    const id = await wedding(fifty, {
      name: `Boda ${i + 1}`,
      weddingDate: `2027-${month}-15`,
      timeZone: "America/Costa_Rica",
    });
    ids.push(id);
    await seedVolume(id, PER_WEDDING);
    if (i < 25) await join(id, twentyFive, "collaborator");
  }
}, 600_000);

afterAll(cleanupOverviewFixtures, 120_000);

async function rowVolume(weddingIds: readonly string[]) {
  const [row] = await sql<Record<string, string>>(
    `select
       (select count(*) from public.checklist_items where wedding_id = any($1::uuid[])) as checklist,
       (select count(*) from public.guests where wedding_id = any($1::uuid[])) as guests,
       (select count(*) from public.wedding_vendors where wedding_id = any($1::uuid[])) as vendors,
       (select count(*) from public.vendor_payment_schedule_items where wedding_id = any($1::uuid[])) as items,
       (select count(*) from public.vendor_payments where wedding_id = any($1::uuid[])) as payments,
       (select count(*) from public.wedding_timeline_entries where wedding_id = any($1::uuid[])) as timeline`,
    [weddingIds],
  );
  return row;
}

describe.each([
  ["25 weddings", () => twentyFive, 25],
  ["50 weddings", () => fifty, 50],
] as const)("%s", (label, who, n) => {
  it("complete, untruncated, 6 requests; diagnostics recorded", { timeout: 120_000 }, async () => {
    const counted = countingClient(who());
    // Warm-up, then a measured run.
    await loadWeddingsOverview(counted.client, who().id, NOW);
    counted.requests.length = 0;
    const started = performance.now();
    const result = await loadWeddingsOverview(counted.client, who().id, NOW);
    const elapsedMs = Math.round(performance.now() - started);

    if (result.status !== "ready") throw new Error(result.status);
    expect(result.weddings).toHaveLength(n);
    expect(result.complete).toBe(true);
    expect(counted.requests).toHaveLength(6);
    for (const w of result.weddings) {
      expect(w.checklist).toMatchObject({ status: "ok", value: { progress: { applicable: 100 } } });
      expect(w.guests).toMatchObject({ status: "ok", value: { guests: { total: 300 }, seating: { seated: 150 } } });
      expect(w.timeline).toMatchObject({ status: "ok", value: { entryCount: 50, untimedCount: 10 } });
    }

    const volume = await rowVolume(ids.slice(0, n));
    console.info(
      `[LB-24B perf] ${label}: ${counted.requests.length} requests, ${elapsedMs} ms end-to-end, ` +
        `attention ${result.attention.length}, rows ${JSON.stringify(volume)}`,
    );
  });
});
