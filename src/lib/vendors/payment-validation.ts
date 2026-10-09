import { es } from "@/lib/i18n/messages/es";
import { MONEY_MAX_MINOR, moneyInputValue, parseMoneyAmount } from "@/lib/vendors/money";

/**
 * Schedule item and payment form validation (LB-22, ADR-015). Mirrors the
 * `vendor_payment_schedule_items` / `vendor_payments` CHECKs so the organizer
 * gets a Spanish message per field before a round-trip; the service runs it
 * again before any write, and the database stays authoritative (including
 * every sum: contract, item and unscheduled caps are trigger-enforced under
 * the vendor row lock, never here).
 *
 * Amounts reuse the LB-21 money parser (`@/lib/vendors/money`) and must be
 * greater than zero. Dates are calendar dates (`YYYY-MM-DD`) compared as
 * strings, never turned into Date objects. Past dates are allowed.
 */

export const SCHEDULE_LABEL_MAX_LENGTH = 80;
export const PAYMENT_NOTE_MAX_LENGTH = 500;

// Control characters (C0, DEL, C1): labels and notes are single-line plain text.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type FieldResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

const v = es.payments.validation;

function length(value: string): number {
  return [...value].length;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * A real calendar date `YYYY-MM-DD` (years 0001–9999, leap days included),
 * the form an `<input type="date">` posts. No range restriction beyond that:
 * past and future dates are valid.
 */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

export function parseCalendarDate(raw: string, messages: Readonly<{ required: string; invalid: string }>): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, error: messages.required };
  return isCalendarDate(value) ? { ok: true, value } : { ok: false, error: messages.invalid };
}

/** Required, greater than zero, within the LB-21 money range. */
export function parsePositiveAmount(raw: string): FieldResult<number> {
  const result = parseMoneyAmount(raw);
  if (!result.ok) return { ok: false, error: result.reason === "too_large" ? v.amountTooLarge : v.amountInvalid };
  if (result.value === null) return { ok: false, error: v.amountRequired };
  if (result.value === 0) return { ok: false, error: v.amountZero };
  return { ok: true, value: result.value };
}

export function parseScheduleLabel(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, error: v.labelRequired };
  if (length(value) > SCHEDULE_LABEL_MAX_LENGTH) return { ok: false, error: v.labelTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.labelInvalid };
  return { ok: true, value };
}

/** Optional, one line ("SINPE #8842", "Transferencia BAC", "Efectivo"). Blank → null. */
export function parsePaymentNote(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (length(value) > PAYMENT_NOTE_MAX_LENGTH) return { ok: false, error: v.noteTooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.noteInvalid };
  return { ok: true, value };
}

/** Blank → "Sin cuota" (null). Otherwise an item id; whose item it is, the database decides. */
export function parseScheduleItemChoice(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  return UUID_PATTERN.test(value) ? { ok: true, value } : { ok: false, error: v.scheduleItemInvalid };
}

// ------------------------------------------------------------ schedule items

export type ScheduleItemField = "label" | "amount" | "dueOn";
export type ScheduleItemFormValues = Readonly<Record<ScheduleItemField, string>>;
export type ScheduleItemInput = Readonly<{ label: string; amountMinor: number; dueOn: string }>;

export type ScheduleItemInputResult =
  | Readonly<{ ok: true; input: ScheduleItemInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<ScheduleItemField, string>> }>;

export function parseScheduleItemInput(raw: ScheduleItemFormValues): ScheduleItemInputResult {
  const label = parseScheduleLabel(raw.label);
  const amount = parsePositiveAmount(raw.amount);
  const dueOn = parseCalendarDate(raw.dueOn, { required: v.dueOnRequired, invalid: v.dateInvalid });
  if (label.ok && amount.ok && dueOn.ok) {
    return { ok: true, input: { label: label.value, amountMinor: amount.value, dueOn: dueOn.value } };
  }
  const fieldErrors: Partial<Record<ScheduleItemField, string>> = {};
  if (!label.ok) fieldErrors.label = label.error;
  if (!amount.ok) fieldErrors.amount = amount.error;
  if (!dueOn.ok) fieldErrors.dueOn = dueOn.error;
  return { ok: false, fieldErrors };
}

export function scheduleItemFormValues(input: ScheduleItemInput): ScheduleItemFormValues {
  return { label: input.label, amount: moneyInputValue(input.amountMinor), dueOn: input.dueOn };
}

/** The service's re-check: exactly what `parseScheduleItemInput` produces. */
export function isValidScheduleItemInput(input: ScheduleItemInput): boolean {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > MONEY_MAX_MINOR) {
    return false;
  }
  const reparsed = parseScheduleItemInput(scheduleItemFormValues(input));
  return (
    reparsed.ok &&
    reparsed.input.label === input.label &&
    reparsed.input.amountMinor === input.amountMinor &&
    reparsed.input.dueOn === input.dueOn
  );
}

// ------------------------------------------------------------------ payments

export type PaymentField = "amount" | "paidOn" | "scheduleItemId" | "note";
export type PaymentFormValues = Readonly<Record<PaymentField, string>>;
export type PaymentInput = Readonly<{
  amountMinor: number;
  paidOn: string;
  /** Null = "Sin cuota" (an unallocated payment). */
  scheduleItemId: string | null;
  note: string | null;
}>;

export type PaymentInputResult =
  | Readonly<{ ok: true; input: PaymentInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<PaymentField, string>> }>;

export function parsePaymentInput(raw: PaymentFormValues): PaymentInputResult {
  const amount = parsePositiveAmount(raw.amount);
  const paidOn = parseCalendarDate(raw.paidOn, { required: v.paidOnRequired, invalid: v.dateInvalid });
  const scheduleItemId = parseScheduleItemChoice(raw.scheduleItemId);
  const note = parsePaymentNote(raw.note);
  if (amount.ok && paidOn.ok && scheduleItemId.ok && note.ok) {
    return {
      ok: true,
      input: { amountMinor: amount.value, paidOn: paidOn.value, scheduleItemId: scheduleItemId.value, note: note.value },
    };
  }
  const fieldErrors: Partial<Record<PaymentField, string>> = {};
  if (!amount.ok) fieldErrors.amount = amount.error;
  if (!paidOn.ok) fieldErrors.paidOn = paidOn.error;
  if (!scheduleItemId.ok) fieldErrors.scheduleItemId = scheduleItemId.error;
  if (!note.ok) fieldErrors.note = note.error;
  return { ok: false, fieldErrors };
}

export function paymentFormValues(input: PaymentInput): PaymentFormValues {
  return {
    amount: moneyInputValue(input.amountMinor),
    paidOn: input.paidOn,
    scheduleItemId: input.scheduleItemId ?? "",
    note: input.note ?? "",
  };
}

/** The service's re-check: exactly what `parsePaymentInput` produces. */
export function isValidPaymentInput(input: PaymentInput): boolean {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > MONEY_MAX_MINOR) {
    return false;
  }
  const reparsed = parsePaymentInput(paymentFormValues(input));
  return (
    reparsed.ok &&
    reparsed.input.amountMinor === input.amountMinor &&
    reparsed.input.paidOn === input.paidOn &&
    reparsed.input.scheduleItemId === input.scheduleItemId &&
    reparsed.input.note === input.note
  );
}
