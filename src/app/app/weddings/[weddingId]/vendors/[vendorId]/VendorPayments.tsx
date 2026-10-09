import { cardClass } from "@/components/ui/styles";
import type { ItemFinance, VendorFinance } from "@/lib/budget/summary";
import { getMessages, interpolate } from "@/lib/i18n";
import { formatMoney, type VendorCurrency } from "@/lib/vendors/money";
import { paymentFormValues, scheduleItemFormValues } from "@/lib/vendors/payment-validation";
import { formatWeddingDate } from "@/lib/weddings/format";

import { ConfirmButton } from "../../guests/ConfirmButton";
import {
  createScheduleItemAction,
  deletePaymentAction,
  deleteScheduleItemAction,
  recordPaymentAction,
  updatePaymentAction,
  updateScheduleItemAction,
} from "./payment-actions";
import { PaymentForm } from "./PaymentForm";
import { ScheduleItemForm } from "./ScheduleItemForm";

const copy = getMessages().payments;

const disclosureSummaryClass =
  "inline-flex min-h-9 cursor-pointer list-none items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-accent-soft [&::-webkit-details-marker]:hidden";

/** Timing and progress as words (never only color). */
const stateClass: Record<ItemFinance["display"], string> = {
  paid: "border-success/40 text-success",
  overdue: "border-danger bg-danger-soft text-danger",
  due_soon: "border-accent text-accent",
  partial: "border-border",
  pending: "border-border text-muted",
};

type Props = {
  weddingId: string;
  /** Derived with the wedding-local "today" (null without a time zone). */
  finance: VendorFinance;
  currency: VendorCurrency | null;
  timingUnavailable: boolean;
};

/**
 * "Pagos" on the vendor page (LB-22, ADR-015): the vendor's contract,
 * obligations (cuotas) and payments, all in the vendor's own currency.
 * Every state shown is derived from rows (never stored). Without a contracted
 * amount nothing can be scheduled or paid, so no forms are shown.
 */
