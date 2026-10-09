import { describe, expect, it } from "vitest";

import {
  DUE_SOON_DAYS,
  dueTiming,
  itemFinance,
  summarizeBudget,
  vendorFinance,
  type FinancePayment,
  type FinanceScheduleItem,
  type FinanceVendor,
} from "@/lib/budget/summary";

// LB-22 (ADR-015): pure budget and payment derivations. Every amount is a
// BigInt; CRC and USD are never combined; "today" is always passed in.

const b = (n: number) => BigInt(n);

let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

function schedule(amountMinor: number, dueOn = "2026-12-01", label = "Cuota"): FinanceScheduleItem {
  return { id: nextId(), label, amountMinor, dueOn };
}

function payment(amountMinor: number, scheduleItemId: string | null = null, paidOn = "2026-10-01"): FinancePayment {
  return { id: nextId(), amountMinor, paidOn, scheduleItemId, note: null };
}

function vendor(fields: Partial<FinanceVendor> = {}): FinanceVendor {
  return {
    id: nextId(),
    name: "Proveedor",
    category: "photography",
    customCategory: null,
    status: "booked",
    currency: "CRC",
    contractedAmountMinor: 1_000_000,
    scheduleItems: [],
    payments: [],
    ...fields,
  };
}

const TODAY = "2026-10-20";

describe("dueTiming", () => {
  it("strictly before today is overdue; due today is NOT overdue", () => {
    expect(dueTiming("2026-10-19", TODAY)).toBe("overdue");
    expect(dueTiming("2026-10-20", TODAY)).toBe("due_soon");
  });

  it("due soon from day 0 through day 14 inclusive; day 15 is later", () => {
    expect(DUE_SOON_DAYS).toBe(14);
    expect(dueTiming("2026-11-03", TODAY)).toBe("due_soon");
    expect(dueTiming("2026-11-04", TODAY)).toBe("later");
  });

  it("crosses months and leap days as calendar dates", () => {
    expect(dueTiming("2028-03-13", "2028-02-28")).toBe("due_soon");
    expect(dueTiming("2028-03-14", "2028-02-28")).toBe("later");
  });

  it("without today (no wedding time zone) nothing is classified", () => {
    expect(dueTiming("2000-01-01", null)).toBeNull();
  });
});

describe("itemFinance", () => {
  it("pending → partial → paid from linked payments only", () => {
    const item = schedule(600_000, "2026-10-01");
    expect(itemFinance(item, [], TODAY)).toMatchObject({ paidMinor: b(0), remainingMinor: b(600_000), progress: "pending" });
    const partial = itemFinance(item, [payment(300_000, item.id), payment(999, null)], TODAY);
    expect(partial).toMatchObject({ paidMinor: b(300_000), remainingMinor: b(300_000), progress: "partial" });
    const paid = itemFinance(item, [payment(300_000, item.id), payment(300_000, item.id)], TODAY);
    expect(paid).toMatchObject({ paidMinor: b(600_000), remainingMinor: b(0), progress: "paid", timing: null, display: "paid" });
  });

  it("display precedence: Pagado > Vencido > Vence pronto > Parcial > Pendiente, keeping progress", () => {
    const overdue = schedule(600_000, "2026-10-01");
    const partialOverdue = itemFinance(overdue, [payment(300_000, overdue.id)], TODAY);
    // Partial progress is kept even though the label shown first is Vencido.
    expect(partialOverdue).toMatchObject({ display: "overdue", progress: "partial", paidMinor: b(300_000), remainingMinor: b(300_000) });

    const soon = schedule(100, "2026-10-25");
    expect(itemFinance(soon, [payment(50, soon.id)], TODAY)).toMatchObject({ display: "due_soon", progress: "partial" });
    const later = schedule(100, "2027-01-01");
    expect(itemFinance(later, [payment(50, later.id)], TODAY).display).toBe("partial");
    expect(itemFinance(later, [], TODAY).display).toBe("pending");
    // Without a time zone: progress only.
    expect(itemFinance(overdue, [], null)).toMatchObject({ display: "pending", timing: null });
  });
});

