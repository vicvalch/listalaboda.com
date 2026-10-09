import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { getWeddingBudget } from "@/lib/budget/service";
import {
  summarizeBudget,
  type BudgetSummary,
  type CurrencyBudget,
  type ScheduledObligation,
  type Variance,
} from "@/lib/budget/summary";
import { getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VENDOR_CURRENCIES, formatMoney, moneyInputValue, type VendorCurrency } from "@/lib/vendors/money";
import { VENDOR_CATEGORIES, vendorCategoryDisplay, vendorCategoryLabel, vendorStatusLabel } from "@/lib/vendors/presentation";
import { formatWeddingDate } from "@/lib/weddings/format";
import { weddingLocalToday } from "@/lib/weddings/timezone";

import { removeBudgetAmountAction, saveBudgetAmountAction } from "./actions";
import { BudgetAmountForm, BudgetRemoveButton } from "./BudgetForms";

export const metadata: Metadata = { title: getMessages().budget.title };

const copy = getMessages().budget;
const currencyNames = getMessages().vendors.currencies;

const disclosureSummaryClass =
  "inline-flex min-h-9 cursor-pointer list-none items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-accent-soft [&::-webkit-details-marker]:hidden";

/**
 * "Presupuesto" (LB-22, ADR-015): estimates, what is committed (booked
 * vendors' contracts), paid and still owed, per currency — CRC and USD are
 * independent blocks, never added or converted. An operations page: what is
 * overdue, what is due in the next 14 days, each category against its
 * estimate, the booked vendors, and payments that need attention.
 *
 * Membership is checked first (non-members get the same 404 as a missing
 * wedding). Then TWO reads, whatever the size: the wedding (time zone,
 * totals, allocations) and its vendors with schedule items and payments
 * embedded. The clock is read once, here; everything else is derived in
 * memory (`@/lib/budget/summary`).
 */
