/**
 * The closed financial refusals of LB-22 (ADR-015). Each is raised by a
 * database trigger as a check_violation (SQLSTATE 23514) whose message is
 * the named reason below, or derived from a NO ACTION foreign key on delete.
 * The services map them to these values; raw SQL never leaves them.
 */

export type FinancialFailureReason =
  | "contract_required"
  | "currency_locked"
  | "contract_below_recorded"
  | "schedule_exceeds_contract"
  | "schedule_item_below_paid"
  | "payment_exceeds_schedule_item"
  | "payment_exceeds_unscheduled"
  | "schedule_item_has_payments"
  | "has_financial_records";

/** Trigger message → reason. */
export const FINANCIAL_TRIGGER_REASONS: Readonly<Record<string, FinancialFailureReason>> = {
  vendor_contract_required: "contract_required",
  vendor_currency_locked: "currency_locked",
  vendor_contract_below_recorded: "contract_below_recorded",
  vendor_schedule_exceeds_contract: "schedule_exceeds_contract",
  vendor_schedule_item_below_paid: "schedule_item_below_paid",
  vendor_payment_exceeds_schedule_item: "payment_exceeds_schedule_item",
  vendor_payment_exceeds_unscheduled: "payment_exceeds_unscheduled",
};

export function financialTriggerReason(message: string | undefined): FinancialFailureReason | null {
  return (message !== undefined && Object.hasOwn(FINANCIAL_TRIGGER_REASONS, message) && FINANCIAL_TRIGGER_REASONS[message]) || null;
}
