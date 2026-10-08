import { CONTACT_EMAIL_MAX_LENGTH, normalizeContactEmail } from "@/lib/guests/contact-email";
import { es } from "@/lib/i18n/messages/es";
import { isVendorCurrency, moneyInputValue, parseMoneyAmount, type VendorCurrency } from "@/lib/vendors/money";
import {
  DEFAULT_VENDOR_STATUS,
  INSTAGRAM_HANDLE_PATTERN,
  PHONE_PATTERN,
  isVendorCategory,
  isVendorStatus,
  type VendorCategory,
  type VendorStatus,
} from "@/lib/vendors/presentation";

/**
 * Vendor form validation (LB-21, ADR-014). Mirrors the `wedding_vendors`
 * CHECKs so the organizer gets a Spanish message per field before a
 * round-trip; the service runs it again before any write and the database
 * stays authoritative. Text is kept as typed (trimmed, never re-cased); the
 * only rewrites are documented ones: the email's DOMAIN is lowercased (the
 * guest contact-email rule), one leading "@" is dropped from an Instagram
 * handle, and a custom category or currency that can't apply is dropped (a
 * custom category outside `other`; a currency without any amount).
 *
 * The vendor email is informational only: nothing here (or anywhere) sends to it.
 */

export const VENDOR_NAME_MAX_LENGTH = 120;
export const VENDOR_CUSTOM_CATEGORY_MAX_LENGTH = 60;
export const VENDOR_CONTACT_NAME_MAX_LENGTH = 120;
export const VENDOR_PHONE_MIN_LENGTH = 4;
export const VENDOR_PHONE_MAX_LENGTH = 40;
export const VENDOR_INSTAGRAM_MAX_LENGTH = 30;
export const VENDOR_NOTES_MAX_LENGTH = 4000;

// Control characters (C0, DEL, C1): plain text only.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// Notes may span lines: line feed, carriage return and tab are allowed.
const NOTES_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export type VendorField =
  | "name"
  | "category"
  | "customCategory"
  | "status"
  | "contactName"
  | "email"
  | "phone"
  | "instagramHandle"
  | "currency"
  | "quotedAmount"
  | "contractedAmount"
  | "notes";

/** What a vendor form posts: every field as typed. */
export type VendorFormValues = Readonly<Record<VendorField, string>>;

/** A normalized vendor, exactly as it is stored. */
export type VendorInput = Readonly<{
  name: string;
  category: VendorCategory;
  customCategory: string | null;
  status: VendorStatus;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  instagramHandle: string | null;
  currency: VendorCurrency | null;
  quotedAmountMinor: number | null;
  contractedAmountMinor: number | null;
  notes: string | null;
}>;

export type VendorInputResult =
  | Readonly<{ ok: true; input: VendorInput }>
  | Readonly<{ ok: false; fieldErrors: Partial<Record<VendorField, string>> }>;

type FieldResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

const v = es.vendors.validation;

function length(value: string): number {
  return [...value].length;
}

function plainText(
  raw: string,
  max: number,
  messages: Readonly<{ required?: string; tooLong: string; invalid: string }>,
): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return messages.required ? { ok: false, error: messages.required } : { ok: true, value: null };
  if (length(value) > max) return { ok: false, error: messages.tooLong };
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: messages.invalid };
  return { ok: true, value };
}

export function parseVendorName(raw: string): FieldResult<string> {
  const result = plainText(raw, VENDOR_NAME_MAX_LENGTH, {
    required: v.nameRequired,
    tooLong: v.nameTooLong,
    invalid: v.nameInvalid,
  });
  if (!result.ok) return result;
  return result.value === null ? { ok: false, error: v.nameRequired } : { ok: true, value: result.value };
}

export function parseVendorCategory(raw: string): FieldResult<VendorCategory> {
  const value = raw.trim();
  return isVendorCategory(value) ? { ok: true, value } : { ok: false, error: v.categoryRequired };
}

/** Required for `other`; ignored (null) for every built-in category. */
export function parseVendorCustomCategory(raw: string, category: VendorCategory | null): FieldResult<string | null> {
  if (category !== "other") return { ok: true, value: null };
  return plainText(raw, VENDOR_CUSTOM_CATEGORY_MAX_LENGTH, {
    required: v.customCategoryRequired,
    tooLong: v.customCategoryTooLong,
    invalid: v.customCategoryInvalid,
  });
}

/** Blank → "En evaluación". Any status may follow any other: no transition rules. */
export function parseVendorStatus(raw: string): FieldResult<VendorStatus> {
  const value = raw.trim();
  if (!value) return { ok: true, value: DEFAULT_VENDOR_STATUS };
  return isVendorStatus(value) ? { ok: true, value } : { ok: false, error: v.statusInvalid };
}

export function parseVendorContactName(raw: string): FieldResult<string | null> {
  return plainText(raw, VENDOR_CONTACT_NAME_MAX_LENGTH, {
    tooLong: v.contactNameTooLong,
    invalid: v.contactNameInvalid,
  });
}

/** The guest contact-email rules (LB-11): trimmed, ASCII, domain lowercased, local part as typed. */
export function parseVendorEmail(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > CONTACT_EMAIL_MAX_LENGTH) return { ok: false, error: v.emailTooLong };
  const normalized = normalizeContactEmail(value);
  return normalized ? { ok: true, value: normalized } : { ok: false, error: v.emailInvalid };
}

