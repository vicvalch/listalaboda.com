import { afterEach, describe, expect, it, vi } from "vitest";

import type { FinanceVendor, PaymentFacts, ScheduleItemFacts } from "@/lib/budget/summary";
import type { ChecklistFacts, DomainResult, OverviewWeddingInput, PartyFacts } from "@/lib/weddings/overview/types";
import type { TimelineSlot } from "@/lib/timeline/summary";
import type { WeddingSummary } from "@/lib/weddings/service";
import {
  ATTENTION_KINDS,
  KIND_LEVEL,
  KIND_RANK,
  LEVEL_RANK,
  attentionId,
  attentionPath,
} from "@/lib/weddings/overview/attention";
import { buildWeddingsOverview, weddingCountdown } from "@/lib/weddings/overview/summary";

// LB-24B (ADR-018): the pure overview builder and derived attention. No
// database, no clock: every test passes the one `now`.

const NOW = new Date("2026-10-10T18:00:00Z"); // 12:00 in Costa Rica: today = 2026-10-10
const CR = "America/Costa_Rica";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const UNAVAILABLE = { status: "unavailable" } as const;
const ok = <T>(value: T): DomainResult<T> => ({ status: "ok", value });

function wedding(id: string, fields: Partial<WeddingSummary> = {}): WeddingSummary {
  return { id, name: `Boda ${id[0]}`, weddingDate: "2026-12-12", city: null, timeZone: CR, role: "owner", ...fields };
}

type Vendor = FinanceVendor<ScheduleItemFacts, PaymentFacts>;

function vendor(id: string, fields: Partial<Vendor> = {}): Vendor {
  return {
    id,
    name: `Proveedor ${id}`,
    category: "photography",
    customCategory: null,
    status: "booked",
    currency: "CRC",
    contractedAmountMinor: null,
    scheduleItems: [],
    payments: [],
    ...fields,
  };
}

const absolute = (dueDate: string, status: ChecklistFacts["status"] = "pending"): ChecklistFacts => ({
  status,
  timing: { mode: "absolute", dueDate },
  seededAt: null,
});

const guest = (attending: boolean | null, seated = false) => ({ attending, seated });

function slot(id: string, fields: Partial<TimelineSlot> = {}): TimelineSlot {
  return {
    id,
    title: `Momento ${id}`,
    dayOffset: 0,
    startTime: null,
    durationMinutes: null,
    phase: null,
    vendor: null,
    createdAt: `2026-01-01T00:00:0${id.length % 10}Z`,
    ...fields,
  };
}

type Parts = Partial<{
  checklist: DomainResult<readonly ChecklistFacts[]>;
  guests: DomainResult<readonly PartyFacts[]>;
  vendors: readonly Vendor[];
  totals: { currency: "CRC" | "USD"; amountMinor: number }[];
  budget: OverviewWeddingInput["budget"];
  timeline: DomainResult<readonly TimelineSlot[]>;
}>;

function input(w: WeddingSummary, parts: Parts = {}): OverviewWeddingInput {
  return {
    wedding: w,
    checklist: parts.checklist ?? ok([]),
    guests: parts.guests ?? ok([]),
    budget: parts.budget ?? ok({ vendors: parts.vendors ?? [], totals: parts.totals ?? [], allocations: [] }),
    timeline: parts.timeline ?? ok([]),
  };
}

/** The planning report's "one wedding" example (A, ten days out). */
function weddingA(extra: { dueSoonUsd?: boolean } = {}): OverviewWeddingInput {
  return input(wedding(A, { name: "Ana y Beto", weddingDate: "2026-10-20" }), {
    checklist: ok([
      absolute("2026-09-20"),
      absolute("2026-10-01"),
      absolute("2026-10-09"),
      absolute("2026-10-10"), // due today: not overdue
      absolute("2026-09-01", "done"),
    ]),
    guests: ok([
      { guests: [guest(null), guest(null), guest(null)] },
      { guests: [guest(null), guest(null), guest(true), guest(true)] },
      { guests: [guest(true), guest(true), guest(true, true), guest(true, true)] },
    ]),
    vendors: [
      vendor("v1", {
        contractedAmountMinor: 50_000_000,
        scheduleItems: [
          { id: "i1", amountMinor: 20_000_000, dueOn: "2026-10-01" },
          { id: "i2", amountMinor: 15_000_000, dueOn: "2026-10-05" },
          { id: "i3", amountMinor: 15_000_000, dueOn: "2026-12-01" },
        ],
      }),
      ...(extra.dueSoonUsd
        ? [
            vendor("v2", {
              currency: "USD",
              contractedAmountMinor: 20_000,
              scheduleItems: [{ id: "i4", amountMinor: 20_000, dueOn: "2026-10-15" }],
            }),
          ]
        : []),
    ],
    timeline: ok([slot("t1"), slot("t2"), slot("t3")]),
  });
}