describe("vendorFinance: contract remaining = scheduled remaining + unscheduled", () => {
  function identity(v: FinanceVendor) {
    const f = vendorFinance(v, TODAY);
    expect(f.remainingMinor).toBe(f.scheduledRemainingMinor + f.unscheduledMinor!);
    return f;
  }

  it("no schedule", () => {
    const f = identity(vendor());
    expect(f).toMatchObject({ remainingMinor: b(1_000_000), scheduledRemainingMinor: b(0), unscheduledMinor: b(1_000_000) });
  });

  it("full schedule", () => {
    const f = identity(vendor({ scheduleItems: [schedule(400_000), schedule(600_000)] }));
    expect(f).toMatchObject({ scheduledRemainingMinor: b(1_000_000), unscheduledMinor: b(0), recordedFloorMinor: b(1_000_000) });
  });

  it("partial payments", () => {
    const a = schedule(400_000);
    const f = identity(vendor({ scheduleItems: [a, schedule(300_000)], payments: [payment(150_000, a.id)] }));
    expect(f).toMatchObject({ paidMinor: b(150_000), remainingMinor: b(850_000), scheduledRemainingMinor: b(550_000), unscheduledMinor: b(300_000) });
  });

  it("an unallocated payment consumes unscheduled room (not contract − schedule)", () => {
    const f = identity(vendor({ scheduleItems: [schedule(400_000)], payments: [payment(250_000)] }));
    expect(f).toMatchObject({ unscheduledMinor: b(350_000), unlinkedPaidMinor: b(250_000), recordedFloorMinor: b(650_000) });
  });

  it("mixed linked and unlinked payments", () => {
    const a = schedule(300_000);
    const c = schedule(200_000);
    const f = identity(
      vendor({ scheduleItems: [a, c], payments: [payment(300_000, a.id), payment(50_000, c.id), payment(100_000), payment(25_000)] }),
    );
    expect(f).toMatchObject({
      paidMinor: b(475_000),
      remainingMinor: b(525_000),
      scheduledRemainingMinor: b(150_000),
      unscheduledMinor: b(375_000),
    });
  });

  it("orders items by due date and payments newest first; no contract means nothing to derive", () => {
    const late = schedule(1, "2027-01-01");
    const early = schedule(1, "2026-01-01");
    const f = vendorFinance(
      vendor({ scheduleItems: [late, early], payments: [payment(1, null, "2026-01-01"), payment(2, null, "2026-05-01")] }),
      TODAY,
    );
    expect(f.items.map((e) => e.item.id)).toEqual([early.id, late.id]);
    expect(f.payments.map((p) => p.paidOn)).toEqual(["2026-05-01", "2026-01-01"]);
    expect(vendorFinance(vendor({ contractedAmountMinor: null }), TODAY)).toMatchObject({
      contractedMinor: null,
      remainingMinor: null,
      unscheduledMinor: null,
      hasFinancialRecords: false,
    });
  });
});

