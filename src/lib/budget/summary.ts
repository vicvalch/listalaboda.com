import { addDaysToIsoDate } from "@/lib/checklist/timing";
import { VENDOR_CURRENCIES, type VendorCurrency } from "@/lib/vendors/money";
import { VENDOR_CATEGORIES, type VendorCategory, type VendorStatus } from "@/lib/vendors/presentation";

/**
 * Budget and payment derivations (LB-22, ADR-015). Pure: no database, React
 * or clock. The caller reads the clock ONCE at the page boundary and passes
 * the wedding-local `today` (`YYYY-MM-DD`, or null without a wedding time
 * zone). Every sum is a BigInt, and amounts in different currencies are never
 * added together or converted: everything is per currency.
 *
 * Authority (never re-decided here):
 *   * committed = Σ contracted amount of BOOKED vendors that have one (LB-21);
 *   * a schedule item is an obligation, a payment is money paid;
 *   * every status (pending / partial / paid, overdue / due soon) is derived
 *     from those rows, never stored.
 */

/** Days after "today" that still count as "Vence pronto" (inclusive). */
export const DUE_SOON_DAYS = 14;

export type FinanceScheduleItem = Readonly<{ id: string; label: string; amountMinor: number; dueOn: string }>;

export type FinancePayment = Readonly<{
  id: string;
  amountMinor: number;
  paidOn: string;
  scheduleItemId: string | null;
  note: string | null;
}>;

/** A vendor with its financial children (one embedded read; children carry no currency). */
export type FinanceVendor = Readonly<{
  id: string;
  name: string;
  category: VendorCategory;
  customCategory: string | null;
  status: VendorStatus;
  currency: VendorCurrency | null;
  contractedAmountMinor: number | null;
  scheduleItems: readonly FinanceScheduleItem[];
  payments: readonly FinancePayment[];
}>;

export type BudgetTotal = Readonly<{ currency: VendorCurrency; amountMinor: number }>;
export type BudgetAllocation = Readonly<{ category: VendorCategory; currency: VendorCurrency; amountMinor: number }>;

const ZERO = BigInt(0);
const big = (minor: number) => BigInt(minor);
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, ZERO);

// ------------------------------------------------------------ schedule items

export type ItemProgress = "pending" | "partial" | "paid";
/** Only for an item with something left to pay, and only when "today" is known. */
export type ItemTiming = "overdue" | "due_soon" | "later";

export type ItemFinance = Readonly<{
  item: FinanceScheduleItem;
  paidMinor: bigint;
  remainingMinor: bigint;
  progress: ItemProgress;
  timing: ItemTiming | null;
  /** The one label shown first: Pagado > Vencido > Vence pronto > Parcial > Pendiente. */
  display: "paid" | "overdue" | "due_soon" | "partial" | "pending";
}>;

/**
 * Timing of a due date relative to the wedding-local `today`. Due today is
 * NOT overdue (it is "due soon", day 0); due in exactly 14 days is still
 * "due soon"; day 15 is "later". Without `today` (no wedding time zone):
 * null, never a guess. Calendar dates compare as strings.
 */
export function dueTiming(dueOn: string, today: string | null): ItemTiming | null {
  if (today === null) return null;
  if (dueOn < today) return "overdue";
  const horizon = addDaysToIsoDate(today, DUE_SOON_DAYS);
  if (horizon === null) return null;
  return dueOn <= horizon ? "due_soon" : "later";
}

export function itemFinance(
  item: FinanceScheduleItem,
  payments: readonly FinancePayment[],
  today: string | null,
): ItemFinance {
  const paidMinor = sum(payments.filter((p) => p.scheduleItemId === item.id).map((p) => big(p.amountMinor)));
  const amount = big(item.amountMinor);
  const remainingMinor = amount - paidMinor;
  const progress: ItemProgress = paidMinor === ZERO ? "pending" : paidMinor >= amount ? "paid" : "partial";
  const timing = remainingMinor > ZERO ? dueTiming(item.dueOn, today) : null;
  const display =
    progress === "paid"
      ? "paid"
      : timing === "overdue"
        ? "overdue"
        : timing === "due_soon"
          ? "due_soon"
          : progress;
  return { item, paidMinor, remainingMinor, progress, timing, display };
}