function weddingB(): OverviewWeddingInput {
  return input(wedding(B, { name: "Bea y Carlos", weddingDate: "2026-11-19" }), {
    checklist: ok([absolute("2026-10-05")]),
    guests: ok([{ guests: [guest(false, true), guest(false, true), guest(true, true)] }]),
    totals: [{ currency: "USD", amountMinor: 1_000_000 }],
    vendors: [vendor("v5", { currency: "USD", contractedAmountMinor: 1_150_000 })],
  });
}

function weddingC(): OverviewWeddingInput {
  return input(wedding(C, { name: "Carla y Dani", weddingDate: null, timeZone: null }), {
    vendors: [
      vendor("v9", {
        status: "quoted",
        contractedAmountMinor: 5_000_000,
        payments: [{ id: "p1", amountMinor: 5_000_000, paidOn: "2026-09-01", scheduleItemId: null }],
      }),
    ],
  });
}

const kinds = (items: readonly { id: string }[]) => items.map((item) => item.id);

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- taxonomy

describe("attention taxonomy", () => {
  it("exactly the eight approved kinds, in priority order", () => {
    expect(ATTENTION_KINDS).toEqual([
      "payment_overdue",
      "checklist_overdue",
      "payment_due_soon",
      "seated_declined",
      "payment_to_unbooked_vendor",
      "budget_total_over",
      "wedding_date_missing",
      "wedding_time_zone_missing",
    ]);
    expect(ATTENTION_KINDS.map((kind) => KIND_RANK[kind])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("fixed levels, ranked overdue < due_soon < review < setup", () => {
    expect(LEVEL_RANK).toEqual({ overdue: 0, due_soon: 1, review: 2, setup: 3 });
    expect(KIND_LEVEL).toEqual({
      payment_overdue: "overdue",
      checklist_overdue: "overdue",
      payment_due_soon: "due_soon",
      seated_declined: "review",
      payment_to_unbooked_vendor: "review",
      budget_total_over: "review",
      wedding_date_missing: "setup",
      wedding_time_zone_missing: "setup",
    });
  });

  it("ids are `${weddingId}:${kind}`, derived, never random", () => {
    expect(attentionId(A, "payment_overdue")).toBe(`${A}:payment_overdue`);
    const first = buildWeddingsOverview([weddingA()], NOW);
    const second = buildWeddingsOverview([weddingA()], NOW);
    expect(kinds(first.attention)).toEqual([`${A}:payment_overdue`, `${A}:checklist_overdue`]);
    expect(kinds(second.attention)).toEqual(kinds(first.attention));
  });

  it("deep links only to existing routes; settings only for owners", () => {
    expect(attentionPath(A, "checklist_plan", "owner")).toBe(`/app/weddings/${A}?view=plan`);
    expect(attentionPath(A, "budget", "collaborator")).toBe(`/app/weddings/${A}/budget`);
    expect(attentionPath(A, "seating", "owner")).toBe(`/app/weddings/${A}/seating`);
    expect(attentionPath(A, "settings", "owner")).toBe(`/app/weddings/${A}/settings`);
    expect(attentionPath(A, "settings", "collaborator")).toBe(`/app/weddings/${A}`);
  });
});

// ------------------------------------------------------------ one wedding

describe("one wedding (planning example A)", () => {
  const result = buildWeddingsOverview([weddingA()], NOW);
  const [a] = result.weddings;

  it("summaries come from the domain helpers", () => {
    expect(a.countdown).toEqual({ state: "before", days: 10 });
    expect(a.checklist).toEqual(
      ok({
        progress: { done: 1, pending: 4, notApplicable: 0, applicable: 5, percent: 20 },
        overdueCount: 3,
        oldestOverdueOn: "2026-09-20",
      }),
    );
    expect(a.guests).toEqual(
      ok({
        guests: { parties: 3, total: 11, responded: 6, attending: 6, notAttending: 0, pending: 5 },
        seating: { confirmed: 6, seated: 2, confirmedUnseated: 4, seatedDeclined: 0 },
      }),
    );
    expect(a.budget).toMatchObject(
      ok({ overdueCount: 2, dueSoonCount: 0, unbookedPaidVendorCount: 0, timingUnavailable: false, isEmpty: false }),
    );
    expect(a.timeline).toEqual(ok({ entryCount: 3, timedCount: 0, untimedCount: 3, now: null }));
  });

  it("only overdue payments and overdue tasks need attention", () => {
    expect(a.attention).toEqual([
      {
        id: `${A}:payment_overdue`,
        weddingId: A,
        kind: "payment_overdue",
        level: "overdue",
        count: 2,
        amounts: [{ currency: "CRC", amountMinor: BigInt(35_000_000) }],
        since: "2026-10-01",
        destination: "budget",
      },
      {
        id: `${A}:checklist_overdue`,
        weddingId: A,
        kind: "checklist_overdue",
        level: "overdue",
        count: 3,
        amounts: [],
        since: "2026-09-20",
        destination: "checklist_plan",
      },
    ]);
    expect(a.attentionLevel).toBe("overdue");
    expect(result.weddingsNeedingAttention).toBe(1);
    expect(result.allClear).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("pending RSVPs, unseated guests and untimed entries stay summary-only", () => {
    const pendingOnly = buildWeddingsOverview(
      [
        input(wedding(D), {
          guests: ok([{ guests: [guest(null), guest(true), guest(true)] }]),
          timeline: ok([slot("t1")]),
        }),
      ],
      NOW,
    );
    expect(pendingOnly.attention).toEqual([]);
    expect(pendingOnly.allClear).toBe(true);
  });
});

// ---------------------------------------------------------- many weddings

describe("several weddings (planning example A, B, C)", () => {
  const expected = [
    `${A}:payment_overdue`,
    `${A}:checklist_overdue`,
    `${B}:checklist_overdue`,
    `${A}:payment_due_soon`,
    `${B}:seated_declined`,
    `${B}:budget_total_over`,
    `${C}:payment_to_unbooked_vendor`,
    `${C}:wedding_date_missing`,
    `${C}:wedding_time_zone_missing`,
  ];

  it("the global order: level, proximity, kind, date, name, id", () => {
    const result = buildWeddingsOverview([weddingA({ dueSoonUsd: true }), weddingB(), weddingC()], NOW);
    expect(kinds(result.attention)).toEqual(expected);
    expect(result.weddingsNeedingAttention).toBe(3);
    expect(result.weddings.map((w) => w.wedding.id)).toEqual([A, B, C]);
    expect(result.weddings.map((w) => w.attentionLevel)).toEqual(["overdue", "overdue", "review"]);
  });

  it("deterministic: input order and repetition never change the result", () => {
    const one = buildWeddingsOverview([weddingA({ dueSoonUsd: true }), weddingB(), weddingC()], NOW);
    const two = buildWeddingsOverview([weddingC(), weddingB(), weddingA({ dueSoonUsd: true })], NOW);
    expect(kinds(two.attention)).toEqual(expected);
    expect(two.attention).toEqual(one.attention);
    expect(buildWeddingsOverview([weddingA({ dueSoonUsd: true }), weddingB(), weddingC()], NOW)).toEqual(one);
  });

  it("each item carries only its own wedding's amounts", () => {
    const result = buildWeddingsOverview([weddingA({ dueSoonUsd: true }), weddingB(), weddingC()], NOW);
    const byId = new Map(result.attention.map((item) => [item.id, item]));
    expect(byId.get(`${A}:payment_due_soon`)).toMatchObject({
      count: 1,
      amounts: [{ currency: "USD", amountMinor: BigInt(20_000) }],
      since: "2026-10-15",
      level: "due_soon",
    });
    expect(byId.get(`${B}:budget_total_over`)).toMatchObject({
      count: 1,
      amounts: [{ currency: "USD", amountMinor: BigInt(150_000) }],
      since: null,
    });
    expect(byId.get(`${C}:payment_to_unbooked_vendor`)).toMatchObject({
      count: 1,
      amounts: [{ currency: "CRC", amountMinor: BigInt(5_000_000) }],
    });
    expect(byId.get(`${B}:seated_declined`)).toMatchObject({ count: 2, destination: "seating" });
  });

  it("tie-breakers after kind: since (nulls last), then name (Spanish), then id", () => {
    const sameDay = (id: string, name: string, due: string | null) =>
      input(wedding(id, { name, weddingDate: "2026-12-12" }), {
        checklist: ok(due ? [absolute(due)] : []),
        guests: ok(due ? [] : [{ guests: [guest(false, true)] }]),
      });
    const bySince = buildWeddingsOverview(
      [sameDay(A, "Zoe", "2026-10-05"), sameDay(B, "Ana", "2026-10-07"), sameDay(C, "Ana", "2026-10-01")],
      NOW,
    );
    expect(kinds(bySince.attention)).toEqual([
      `${C}:checklist_overdue`,
      `${A}:checklist_overdue`,
      `${B}:checklist_overdue`,
    ]);
    // Same level, proximity, kind and since (null): name with base collation, then id.
    const byName = buildWeddingsOverview(
      [sameDay(D, "Ávila", null), sameDay(B, "avila", null), sameDay(A, "Bruno", null)],
      NOW,
    );
    expect(kinds(byName.attention)).toEqual([`${B}:seated_declined`, `${D}:seated_declined`, `${A}:seated_declined`]);
  });

  it("proximity: today, then sooner upcoming, then most recent past, then no zone (by date), then undated", () => {
    const setupOnly = (id: string, fields: Partial<WeddingSummary>) =>
      input(wedding(id, fields), { guests: ok([{ guests: [guest(false, true)] }]) });
    const result = buildWeddingsOverview(
      [
        setupOnly(A, { weddingDate: null, timeZone: CR }),
        setupOnly(B, { weddingDate: "2026-10-01" }),
        setupOnly(C, { weddingDate: "2026-10-30" }),
        setupOnly(D, { weddingDate: "2026-10-10" }),
        setupOnly("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { weddingDate: "2026-09-01", timeZone: null }),
      ],
      NOW,
    );
    expect(result.attention.filter((i) => i.kind === "seated_declined").map((i) => i.weddingId)).toEqual([
      D,
      C,
      B,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      A,
    ]);
  });
});

// ---------------------------------------------------------- wedding facts

describe("missing wedding date and time zone", () => {
  it("no date: setup item, countdown undated, relative tasks have no due date", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A, { weddingDate: null }), {
          checklist: ok([
            { status: "pending", timing: { mode: "relative_to_wedding", relativeDays: -400 }, seededAt: null },
            absolute("2026-10-01"),
          ]),
        }),
      ],
      NOW,
    );
    const [a] = result.weddings;
    expect(a.countdown).toEqual({ state: "undated" });
    expect(a.checklist).toMatchObject(ok({ overdueCount: 1, oldestOverdueOn: "2026-10-01" }));
    expect(a.attention.map((i) => [i.kind, i.level, i.count, i.destination])).toEqual([
      ["checklist_overdue", "overdue", 1, "checklist_plan"],
      ["wedding_date_missing", "setup", 1, "settings"],
    ]);
  });

  it("no time zone: setup item; nothing overdue or due soon is guessed; non-timing kinds still work", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A, { timeZone: null, weddingDate: "2026-10-20" }), {
          checklist: ok([absolute("2020-01-01")]),
          guests: ok([{ guests: [guest(false, true)] }]),
          totals: [{ currency: "CRC", amountMinor: 1 }],
          vendors: [
            vendor("v1", {
              contractedAmountMinor: 10,
              scheduleItems: [
                { id: "i1", amountMinor: 5, dueOn: "2020-01-01" },
                { id: "i2", amountMinor: 5, dueOn: "2026-10-11" },
              ],
            }),
            vendor("v2", {
              status: "considering",
              contractedAmountMinor: 3,
              payments: [{ id: "p", amountMinor: 3, paidOn: "2026-01-01", scheduleItemId: null }],
            }),
          ],
        }),
      ],
      NOW,
    );
    const [a] = result.weddings;
    expect(a.countdown).toEqual({ state: "no_time_zone" });
    expect(a.checklist).toMatchObject(ok({ overdueCount: 0 }));
    expect(a.budget).toMatchObject(ok({ overdueCount: 0, dueSoonCount: 0, timingUnavailable: true }));
    expect(a.attention.map((i) => i.kind)).toEqual([
      "seated_declined",
      "payment_to_unbooked_vendor",
      "budget_total_over",
      "wedding_time_zone_missing",
    ]);
  });

  it("countdown states", () => {
    expect(weddingCountdown(null, "2026-10-10")).toEqual({ state: "undated" });
    expect(weddingCountdown("2026-10-10", null)).toEqual({ state: "no_time_zone" });
    expect(weddingCountdown("2026-10-10", "2026-10-10")).toEqual({ state: "today" });
    expect(weddingCountdown("2026-10-11", "2026-10-10")).toEqual({ state: "before", days: 1 });
    expect(weddingCountdown("2026-10-09", "2026-10-10")).toEqual({ state: "after", days: 1 });
    expect(weddingCountdown("2027-10-10", "2026-10-10")).toEqual({ state: "before", days: 365 });
  });
});