/** Kept exactly as typed (no E.164): 4–40 characters of digits and common separators. */
export function parseVendorPhone(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length < VENDOR_PHONE_MIN_LENGTH || value.length > VENDOR_PHONE_MAX_LENGTH || !PHONE_PATTERN.test(value)) {
    return { ok: false, error: v.phoneInvalid };
  }
  return { ok: true, value };
}

/** The handle only: one leading "@" is accepted and dropped; URLs are refused. */
export function parseVendorInstagram(raw: string): FieldResult<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const value = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return INSTAGRAM_HANDLE_PATTERN.test(value) ? { ok: true, value } : { ok: false, error: v.instagramInvalid };
}

export function parseVendorAmount(raw: string): FieldResult<number | null> {
  const result = parseMoneyAmount(raw);
  if (result.ok) return result;
  return { ok: false, error: result.reason === "too_large" ? v.amountTooLarge : v.amountInvalid };
}

/**
 * Trimmed, ≤ 4000 characters, multiline. Line endings are kept as typed
 * (browsers post CRLF); the database allows \n, \r and \t only.
 */
export function parseVendorNotes(raw: string): FieldResult<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (length(value) > VENDOR_NOTES_MAX_LENGTH) return { ok: false, error: v.notesTooLong };
  if (NOTES_CONTROL_CHARACTERS.test(value)) return { ok: false, error: v.notesInvalid };
  return { ok: true, value };
}

/**
 * Every field at once, with one Spanish message per invalid field.
 *
 * Money: a currency is required as soon as either amount is present; with no
 * amount at all the currency is dropped (a preselected currency is never
 * stored on its own).
 */
export function parseVendorInput(raw: VendorFormValues): VendorInputResult {
  const fieldErrors: Partial<Record<VendorField, string>> = {};
  const take = <T>(field: VendorField, result: FieldResult<T>): T | undefined => {
    if (result.ok) return result.value;
    fieldErrors[field] = result.error;
    return undefined;
  };

  const name = take("name", parseVendorName(raw.name));
  const category = take("category", parseVendorCategory(raw.category));
  const customCategory = take("customCategory", parseVendorCustomCategory(raw.customCategory, category ?? null));
  const status = take("status", parseVendorStatus(raw.status));
  const contactName = take("contactName", parseVendorContactName(raw.contactName));
  const email = take("email", parseVendorEmail(raw.email));
  const phone = take("phone", parseVendorPhone(raw.phone));
  const instagramHandle = take("instagramHandle", parseVendorInstagram(raw.instagramHandle));
  const quotedAmountMinor = take("quotedAmount", parseVendorAmount(raw.quotedAmount));
  const contractedAmountMinor = take("contractedAmount", parseVendorAmount(raw.contractedAmount));
  const notes = take("notes", parseVendorNotes(raw.notes));

  const currencyText = raw.currency.trim();
  // Anything typed counts as an amount (even an invalid one): it needs a currency.
  const amountTyped = raw.quotedAmount.trim() !== "" || raw.contractedAmount.trim() !== "";
  let currency: VendorCurrency | null = null;
  if (currencyText && !isVendorCurrency(currencyText)) {
    fieldErrors.currency = v.currencyInvalid;
  } else if (amountTyped) {
    if (isVendorCurrency(currencyText)) currency = currencyText;
    else fieldErrors.currency = v.currencyRequired;
  }

  if (
    Object.keys(fieldErrors).length > 0 ||
    name === undefined ||
    category === undefined ||
    customCategory === undefined ||
    status === undefined ||
    contactName === undefined ||
    email === undefined ||
    phone === undefined ||
    instagramHandle === undefined ||
    quotedAmountMinor === undefined ||
    contractedAmountMinor === undefined ||
    notes === undefined
  ) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    input: {
      name,
      category,
      customCategory,
      status,
      contactName,
      email,
      phone,
      instagramHandle,
      currency,
      quotedAmountMinor,
      contractedAmountMinor,
      notes,
    },
  };
}

/** A stored/parsed vendor back to form text: what an edit form starts with. */
export function vendorFormValues(input: VendorInput): VendorFormValues {
  return {
    name: input.name,
    category: input.category,
    customCategory: input.customCategory ?? "",
    status: input.status,
    contactName: input.contactName ?? "",
    email: input.email ?? "",
    phone: input.phone ?? "",
    instagramHandle: input.instagramHandle ?? "",
    currency: input.currency ?? "",
    quotedAmount: moneyInputValue(input.quotedAmountMinor),
    contractedAmount: moneyInputValue(input.contractedAmountMinor),
    notes: input.notes ?? "",
  };
}

function sameInput(a: VendorInput, b: VendorInput): boolean {
  return (Object.keys(a) as (keyof VendorInput)[]).every((key) => a[key] === b[key]);
}

/**
 * The service's re-check: a `VendorInput` is accepted only if it is already
 * exactly what `parseVendorInput` produces (normalized, consistent, in
 * range). Never trusts that a caller parsed it.
 */
export function isValidVendorInput(input: VendorInput): boolean {
  if (
    (input.quotedAmountMinor !== null && !Number.isSafeInteger(input.quotedAmountMinor)) ||
    (input.contractedAmountMinor !== null && !Number.isSafeInteger(input.contractedAmountMinor))
  ) {
    return false;
  }
  const reparsed = parseVendorInput(vendorFormValues(input));
  // A currency without any amount is dropped by the parser: refuse it here.
  return reparsed.ok && sameInput(reparsed.input, input);
}