describe("summarizeBudget", () => {
  it("committed = booked contracts only; quotes and non-booked contracts never count", () => {
    const summary = summarizeBudget({
      vendors: [
        vendor({ contractedAmountMinor: 500_000 }),
        vendor({ status: "selected", contractedAmountMinor: 9_000_000 }),
        vendor({ status: "quoted", contractedAmountMinor: null }),
        vendor({ status: "booked", contractedAmountMinor: null }),
      ],
      totals: [],
      allocations: [],
      today: TODAY,
    });
    expect(summary.currencies).toHaveLength(1);
    expect(summary.currencies[0]!.committedMinor).toBe(b(500_000));
    expect(summary.booked).toHaveLength(1);
  });

  it("payments to a non-booked vendor count as paid, not committed, don't distort remaining, and need attention", () => {
    const booked = vendor({ name: "Fotos", contractedAmountMinor: 1_000_000, payments: [payment(200_000)] });
    const selected = vendor({ name: "Música", status: "selected", contractedAmountMinor: 800_000, payments: [payment(300_000)] });
    const summary = summarizeBudget({ vendors: [booked, selected], totals: [], allocations: [], today: TODAY });
    const crc = summary.currencies[0]!;
    expect(crc.committedMinor).toBe(b(1_000_000));
    expect(crc.paidMinor).toBe(b(500_000));
    // Per booked vendor, never committed − global paid (which would be 500 000).
    expect(crc.remainingMinor).toBe(b(800_000));
    expect(summary.attention).toEqual([
      expect.objectContaining({ vendorId: selected.id, status: "selected", paidMinor: b(300_000), paymentCount: 1 }),
    ]);
  });

  it("no attention when every vendor with payments is booked", () => {
    const summary = summarizeBudget({ vendors: [vendor({ payments: [payment(1)] })], totals: [], allocations: [], today: TODAY });
    expect(summary.attention).toEqual([]);
  });

  it("scheduled remaining, unscheduled, overdue and due soon", () => {
    const overdue = schedule(300_000, "2026-10-19");
    const today = schedule(200_000, "2026-10-20");
    const day14 = schedule(100_000, "2026-11-03");
    const day15 = schedule(50_000, "2026-11-04");
    const v = vendor({
      contractedAmountMinor: 1_000_000,
      scheduleItems: [overdue, today, day14, day15],
      payments: [payment(100_000, overdue.id), payment(50_000)],
    });
    const summary = summarizeBudget({ vendors: [v], totals: [], allocations: [], today: TODAY });
    const crc = summary.currencies[0]!;
    expect(crc.scheduledRemainingMinor).toBe(b(550_000));
    expect(crc.unscheduledMinor).toBe(b(300_000));
    expect(crc.remainingMinor).toBe(b(850_000));
    expect(crc.overdueMinor).toBe(b(200_000));
    expect(crc.dueSoonMinor).toBe(b(300_000));
    expect(summary.overdue.map((o) => o.entry.item.id)).toEqual([overdue.id]);
    expect(summary.dueSoon.map((o) => o.entry.item.id)).toEqual([today.id, day14.id]);
  });

  it("without a time zone: nothing overdue or due soon, flagged for the hint", () => {
    const v = vendor({ scheduleItems: [schedule(1, "2000-01-01")] });
    const summary = summarizeBudget({ vendors: [v], totals: [], allocations: [], today: null });
    expect(summary).toMatchObject({ overdue: [], dueSoon: [], timingUnavailable: true });
    expect(summary.currencies[0]!.overdueMinor).toBe(b(0));
  });

  it("discarded vendors' items stay out of global overdue / due soon / scheduled; their payments stay paid", () => {
    const item = schedule(100_000, "2026-10-01");
    const discarded = vendor({ status: "discarded", scheduleItems: [item], payments: [payment(30_000)] });
    const summary = summarizeBudget({ vendors: [discarded], totals: [], allocations: [], today: TODAY });
    expect(summary.overdue).toEqual([]);
    const crc = summary.currencies[0]!;
    expect(crc.overdueMinor).toBe(b(0));
    expect(crc.scheduledRemainingMinor).toBe(b(0));
    expect(crc.paidMinor).toBe(b(30_000));
    expect(crc.committedMinor).toBe(b(0));
    // ...and still in its own detail view.
    expect(vendorFinance(discarded, TODAY).items[0]!.timing).toBe("overdue");
  });

  it("category commitments and variance; a missing allocation is never zero", () => {
    const summary = summarizeBudget({
      vendors: [
        vendor({ category: "photography", contractedAmountMinor: 600_000 }),
        vendor({ category: "photography", contractedAmountMinor: 500_000 }),
        vendor({ category: "music", contractedAmountMinor: 300_000 }),
        vendor({ category: "other", customCategory: "Seguridad", contractedAmountMinor: 10 }),
        vendor({ category: "other", customCategory: "Pirotecnia", contractedAmountMinor: 20 }),
      ],
      totals: [],
      allocations: [
        { category: "photography", currency: "CRC", amountMinor: 1_000_000 },
        { category: "venue", currency: "CRC", amountMinor: 2_000_000 },
        { category: "music", currency: "CRC", amountMinor: 300_000 },
      ],
      today: TODAY,
    });
    const rows = Object.fromEntries(summary.currencies[0]!.categories.map((c) => [c.category, c]));
    expect(rows.venue).toEqual({
      category: "venue",
      budgetedMinor: b(2_000_000),
      committedMinor: b(0),
      variance: { kind: "available", amountMinor: b(2_000_000) },
    });
    expect(rows.photography!.variance).toEqual({ kind: "over", amountMinor: b(100_000) });
    expect(rows.music!.variance).toEqual({ kind: "available", amountMinor: b(0) });
    // `other` is one bucket for every custom type.
    expect(rows.other).toEqual({ category: "other", budgetedMinor: null, committedMinor: b(30), variance: null });
    expect(summary.currencies[0]!.categories.map((c) => c.category)).toEqual(["venue", "photography", "music", "other"]);
  });

  it("total variance, and allocations vs total (never enforced)", () => {
    const base = { vendors: [vendor({ contractedAmountMinor: 700_000 })], today: TODAY };
    const under = summarizeBudget({
      ...base,
      totals: [{ currency: "CRC", amountMinor: 1_000_000 }],
      allocations: [{ category: "venue", currency: "CRC", amountMinor: 400_000 }],
    }).currencies[0]!;
    expect(under.totalVariance).toEqual({ kind: "available", amountMinor: b(300_000) });
    expect(under.allocationVariance).toEqual({ kind: "available", amountMinor: b(600_000) });

    const over = summarizeBudget({
      ...base,
      totals: [{ currency: "CRC", amountMinor: 500_000 }],
      allocations: [
        { category: "venue", currency: "CRC", amountMinor: 400_000 },
        { category: "music", currency: "CRC", amountMinor: 300_000 },
      ],
    }).currencies[0]!;
    expect(over.totalVariance).toEqual({ kind: "over", amountMinor: b(200_000) });
    expect(over.allocationVariance).toEqual({ kind: "over", amountMinor: b(200_000) });
    expect(over.allocatedMinor).toBe(b(700_000));

    const noTotal = summarizeBudget({ ...base, totals: [], allocations: [] }).currencies[0]!;
    expect(noTotal).toMatchObject({ totalMinor: null, totalVariance: null, allocationVariance: null });
  });

  it("CRC and USD are separate blocks and are never added together", () => {
    const summary = summarizeBudget({
      vendors: [
        vendor({ currency: "CRC", contractedAmountMinor: 1_000_000, payments: [payment(100)] }),
        vendor({ currency: "USD", contractedAmountMinor: 250_000, payments: [payment(7)] }),
      ],
      totals: [
        { currency: "USD", amountMinor: 300_000 },
        { currency: "CRC", amountMinor: 1_200_000 },
      ],
      allocations: [{ category: "photography", currency: "USD", amountMinor: 200_000 }],
      today: TODAY,
    });
    expect(summary.currencies.map((c) => [c.currency, c.totalMinor, c.committedMinor, c.paidMinor])).toEqual([
      ["CRC", b(1_200_000), b(1_000_000), b(100)],
      ["USD", b(300_000), b(250_000), b(7)],
    ]);
    expect(summary.currencies[0]!.categories.every((c) => c.budgetedMinor !== b(200_000))).toBe(true);
    expect(summary.currencies[1]!.categories[0]).toMatchObject({ category: "photography", budgetedMinor: b(200_000) });
  });

  it("a currency block appears only when something uses it; empty when nothing does", () => {
    expect(summarizeBudget({ vendors: [], totals: [], allocations: [], today: TODAY })).toMatchObject({
      currencies: [],
      isEmpty: true,
    });
    const onlyUsdTotal = summarizeBudget({ vendors: [vendor({ status: "quoted" })], totals: [{ currency: "USD", amountMinor: 0 }], allocations: [], today: TODAY });
    expect(onlyUsdTotal.currencies.map((c) => c.currency)).toEqual(["USD"]);
    expect(onlyUsdTotal.isEmpty).toBe(false);
  });

  it("sums past the safe integer range exactly (BigInt)", () => {
    const max = 99_999_999_999_999;
    const summary = summarizeBudget({
      vendors: Array.from({ length: 100 }, () => vendor({ contractedAmountMinor: max })),
      totals: [],
      allocations: [],
      today: TODAY,
    });
    expect(summary.currencies[0]!.committedMinor).toBe(BigInt(max) * b(100));
  });
});