// ----------------------------------------------------------- per domain

describe("checklist", () => {
  it("due today is not overdue; done and not applicable never are", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A), {
          checklist: ok([
            absolute("2026-10-10"),
            absolute("2026-10-09", "done"),
            absolute("2026-10-09", "not_applicable"),
          ]),
        }),
      ],
      NOW,
    );
    expect(result.weddings[0].checklist).toMatchObject(ok({ overdueCount: 0, oldestOverdueOn: null }));
    expect(result.allClear).toBe(true);
  });
});

describe("payments", () => {
  const dueOn = (dueOn: string) =>
    buildWeddingsOverview(
      [
        input(wedding(A), {
          vendors: [vendor("v", { contractedAmountMinor: 100, scheduleItems: [{ id: "i", amountMinor: 100, dueOn }] })],
        }),
      ],
      NOW,
    ).attention.map((i) => i.kind);

  it("due-soon window is LB-22's: day 0 and day 14 included, day 15 not; yesterday overdue", () => {
    expect(dueOn("2026-10-09")).toEqual(["payment_overdue"]);
    expect(dueOn("2026-10-10")).toEqual(["payment_due_soon"]);
    expect(dueOn("2026-10-24")).toEqual(["payment_due_soon"]);
    expect(dueOn("2026-10-25")).toEqual([]);
  });

  it("paid items and discarded vendors are never overdue", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A), {
          vendors: [
            vendor("paid", {
              contractedAmountMinor: 100,
              scheduleItems: [{ id: "i1", amountMinor: 100, dueOn: "2026-01-01" }],
              payments: [{ id: "p1", amountMinor: 100, paidOn: "2026-01-01", scheduleItemId: "i1" }],
            }),
            vendor("gone", {
              status: "discarded",
              contractedAmountMinor: 100,
              scheduleItems: [{ id: "i2", amountMinor: 100, dueOn: "2026-01-01" }],
            }),
          ],
        }),
      ],
      NOW,
    );
    expect(result.attention).toEqual([]);
  });

  it("booked without a contracted amount is a summary count, never attention", () => {
    const result = buildWeddingsOverview(
      [input(wedding(A), { vendors: [vendor("v", { currency: null }), vendor("w", { status: "quoted" })] })],
      NOW,
    );
    expect(result.weddings[0].vendors).toMatchObject(ok({ total: 2, bookedWithoutAmount: 1 }));
    expect(result.attention).toEqual([]);
  });
});