export default async function BudgetPage({ params }: PageProps<"/app/weddings/[weddingId]/budget">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/budget`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const budget = await getWeddingBudget(supabase, access.access);
  const id = access.access.weddingId;
  const today = budget?.timeZone ? weddingLocalToday(budget.timeZone, new Date()) : null;
  const summary = budget
    ? summarizeBudget({ vendors: budget.vendors, totals: budget.totals, allocations: budget.allocations, today })
    : null;

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        {budget ? <p className="text-muted text-sm font-semibold break-words">{budget.weddingName}</p> : null}
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p className="text-sm">
          <Link href={`/app/weddings/${id}`} className={textLinkClass}>
            {copy.backToChecklist}
          </Link>
        </p>
      </header>

      {summary === null ? (
        <Notice tone="error">{copy.loadFailed}</Notice>
      ) : (
        <BudgetView weddingId={id} summary={summary} />
      )}
    </div>
  );
}

function money(minor: bigint | number, currency: VendorCurrency): string {
  return formatMoney(minor, currency);
}

function BudgetView({ weddingId, summary }: { weddingId: string; summary: BudgetSummary }) {
  const unused = VENDOR_CURRENCIES.filter((currency) => !summary.currencies.some((c) => c.currency === currency));
  return (
    <>
      {summary.isEmpty ? (
        <section data-testid="budget-empty" className={`${cardClass} space-y-2`}>
          <h2 className="text-xl font-semibold">{copy.empty.title}</h2>
          <p className="text-muted">{copy.empty.body}</p>
          <p>
            <Link href={`/app/weddings/${weddingId}/vendors`} className={textLinkClass}>
              {copy.empty.vendorsLink}
            </Link>
          </p>
        </section>
      ) : null}

      {summary.currencies.map((block) => (
        <CurrencyBlock key={block.currency} weddingId={weddingId} block={block} />
      ))}

      {unused.length > 0 ? (
        <div className="space-y-3">
          {unused.map((currency) => (
            <details key={currency} data-testid={`budget-add-total-${currency}`}>
              <summary className={disclosureSummaryClass}>
                {`${copy.totalForm.open} · ${currencyNames[currency]}`}
              </summary>
              <div className={`${cardClass} mt-3`}>
                <TotalForm weddingId={weddingId} currency={currency} totalMinor={null} />
              </div>
            </details>
          ))}
        </div>
      ) : null}

      <ObligationSection
        id="overdue"
        title={copy.sections.overdue}
        items={summary.overdue}
        empty={copy.overdueEmpty}
        weddingId={weddingId}
        timingUnavailable={summary.timingUnavailable}
      />
      <ObligationSection
        id="due-soon"
        title={copy.sections.dueSoon}
        items={summary.dueSoon}
        empty={copy.dueSoonEmpty}
        weddingId={weddingId}
        timingUnavailable={summary.timingUnavailable}
      />

      <CategoriesSection weddingId={weddingId} summary={summary} />
      <BookedSection weddingId={weddingId} summary={summary} />
      {summary.attention.length > 0 ? <AttentionSection weddingId={weddingId} summary={summary} /> : null}
    </>
  );
}

function varianceText(variance: Variance, currency: VendorCurrency): { label: string; amount: string } {
  return {
    label: variance.kind === "over" ? copy.figures.over : copy.figures.available,
    amount: money(variance.amountMinor, currency),
  };
}

function CurrencyBlock({ weddingId, block }: { weddingId: string; block: CurrencyBudget }) {
  const { currency } = block;
  const variance = block.totalVariance ? varianceText(block.totalVariance, currency) : null;
  const figures: { key: string; label: string; value: string; hint?: string; tone?: string }[] = [
    {
      key: "total",
      label: copy.figures.total,
      value: block.totalMinor === null ? copy.figures.undefined : money(block.totalMinor, currency),
    },
    { key: "committed", label: copy.figures.committed, value: money(block.committedMinor, currency), hint: copy.figureHints.committed },
    { key: "paid", label: copy.figures.paid, value: money(block.paidMinor, currency), hint: copy.figureHints.paid },
    { key: "remaining", label: copy.figures.remaining, value: money(block.remainingMinor, currency), hint: copy.figureHints.remaining },
    {
      key: "unscheduled",
      label: copy.figures.unscheduled,
      value: money(block.unscheduledMinor, currency),
      hint: copy.figureHints.unscheduled,
    },
  ];
  if (variance) {
    figures.push({
      key: "variance",
      label: variance.label,
      value: variance.amount,
      tone: block.totalVariance?.kind === "over" ? "text-danger" : undefined,
    });
  }
  const allocation = block.allocationVariance;

  return (
    <section
      aria-labelledby={`budget-${currency}-title`}
      className={`${cardClass} space-y-5`}
      data-testid={`budget-currency-${currency}`}
    >
      <h2 id={`budget-${currency}-title`} className="text-2xl font-semibold tracking-tight">
        {copy.currencyTitle[currency]}
      </h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2 lg:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.key} className="min-w-0" data-testid={`budget-${currency}-${figure.key}`}>
            <dt className="text-muted text-sm">{figure.label}</dt>
            <dd className={`text-xl font-semibold tabular-nums break-words ${figure.tone ?? ""}`}>{figure.value}</dd>
            {figure.hint ? <dd className="text-muted text-xs">{figure.hint}</dd> : null}
          </div>
        ))}
      </dl>
      {allocation && block.allocatedMinor > BigInt(0) ? (
        <p className="text-sm" data-testid={`budget-${currency}-allocation`}>
          {interpolate(allocation.kind === "over" ? copy.allocation.overAllocated : copy.allocation.unallocated, {
            amount: money(allocation.amountMinor, currency),
          })}
        </p>
      ) : null}
      <details>
        <summary className={disclosureSummaryClass}>
          {block.totalMinor === null ? copy.totalForm.open : copy.totalForm.edit}
        </summary>
        <div className="mt-3">
          <TotalForm weddingId={weddingId} currency={currency} totalMinor={block.totalMinor} />
        </div>
      </details>
    </section>
  );
}

function TotalForm({
  weddingId,
  currency,
  totalMinor,
}: {
  weddingId: string;
  currency: VendorCurrency;
  totalMinor: bigint | null;
}) {
  const hidden = { weddingId, currency };
  return (
    <div className="space-y-3">
      <BudgetAmountForm
        action={saveBudgetAmountAction}
        hidden={hidden}
        id={`budget-total-${currency}`}
        amountLabel={interpolate(copy.totalForm.label, { currency: currencyNames[currency] })}
        amountHint={getMessages().vendors.fields.amountHint}
        defaultAmount={totalMinor === null ? "" : moneyInputValue(Number(totalMinor))}
        submitLabel={copy.totalForm.save}
        pendingLabel={copy.totalForm.saving}
      />
      {totalMinor !== null ? (
        <BudgetRemoveButton
          action={removeBudgetAmountAction}
          hidden={hidden}
          label={copy.totalForm.remove}
          pendingLabel={copy.totalForm.removing}
          hint={copy.totalForm.removeHint}
        />
      ) : null}
    </div>
  );
}

function ObligationSection({
  id,
  title,
  items,
  empty,
  weddingId,
  timingUnavailable,
}: {
  id: string;
  title: string;
  items: readonly ScheduledObligation[];
  empty: string;
  weddingId: string;
  timingUnavailable: boolean;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3" data-testid={`budget-${id}`}>
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      {timingUnavailable ? (
        <p className="text-muted text-sm" data-testid={`budget-${id}-no-timezone`}>
          {copy.timingUnavailable}
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {items.map(({ vendorId, vendorName, currency, entry }) => (
            <li key={entry.item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4">
              <div className="min-w-0 space-y-0.5">
                <Link
                  href={`/app/weddings/${weddingId}/vendors/${vendorId}`}
                  className={`${textLinkClass} break-words`}
                >
                  {interpolate(copy.obligation, { vendor: vendorName, label: entry.item.label })}
                </Link>
                <p className="text-muted text-sm">
                  {interpolate(copy.obligationDue, { date: formatWeddingDate(entry.item.dueOn) })}
                  {" · "}
                  <span className={entry.timing === "overdue" ? "text-danger font-semibold" : "font-semibold"}>
                    {getMessages().payments.states[entry.display]}
                  </span>
                </p>
              </div>
              <p className="font-semibold tabular-nums">
                {interpolate(copy.obligationRemaining, { amount: money(entry.remainingMinor, currency) })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CategoriesSection({ weddingId, summary }: { weddingId: string; summary: BudgetSummary }) {
  const c = copy.categories;
  const categoryOptions = VENDOR_CATEGORIES.map((value) => ({ value, label: vendorCategoryLabel(value) }));
  return (
    <section aria-labelledby="categories-title" className="space-y-4" data-testid="budget-categories">
      <div className="space-y-1">
        <h2 id="categories-title" className="text-xl font-semibold">
          {copy.sections.categories}
        </h2>
        <p className="text-muted text-sm">{c.intro}</p>
        <p className="text-muted text-sm">{c.otherHint}</p>
      </div>

      {summary.currencies
        .filter((block) => block.categories.length > 0)
        .map((block) => (
          <div key={block.currency} className="space-y-2" data-testid={`budget-categories-${block.currency}`}>
            <h3 className="font-semibold">{copy.currencyTitle[block.currency]}</h3>
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
              {block.categories.map((row) => {
                const label = vendorCategoryLabel(row.category);
                const currencyName = currencyNames[block.currency];
                const hidden = { weddingId, currency: block.currency, category: row.category };
                return (
                  <li
                    key={row.category}
                    className="space-y-2 p-4"
                    data-testid={`budget-category-${block.currency}-${row.category}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="font-semibold">{label}</p>
                      <p className="text-sm tabular-nums">
                        {interpolate(c.committed, { amount: money(row.committedMinor, block.currency) })}
                      </p>
                    </div>
                    <p className="text-sm tabular-nums">
                      {row.budgetedMinor === null ? (
                        <span className="text-muted">{c.none}</span>
                      ) : (
                        <>
                          {interpolate(c.budgeted, { amount: money(row.budgetedMinor, block.currency) })}
                          {row.variance ? (
                            <span className={`block font-semibold ${row.variance.kind === "over" ? "text-danger" : ""}`}>
                              {interpolate(row.variance.kind === "over" ? c.over : c.available, {
                                amount: money(row.variance.amountMinor, block.currency),
                              })}
                            </span>
                          ) : null}
                        </>
                      )}
                    </p>
                    <div className="flex flex-wrap items-start gap-2">
                      <details className="w-full sm:w-auto">
                        <summary
                          className={disclosureSummaryClass}
                          aria-label={interpolate(c.editLabel, { category: label, currency: currencyName })}
                        >
                          {c.edit}
                        </summary>
                        <div className="mt-3">
                          <BudgetAmountForm
                            action={saveBudgetAmountAction}
                            hidden={hidden}
                            id={`budget-category-${block.currency}-${row.category}`}
                            amountLabel={c.amount}
                            defaultAmount={row.budgetedMinor === null ? "" : moneyInputValue(Number(row.budgetedMinor))}
                            submitLabel={c.save}
                            pendingLabel={c.saving}
                          />
                        </div>
                      </details>
                      {row.budgetedMinor !== null ? (
                        <BudgetRemoveButton
                          action={removeBudgetAmountAction}
                          hidden={hidden}
                          label={c.remove}
                          ariaLabel={interpolate(c.removeLabel, { category: label, currency: currencyName })}
                          pendingLabel={copy.totalForm.removing}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

      <details>
        <summary className={disclosureSummaryClass}>{c.add}</summary>
        <div className={`${cardClass} mt-3 space-y-3`}>
          {VENDOR_CURRENCIES.map((currency) => (
            <div key={currency} className="space-y-2">
              <h3 className="font-semibold">{copy.currencyTitle[currency]}</h3>
              <BudgetAmountForm
                action={saveBudgetAmountAction}
                hidden={{ weddingId, currency }}
                id={`budget-category-new-${currency}`}
                amountLabel={c.amount}
                defaultAmount=""
                categorySelect={{ label: c.category, placeholder: c.chooseCategory, options: categoryOptions }}
                submitLabel={c.save}
                pendingLabel={c.saving}
              />
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function BookedSection({ weddingId, summary }: { weddingId: string; summary: BudgetSummary }) {
  const b = copy.booked;
  return (
    <section aria-labelledby="booked-title" className="space-y-3" data-testid="budget-booked">
      <h2 id="booked-title" className="text-xl font-semibold">
        {copy.sections.booked}
      </h2>
      {summary.booked.length === 0 ? (
        <p className="text-muted">{b.empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {summary.booked.map((line) => (
            <li key={line.vendorId} className="space-y-1 p-4" data-testid={`budget-booked-${line.vendorId}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <Link
                  href={`/app/weddings/${weddingId}/vendors/${line.vendorId}`}
                  className={`${textLinkClass} break-words`}
                  aria-label={interpolate(b.open, { vendor: line.vendorName })}
                >
                  {line.vendorName}
                </Link>
                <span className="text-muted text-sm">{vendorCategoryDisplay(line)}</span>
              </div>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
                <span>{interpolate(b.contracted, { amount: money(line.contractedMinor, line.currency) })}</span>
                <span>{interpolate(b.paid, { amount: money(line.paidMinor, line.currency) })}</span>
                <span className="font-semibold">
                  {interpolate(b.remaining, { amount: money(line.remainingMinor, line.currency) })}
                </span>
                <span>{interpolate(b.unscheduled, { amount: money(line.unscheduledMinor, line.currency) })}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionSection({ weddingId, summary }: { weddingId: string; summary: BudgetSummary }) {
  const a = copy.attention;
  return (
    <section
      aria-labelledby="attention-title"
      className="space-y-3 rounded-2xl border border-danger/40 bg-danger-soft p-5"
      data-testid="budget-attention"
    >
      <h2 id="attention-title" className="text-xl font-semibold">
        {`${copy.sections.attention}: ${a.title}`}
      </h2>
      <p className="text-sm">{a.body}</p>
      <ul className="space-y-1">
        {summary.attention.map((line) => (
          <li key={line.vendorId} className="text-sm break-words">
            <Link
              href={`/app/weddings/${weddingId}/vendors/${line.vendorId}`}
              className={textLinkClass}
              aria-label={interpolate(a.open, { vendor: line.vendorName })}
            >
              {interpolate(a.line, {
                vendor: line.vendorName,
                status: vendorStatusLabel(line.status),
                amount: money(line.paidMinor, line.currency),
              })}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