function compareItems(a: FinanceScheduleItem, b: FinanceScheduleItem): number {
  if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Newest first: paid date, then id. */
function comparePayments(a: FinancePayment, b: FinancePayment): number {
  if (a.paidOn !== b.paidOn) return a.paidOn < b.paidOn ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// -------------------------------------------------------------------- vendor

export type VendorFinance = Readonly<{
  vendor: FinanceVendor;
  /** Null without a contracted amount (then nothing can be scheduled or paid). */
  contractedMinor: bigint | null;
  paidMinor: bigint;
  /** contract − paid. */
  remainingMinor: bigint | null;
  /** Σ (item − its linked payments). */
  scheduledRemainingMinor: bigint;
  /** contract − Σ items − Σ unlinked payments: room not yet scheduled nor paid unscheduled. */
  unscheduledMinor: bigint | null;
  /** Σ items + Σ unlinked payments: the lowest contracted amount the database accepts. */
  recordedFloorMinor: bigint;
  unlinkedPaidMinor: bigint;
  /** Due date order. */
  items: readonly ItemFinance[];
  /** Newest first. */
  payments: readonly FinancePayment[];
  hasFinancialRecords: boolean;
}>;

/**
 * One vendor's money, in its own currency. With the database invariants
 * (Σ items + Σ unlinked ≤ contract, linked ≤ item) the identity
 * `remaining = scheduledRemaining + unscheduled` always holds.
 */
export function vendorFinance(vendor: FinanceVendor, today: string | null): VendorFinance {
  const items = [...vendor.scheduleItems].sort(compareItems).map((item) => itemFinance(item, vendor.payments, today));
  const paidMinor = sum(vendor.payments.map((p) => big(p.amountMinor)));
  const unlinkedPaidMinor = sum(vendor.payments.filter((p) => p.scheduleItemId === null).map((p) => big(p.amountMinor)));
  const scheduledMinor = sum(vendor.scheduleItems.map((item) => big(item.amountMinor)));
  const contractedMinor = vendor.contractedAmountMinor === null ? null : big(vendor.contractedAmountMinor);
  return {
    vendor,
    contractedMinor,
    paidMinor,
    remainingMinor: contractedMinor === null ? null : contractedMinor - paidMinor,
    scheduledRemainingMinor: sum(items.map((entry) => entry.remainingMinor)),
    unscheduledMinor: contractedMinor === null ? null : contractedMinor - scheduledMinor - unlinkedPaidMinor,
    recordedFloorMinor: scheduledMinor + unlinkedPaidMinor,
    unlinkedPaidMinor,
    items,
    payments: [...vendor.payments].sort(comparePayments),
    hasFinancialRecords: vendor.scheduleItems.length > 0 || vendor.payments.length > 0,
  };
}

/** Booked with a contracted amount (and therefore a currency): what counts as committed. */
export function isCommitted(vendor: FinanceVendor): vendor is FinanceVendor & { currency: VendorCurrency } {
  return vendor.status === "booked" && vendor.contractedAmountMinor !== null && vendor.currency !== null;
}

// ------------------------------------------------------------------- budget

/** A signed difference shown as "Disponible" (≥ 0) or "Sobre presupuesto" (< 0). */
export type Variance = Readonly<{ kind: "available" | "over"; amountMinor: bigint }>;

function variance(minuend: bigint, subtrahend: bigint): Variance {
  const difference = minuend - subtrahend;
  return difference < ZERO ? { kind: "over", amountMinor: -difference } : { kind: "available", amountMinor: difference };
}

export type CategoryBudget = Readonly<{
  category: VendorCategory;
  /** Null = "Sin presupuesto asignado" (never treated as zero). */
  budgetedMinor: bigint | null;
  committedMinor: bigint;
  /** Only when an allocation exists. */
  variance: Variance | null;
}>;

export type CurrencyBudget = Readonly<{
  currency: VendorCurrency;
  /** Null = no total estimate in this currency. */
  totalMinor: bigint | null;
  committedMinor: bigint;
  /** Every payment in this currency, whatever the vendor's status. */
  paidMinor: bigint;
  /** Booked vendors only: Σ (contract − that vendor's payments). */
  remainingMinor: bigint;
  /** Non-discarded vendors: Σ (item − its linked payments). */
  scheduledRemainingMinor: bigint;
  /** Booked vendors: Σ (contract − items − unlinked payments). */
  unscheduledMinor: bigint;
  overdueMinor: bigint;
  dueSoonMinor: bigint;
  /** total − committed; null without a total. */
  totalVariance: Variance | null;
  allocatedMinor: bigint;
  /** total − Σ allocations ("Sin asignar a categorías" / categories over the total); null without a total. */
  allocationVariance: Variance | null;
  /** Categories with an allocation or a commitment in this currency, in category order. */
  categories: readonly CategoryBudget[];
}>;

export type ScheduledObligation = Readonly<{
  vendorId: string;
  vendorName: string;
  currency: VendorCurrency;
  entry: ItemFinance;
}>;

export type BookedVendorLine = Readonly<{
  vendorId: string;
  vendorName: string;
  category: VendorCategory;
  customCategory: string | null;
  currency: VendorCurrency;
  contractedMinor: bigint;
  paidMinor: bigint;
  remainingMinor: bigint;
  unscheduledMinor: bigint;
}>;

/** A vendor not marked "Contratado" that already has payments: paid counts it, committed doesn't. */
export type AttentionVendor = Readonly<{
  vendorId: string;
  vendorName: string;
  status: VendorStatus;
  currency: VendorCurrency;
  paidMinor: bigint;
  paymentCount: number;
}>;

export type BudgetSummary = Readonly<{
  /** One independent block per currency in use (CRC, then USD). Never a combined total. */
  currencies: readonly CurrencyBudget[];
  /** Overdue obligations of non-discarded vendors, earliest first. */
  overdue: readonly ScheduledObligation[];
  /** Due within 14 days (today included), non-discarded vendors, earliest first. */
  dueSoon: readonly ScheduledObligation[];
  booked: readonly BookedVendorLine[];
  attention: readonly AttentionVendor[];
  /** Nothing to show: no estimate, no commitment, no schedule, no payment. */
  isEmpty: boolean;
  /** "Today" is unknown (no wedding time zone): no overdue / due-soon classification. */
  timingUnavailable: boolean;
}>;

export type BudgetInput = Readonly<{
  vendors: readonly FinanceVendor[];
  totals: readonly BudgetTotal[];
  allocations: readonly BudgetAllocation[];
  today: string | null;
}>;

const nameCollator = new Intl.Collator("es", { sensitivity: "base" });

function compareObligations(a: ScheduledObligation, b: ScheduledObligation): number {
  if (a.entry.item.dueOn !== b.entry.item.dueOn) return a.entry.item.dueOn < b.entry.item.dueOn ? -1 : 1;
  return nameCollator.compare(a.vendorName, b.vendorName) || compareItems(a.entry.item, b.entry.item);
}

export function summarizeBudget({ vendors, totals, allocations, today }: BudgetInput): BudgetSummary {
  const finances = vendors
    .filter((vendor): vendor is FinanceVendor & { currency: VendorCurrency } => vendor.currency !== null)
    .map((vendor) => ({ vendor, finance: vendorFinance(vendor, today) }));

  const currencies = VENDOR_CURRENCIES.flatMap((currency): CurrencyBudget[] => {
    const inCurrency = finances.filter(({ vendor }) => vendor.currency === currency);
    const committed = inCurrency.filter(({ vendor }) => isCommitted(vendor));
    const live = inCurrency.filter(({ vendor }) => vendor.status !== "discarded");
    const total = totals.find((t) => t.currency === currency);
    const currencyAllocations = allocations.filter((a) => a.currency === currency);

    const inUse =
      total !== undefined ||
      currencyAllocations.length > 0 ||
      committed.length > 0 ||
      inCurrency.some(({ finance }) => finance.hasFinancialRecords);
    if (!inUse) return [];

    const totalMinor = total ? big(total.amountMinor) : null;
    const committedMinor = sum(committed.map(({ finance }) => finance.contractedMinor ?? ZERO));
    const allocatedMinor = sum(currencyAllocations.map((a) => big(a.amountMinor)));
    const liveItems = live.flatMap(({ finance }) => finance.items);

    const categories = VENDOR_CATEGORIES.flatMap((category): CategoryBudget[] => {
      const allocation = currencyAllocations.find((a) => a.category === category);
      const inCategory = committed.filter(({ vendor }) => vendor.category === category);
      if (!allocation && inCategory.length === 0) return [];
      const categoryCommitted = sum(inCategory.map(({ finance }) => finance.contractedMinor ?? ZERO));
      const budgetedMinor = allocation ? big(allocation.amountMinor) : null;
      return [
        {
          category,
          budgetedMinor,
          committedMinor: categoryCommitted,
          variance: budgetedMinor === null ? null : variance(budgetedMinor, categoryCommitted),
        },
      ];
    });

    return [
      {
        currency,
        totalMinor,
        committedMinor,
        paidMinor: sum(inCurrency.map(({ finance }) => finance.paidMinor)),
        // Per booked vendor, never "committed − global paid": payments to
        // vendors that aren't booked must not shrink what is still owed.
        remainingMinor: sum(committed.map(({ finance }) => finance.remainingMinor ?? ZERO)),
        scheduledRemainingMinor: sum(live.map(({ finance }) => finance.scheduledRemainingMinor)),
        unscheduledMinor: sum(committed.map(({ finance }) => finance.unscheduledMinor ?? ZERO)),
        overdueMinor: sum(liveItems.filter((e) => e.timing === "overdue").map((e) => e.remainingMinor)),
        dueSoonMinor: sum(liveItems.filter((e) => e.timing === "due_soon").map((e) => e.remainingMinor)),
        totalVariance: totalMinor === null ? null : variance(totalMinor, committedMinor),
        allocatedMinor,
        allocationVariance: totalMinor === null ? null : variance(totalMinor, allocatedMinor),
        categories,
      },
    ];
  });

  const obligations = finances
    .filter(({ vendor }) => vendor.status !== "discarded")
    .flatMap(({ vendor, finance }) =>
      finance.items.map((entry) => ({ vendorId: vendor.id, vendorName: vendor.name, currency: vendor.currency, entry })),
    );

  const booked = finances
    .filter(({ vendor }) => isCommitted(vendor))
    .map(({ vendor, finance }) => ({
      vendorId: vendor.id,
      vendorName: vendor.name,
      category: vendor.category,
      customCategory: vendor.customCategory,
      currency: vendor.currency,
      contractedMinor: finance.contractedMinor ?? ZERO,
      paidMinor: finance.paidMinor,
      remainingMinor: finance.remainingMinor ?? ZERO,
      unscheduledMinor: finance.unscheduledMinor ?? ZERO,
    }))
    .sort((a, b) => nameCollator.compare(a.vendorName, b.vendorName) || (a.vendorId < b.vendorId ? -1 : 1));

  const attention = finances
    .filter(({ vendor }) => vendor.status !== "booked" && vendor.payments.length > 0)
    .map(({ vendor, finance }) => ({
      vendorId: vendor.id,
      vendorName: vendor.name,
      status: vendor.status,
      currency: vendor.currency,
      paidMinor: finance.paidMinor,
      paymentCount: vendor.payments.length,
    }))
    .sort((a, b) => nameCollator.compare(a.vendorName, b.vendorName) || (a.vendorId < b.vendorId ? -1 : 1));

  return {
    currencies,
    overdue: obligations.filter((o) => o.entry.timing === "overdue").sort(compareObligations),
    dueSoon: obligations.filter((o) => o.entry.timing === "due_soon").sort(compareObligations),
    booked,
    attention,
    isEmpty: currencies.length === 0,
    timingUnavailable: today === null,
  };
}