describe("mixed currencies", () => {
  const overdue = (currency: "CRC" | "USD", id: string, amount: number) =>
    vendor(id, {
      currency,
      contractedAmountMinor: amount,
      scheduleItems: [{ id: `${id}-i`, amountMinor: amount, dueOn: "2026-10-01" }],
    });
  const overdueAmounts = (vendors: Vendor[]) =>
    buildWeddingsOverview([input(wedding(A), { vendors })], NOW).attention.find((i) => i.kind === "payment_overdue")
      ?.amounts;

  it("CRC only, USD only, both: separate buckets, CRC first, never summed or converted", () => {
    expect(overdueAmounts([overdue("CRC", "a", 300), overdue("CRC", "b", 200)])).toEqual([
      { currency: "CRC", amountMinor: BigInt(500) },
    ]);
    expect(overdueAmounts([overdue("USD", "a", 7)])).toEqual([{ currency: "USD", amountMinor: BigInt(7) }]);
    expect(overdueAmounts([overdue("USD", "a", 7), overdue("CRC", "b", 200)])).toEqual([
      { currency: "CRC", amountMinor: BigInt(200) },
      { currency: "USD", amountMinor: BigInt(7) },
    ]);
  });

  it("budget over in both currencies is ONE item with two buckets", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A), {
          totals: [
            { currency: "CRC", amountMinor: 100 },
            { currency: "USD", amountMinor: 100 },
          ],
          vendors: [
            vendor("c", { currency: "CRC", contractedAmountMinor: 150 }),
            vendor("u", { currency: "USD", contractedAmountMinor: 101 }),
          ],
        }),
      ],
      NOW,
    );
    expect(result.attention).toEqual([
      expect.objectContaining({
        kind: "budget_total_over",
        count: 2,
        amounts: [
          { currency: "CRC", amountMinor: BigInt(50) },
          { currency: "USD", amountMinor: BigInt(1) },
        ],
      }),
    ]);
    const budget = result.weddings[0].budget;
    expect(budget.status === "ok" && budget.value.currencies.map((c) => c.currency)).toEqual(["CRC", "USD"]);
  });

  it("an amount exactly at the total is not over", () => {
    const result = buildWeddingsOverview(
      [
        input(wedding(A), {
          totals: [{ currency: "USD", amountMinor: 100 }],
          vendors: [vendor("u", { currency: "USD", contractedAmountMinor: 100 })],
        }),
      ],
      NOW,
    );
    expect(result.attention).toEqual([]);
  });
});