export function VendorPayments({ weddingId, finance, currency, timingUnavailable }: Props) {
  const vendorId = finance.vendor.id;
  const contracted = finance.contractedMinor;

  if (contracted === null || currency === null) {
    return (
      <section aria-labelledby="payments-title" className={`${cardClass} space-y-2`} data-testid="vendor-payments">
        <h2 id="payments-title" className="text-xl font-semibold">
          {copy.title}
        </h2>
        <p className="text-muted" data-testid="payments-no-contract">
          {copy.noContract}
        </p>
      </section>
    );
  }

  const money = (minor: bigint | number) => formatMoney(minor, currency);
  const currencyName = getMessages().vendors.currencies[currency];
  const figures: { key: string; label: string; value: bigint }[] = [
    { key: "contracted", label: copy.figures.contracted, value: contracted },
    { key: "paid", label: copy.figures.paid, value: finance.paidMinor },
    { key: "remaining", label: copy.figures.remaining, value: finance.remainingMinor ?? BigInt(0) },
    { key: "scheduled-remaining", label: copy.figures.scheduledRemaining, value: finance.scheduledRemainingMinor },
    { key: "unscheduled", label: copy.figures.unscheduled, value: finance.unscheduledMinor ?? BigInt(0) },
  ];
  const itemOptions = finance.items.map(({ item, remainingMinor }) => ({
    value: item.id,
    label: interpolate(copy.fields.itemOption, {
      label: item.label,
      date: formatWeddingDate(item.dueOn),
      amount: money(remainingMinor),
    }),
  }));
  const itemLabel = new Map(finance.items.map(({ item }) => [item.id, item.label]));
  const keys = { weddingId, vendorId };

  return (
    <section aria-labelledby="payments-title" className={`${cardClass} space-y-8`} data-testid="vendor-payments">
      <div className="space-y-4">
        <h2 id="payments-title" className="text-xl font-semibold">
          {copy.title}
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {figures.map((figure) => (
            <div key={figure.key} className="min-w-0" data-testid={`payments-${figure.key}`}>
              <dt className="text-muted text-sm">{figure.label}</dt>
              <dd className="font-semibold tabular-nums break-words">{money(figure.value)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <section aria-labelledby="schedule-title" className="space-y-4">
        <h3 id="schedule-title" className="text-lg font-semibold">
          {copy.schedule.title}
        </h3>
        {timingUnavailable && finance.items.length > 0 ? (
          <p className="text-muted text-sm">{getMessages().budget.timingUnavailable}</p>
        ) : null}
        {finance.items.length === 0 ? (
          <p className="text-muted">{copy.schedule.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border" data-testid="schedule-items">
            {finance.items.map((entry) => (
              <ScheduleItemRow
                key={entry.item.id}
                entry={entry}
                weddingId={weddingId}
                vendorId={vendorId}
                money={money}
                currencyName={currencyName}
              />
            ))}
          </ul>
        )}
        <details>
          <summary className={disclosureSummaryClass}>{copy.schedule.create}</summary>
          <div className="mt-4">
            <ScheduleItemForm
              action={createScheduleItemAction}
              {...keys}
              id="new-schedule-item"
              defaults={{ label: "", amount: "", dueOn: "" }}
              currencyName={currencyName}
              submitLabel={copy.schedule.create}
              pendingLabel={copy.schedule.creating}
            />
          </div>
        </details>
      </section>

      <section aria-labelledby="payments-list-title" className="space-y-4">
        <h3 id="payments-list-title" className="text-lg font-semibold">
          {copy.list.title}
        </h3>
        {finance.payments.length === 0 ? (
          <p className="text-muted">{copy.list.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border" data-testid="payments-list">
            {finance.payments.map((payment) => {
              const date = formatWeddingDate(payment.paidOn);
              const amount = money(payment.amountMinor);
              const label = payment.scheduleItemId ? itemLabel.get(payment.scheduleItemId) : undefined;
              return (
                <li key={payment.id} className="space-y-2 p-4" data-testid={`payment-${payment.id}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-semibold tabular-nums">{amount}</p>
                    <p className="text-muted text-sm">{interpolate(copy.list.paidOn, { date })}</p>
                  </div>
                  <p className="text-sm break-words" data-testid="payment-allocation">
                    {label ? interpolate(copy.list.appliedTo, { label }) : copy.list.noItem}
                  </p>
                  {payment.note ? <p className="text-muted text-sm break-words">{payment.note}</p> : null}
                  <div className="flex flex-wrap items-start gap-2">
                    <details className="w-full sm:w-auto">
                      <summary
                        className={disclosureSummaryClass}
                        aria-label={interpolate(copy.list.editLabel, { amount, date })}
                      >
                        {copy.list.edit}
                      </summary>
                      <div className="mt-3">
                        <PaymentForm
                          action={updatePaymentAction}
                          {...keys}
                          paymentId={payment.id}
                          id={`edit-payment-${payment.id}`}
                          defaults={paymentFormValues(payment)}
                          itemOptions={itemOptions}
                          currencyName={currencyName}
                          submitLabel={copy.list.save}
                          pendingLabel={copy.list.saving}
                        />
                      </div>
                    </details>
                    <ConfirmButton
                      action={deletePaymentAction}
                      hidden={{ ...keys, paymentId: payment.id }}
                      id={`delete-payment-${payment.id}`}
                      openLabel={copy.list.delete}
                      openAriaLabel={interpolate(copy.list.deleteLabel, { amount, date })}
                      confirmTitle={interpolate(copy.list.deleteTitle, { amount, date })}
                      confirmBody={[copy.list.deleteBody]}
                      confirmLabel={copy.list.deleteConfirm}
                      cancelLabel={copy.list.cancel}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <details>
          <summary className={disclosureSummaryClass}>{copy.list.record}</summary>
          <div className="mt-4">
            <PaymentForm
              action={recordPaymentAction}
              {...keys}
              id="new-payment"
              defaults={{ amount: "", paidOn: "", scheduleItemId: "", note: "" }}
              itemOptions={itemOptions}
              currencyName={currencyName}
              submitLabel={copy.list.record}
              pendingLabel={copy.list.recording}
            />
          </div>
        </details>
      </section>
    </section>
  );
}

function ScheduleItemRow({
  entry,
  weddingId,
  vendorId,
  money,
  currencyName,
}: {
  entry: ItemFinance;
  weddingId: string;
  vendorId: string;
  money: (minor: bigint | number) => string;
  currencyName: string;
}) {
  const { item, paidMinor, remainingMinor, display } = entry;
  const keys = { weddingId, vendorId };
  return (
    <li className="space-y-2 p-4" data-testid={`schedule-item-${item.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-semibold break-words" data-testid="schedule-item-label">
          {item.label}
        </p>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-sm font-semibold ${stateClass[display]}`}
          data-testid="schedule-item-state"
        >
          {copy.states[display]}
        </span>
      </div>
      <p className="text-muted text-sm">{interpolate(copy.schedule.dueOn, { date: formatWeddingDate(item.dueOn) })}</p>
      <p className="text-sm tabular-nums" data-testid="schedule-item-progress">
        {paidMinor > BigInt(0)
          ? interpolate(copy.schedule.paid, { paid: money(paidMinor), amount: money(item.amountMinor) })
          : interpolate(copy.schedule.amount, { amount: money(item.amountMinor) })}
        {remainingMinor > BigInt(0) ? (
          <span className="block">{interpolate(copy.schedule.remaining, { amount: money(remainingMinor) })}</span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <details className="w-full sm:w-auto">
          <summary className={disclosureSummaryClass} aria-label={interpolate(copy.schedule.editLabel, { label: item.label })}>
            {copy.schedule.edit}
          </summary>
          <div className="mt-3">
            <ScheduleItemForm
              action={updateScheduleItemAction}
              {...keys}
              itemId={item.id}
              id={`edit-item-${item.id}`}
              defaults={scheduleItemFormValues(item)}
              currencyName={currencyName}
              submitLabel={copy.schedule.save}
              pendingLabel={copy.schedule.saving}
            />
          </div>
        </details>
        {paidMinor > BigInt(0) ? (
          // The database refuses it too (NO ACTION); say why up front.
          <p className="text-muted text-sm" data-testid="schedule-item-delete-blocked">
            {copy.schedule.deleteBlocked}
          </p>
        ) : (
          <ConfirmButton
            action={deleteScheduleItemAction}
            hidden={{ ...keys, itemId: item.id }}
            id={`delete-item-${item.id}`}
            openLabel={copy.schedule.delete}
            openAriaLabel={interpolate(copy.schedule.deleteLabel, { label: item.label })}
            confirmTitle={interpolate(copy.schedule.deleteTitle, { label: item.label })}
            confirmBody={[copy.schedule.deleteBody]}
            confirmLabel={copy.schedule.deleteConfirm}
            cancelLabel={copy.schedule.cancel}
          />
        )}
      </div>
    </li>
  );
}