describe("timeline (summary only)", () => {
  const entries = [
    slot("a", { startTime: "13:00", durationMinutes: 120 }),
    slot("b", { startTime: "15:00" }),
    slot("c", { startTime: "15:00", durationMinutes: 30 }),
    slot("d"),
  ];

  it("on the wedding day: counts plus current / next (LB-23 rules); never attention", () => {
    const now = new Date("2026-10-10T20:00:00Z"); // 14:00 in Costa Rica
    const result = buildWeddingsOverview(
      [input(wedding(A, { weddingDate: "2026-10-10" }), { timeline: ok(entries) })],
      now,
    );
    expect(result.weddings[0].timeline).toEqual(
      ok({
        entryCount: 4,
        timedCount: 3,
        untimedCount: 1,
        now: {
          time: "14:00",
          current: [{ id: "a", title: "Momento a" }],
          next: [
            { id: "b", title: "Momento b" },
            { id: "c", title: "Momento c" },
          ],
        },
      }),
    );
    expect(result.attention).toEqual([]);
  });

  it("the day after uses minutes ≥ 1440; other days and no zone: now is null", () => {
    const after = [slot("n", { dayOffset: 1, startTime: "01:00", durationMinutes: 60 })];
    const at = (iso: string, fields: Partial<WeddingSummary> = {}) =>
      buildWeddingsOverview(
        [input(wedding(A, { weddingDate: "2026-10-10", ...fields }), { timeline: ok(after) })],
        new Date(iso),
      ).weddings[0].timeline;
    expect(at("2026-10-11T07:30:00Z")).toMatchObject(ok({ now: { time: "01:30", current: [{ id: "n" }] } }));
    expect(at("2026-10-09T20:00:00Z")).toMatchObject(ok({ now: null }));
    expect(at("2026-10-13T20:00:00Z")).toMatchObject(ok({ now: null }));
    expect(at("2026-10-10T20:00:00Z", { timeZone: null })).toMatchObject(ok({ now: null }));
  });
});

// ------------------------------------------------------ completeness

describe("unavailable domains and all-clear", () => {
  const clear = () => input(wedding(A));

  it("all clear only when complete and nothing needs attention", () => {
    const result = buildWeddingsOverview([clear(), input(wedding(B))], NOW);
    expect(result).toMatchObject({
      status: "ready",
      attention: [],
      weddingsNeedingAttention: 0,
      unavailableDomains: [],
      complete: true,
      allClear: true,
    });
  });

  it.each(["checklist", "guests", "budget", "timeline"] as const)(
    "%s unavailable: never zero, never all clear",
    (domain) => {
      const result = buildWeddingsOverview([{ ...clear(), [domain]: UNAVAILABLE }, input(wedding(B))], NOW);
      expect(result.complete).toBe(false);
      expect(result.allClear).toBe(false);
      expect(result.unavailableDomains).toEqual([domain]);
      expect(result.weddings[0].unavailableDomains).toEqual([domain]);
      expect(result.weddings[1].unavailableDomains).toEqual([]);
      const own = domain === "budget" ? ["budget", "vendors"] : [domain];
      for (const key of own) {
        expect(result.weddings[0][key as "checklist"]).toEqual(UNAVAILABLE);
      }
    },
  );

  it("an unavailable domain derives none of its kinds (the others still do)", () => {
    const a = weddingA();
    const result = buildWeddingsOverview([{ ...a, budget: UNAVAILABLE }], NOW);
    expect(kinds(result.attention)).toEqual([`${A}:checklist_overdue`]);
    const noChecklist = buildWeddingsOverview([{ ...a, checklist: UNAVAILABLE }], NOW);
    expect(kinds(noChecklist.attention)).toEqual([`${A}:payment_overdue`]);
  });

  it("zero weddings: complete, nothing to do", () => {
    expect(buildWeddingsOverview([], NOW)).toEqual({
      status: "ready",
      weddings: [],
      attention: [],
      weddingsNeedingAttention: 0,
      unavailableDomains: [],
      complete: true,
      allClear: true,
    });
  });
});

describe("contract shape: no score, health or readiness anywhere", () => {
  it("exact keys of the result, a wedding and an item", () => {
    const result = buildWeddingsOverview([weddingA()], NOW);
    expect(Object.keys(result).sort()).toEqual(
      ["allClear", "attention", "complete", "status", "unavailableDomains", "weddings", "weddingsNeedingAttention"].sort(),
    );
    expect(Object.keys(result.weddings[0]).sort()).toEqual(
      [
        "attention",
        "attentionLevel",
        "budget",
        "checklist",
        "countdown",
        "guests",
        "timeline",
        "unavailableDomains",
        "vendors",
        "wedding",
      ].sort(),
    );
    expect(Object.keys(result.attention[0]).sort()).toEqual(
      ["amounts", "count", "destination", "id", "kind", "level", "since", "weddingId"].sort(),
    );
    expect(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
      /score|health|readiness|percentReady|risk/i,
    );
  });
});

// -------------------------------------------------------------- clock

describe("one request clock, each wedding's own time zone", () => {
  // At 10:30 UTC it is already Oct 11 in Kiritimati (UTC+14) and still Oct 9
  // in Pago Pago (UTC−11).
  const INSTANT = new Date("2026-10-10T10:30:00Z");
  const zoned = (id: string, timeZone: string) =>
    input(wedding(id, { weddingDate: "2026-10-10", timeZone }), {
      checklist: ok([absolute("2026-10-09"), absolute("2026-10-10")]),
    });
  const run = (now: Date) =>
    buildWeddingsOverview([zoned(A, "Pacific/Kiritimati"), zoned(B, "Pacific/Pago_Pago")], now);

  function expectZonedResult(result: ReturnType<typeof run>) {
    const [k, p] = result.weddings;
    expect(k.countdown).toEqual({ state: "after", days: 1 });
    expect(p.countdown).toEqual({ state: "before", days: 1 });
    expect(k.checklist).toMatchObject(ok({ overdueCount: 2 }));
    expect(p.checklist).toMatchObject(ok({ overdueCount: 0 }));
    expect(kinds(result.attention)).toEqual([`${A}:checklist_overdue`]);
  }

  it("opposite sides of midnight from the same instant", () => {
    expectZonedResult(run(INSTANT));
  });

  it("the system clock is never read: freezing it elsewhere changes nothing", () => {
    const real = run(INSTANT);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-03-03T03:03:03Z"));
    const frozen = run(INSTANT);
    expectZonedResult(frozen);
    expect(frozen).toEqual(real);
  });

  it("the process time zone is never used", () => {
    const previous = process.env.TZ;
    try {
      const results = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC", "America/Costa_Rica"].map((tz) => {
        process.env.TZ = tz;
        return run(INSTANT);
      });
      for (const result of results) {
        expectZonedResult(result);
        expect(result).toEqual(results[0]);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

// ------------------------------------------------- Batch 2: seeded weddings

describe("newly seeded weddings don't start overdue (Batch 2)", () => {
  // The shipped template's offsets (es v1: 38 items, one without a date).
  const TEMPLATE_OFFSETS = [
    -365, -360, -350, null, -330, -300, -300, -180, -270, -250, -240, -240, -150, -90, -60, -240, -120, -90, -60, -240,
    -180, -150, -90, -30, -270, -120, -60, -30, -120, -30, -30, -14, -14, -7, -3, -2, 3, 30,
  ] as const;
  const seededTemplate = (seededAt: string): ChecklistFacts[] =>
    TEMPLATE_OFFSETS.map((days) => ({
      status: "pending",
      timing: days === null ? { mode: "none" } : { mode: "relative_to_wedding", relativeDays: days },
      seededAt,
    }));
  const SEEDED_NOW = NOW.toISOString(); // seeded today (2026-10-10 in Costa Rica)
  const DAY = 24 * 60 * 60 * 1000;
  const fresh = [
    input(wedding(A, { weddingDate: "2026-11-28" }), { checklist: ok(seededTemplate(SEEDED_NOW)) }), // 49 days
    input(wedding(B, { weddingDate: "2027-02-06" }), { checklist: ok(seededTemplate(SEEDED_NOW)) }), // 119 days
    input(wedding(C, { weddingDate: "2027-06-07" }), { checklist: ok(seededTemplate(SEEDED_NOW)) }), // 240 days
  ];

  it("49, 119 and 240 days out: zero overdue and no 'Pendientes atrasados' right after seeding", () => {
    const result = buildWeddingsOverview(fresh, NOW);
    expect(result.weddings.map((w) => w.countdown)).toEqual([
      { state: "before", days: 49 },
      { state: "before", days: 119 },
      { state: "before", days: 240 },
    ]);
    for (const built of result.weddings) {
      expect(built.checklist).toMatchObject(ok({ overdueCount: 0, oldestOverdueOn: null }));
    }
    expect(kinds(result.attention).filter((id) => id.endsWith(":checklist_overdue"))).toEqual([]);
  });

  it("the next day, still-pending inherited items are overdue, dated from the seed day", () => {
    const result = buildWeddingsOverview(fresh, new Date(NOW.getTime() + DAY));
    const [a, b, c] = result.weddings;
    // Inherited items due on or before the seed day (2026-10-10); the raw-date
    // counts (26 / 20 / 9) are what the production smoke saw on the seed day itself.
    expect(a.checklist).toMatchObject(ok({ overdueCount: 26, oldestOverdueOn: "2026-10-10" }));
    expect(b.checklist).toMatchObject(ok({ overdueCount: 20, oldestOverdueOn: "2026-10-10" }));
    // 240 days: those 9, plus the four "-240" items that were due exactly on the seed day.
    expect(c.checklist).toMatchObject(ok({ overdueCount: 13, oldestOverdueOn: "2026-10-10" }));
  });

  it("regression: an older wedding with genuinely late items still shows overdue attention", () => {
    // Seeded a year ago, wedding 2026-12-12: "-90" (2026-09-13) and "-60" (2026-10-13 → not yet) etc.
    const old = input(wedding(D, { weddingDate: "2026-12-12" }), {
      checklist: ok([
        { status: "pending", timing: { mode: "relative_to_wedding", relativeDays: -90 }, seededAt: "2025-10-01T15:00:00Z" },
        { status: "pending", timing: { mode: "relative_to_wedding", relativeDays: -60 }, seededAt: "2025-10-01T15:00:00Z" },
        { status: "done", timing: { mode: "relative_to_wedding", relativeDays: -120 }, seededAt: "2025-10-01T15:00:00Z" },
        absolute("2026-09-30"),
      ]),
    });
    const result = buildWeddingsOverview([old], NOW);
    expect(result.weddings[0].checklist).toMatchObject(ok({ overdueCount: 2, oldestOverdueOn: "2026-09-13" }));
    expect(kinds(result.attention)).toContain(`${D}:checklist_overdue`);
  });
});
