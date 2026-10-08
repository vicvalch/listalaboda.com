/**
 * Vendor money (LB-21, ADR-014): quotes and contracted amounts in integer
 * MINOR units (céntimos / cents) of one currency. Pure: no database, React or
 * locale state.
 *
 * - Only CRC and USD are supported (an additive change adds more).
 * - Amounts are 0 – 99 999 999 999 999 minor units: always below
 *   `Number.MAX_SAFE_INTEGER`, so a stored amount is an exact JS integer.
 * - Parsing never goes through floating point (`parseFloat`/`Number` on a
 *   decimal string): the digits are assembled into an integer.
 * - Formatting goes through `Intl.NumberFormat` with an exact decimal string;
 *   amounts in different currencies are never added together.
 */

export const VENDOR_CURRENCIES = ["CRC", "USD"] as const;
export type VendorCurrency = (typeof VENDOR_CURRENCIES)[number];

export function isVendorCurrency(value: unknown): value is VendorCurrency {
  return typeof value === "string" && (VENDOR_CURRENCIES as readonly string[]).includes(value);
}

/** The database's upper bound (`wedding_vendors_*_amount_range`). */
export const MONEY_MAX_MINOR = 99_999_999_999_999;

/** Generous for "99.999.999.999.999,99" plus spaces; longer input is garbage. */
const MONEY_INPUT_MAX_LENGTH = 32;

export type MoneyParseResult =
  | Readonly<{ ok: true; value: number | null }>
  | Readonly<{ ok: false; reason: "invalid" | "too_large" }>;

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Plain digits, or digit groups "1.200.000" / "1,200" / "1 200" with ONE separator kind. */
function integerDigits(part: string): string | null {
  if (/^\d+$/.test(part)) return part;
  const separators = new Set(part.replace(/\d/g, ""));
  if (separators.size !== 1) return null;
  const [separator] = separators;
  const groups = part.split(separator!);
  const [first, ...rest] = groups;
  // A grouped number never starts with 0 ("0.001" is not one, it's garbage).
  if (!first || !/^[1-9]\d{0,2}$/.test(first) || rest.length === 0) return null;
  if (!rest.every((group) => /^\d{3}$/.test(group))) return null;
  return groups.join("");
}

/**
 * Typed amount → integer minor units. Blank → `{ ok: true, value: null }`.
 *
 * Accepted (Costa Rican / Spanish habits, no guessing):
 * - digits: `1200`;
 * - grouping with ONE separator kind, groups of exactly three digits:
 *   `1 200`, `1.200`, `1,200`, `1.200.000`;
 * - an optional decimal part of one or two digits after `.` or `,`:
 *   `1200.50`, `1200,5`, `1.200,50`, `1,200.50`.
 *
 * A single `.` or `,` followed by exactly three digits is grouping
 * (`1.200` = 1200, never 1.2). Anything else is refused rather than
 * reinterpreted: signs, letters, exponents, currency symbols, `1.2.3`, `0.001`,
 * `1,20,0`, `12..00`, `1200.500`, three decimals, leading/trailing separators.
 */
export function parseMoneyAmount(raw: string): MoneyParseResult {
  // Non-breaking and narrow no-break spaces are spaces too.
  const text = raw.replace(/[  ]/g, " ").trim();
  if (!text) return { ok: true, value: null };
  if (text.length > MONEY_INPUT_MAX_LENGTH || !/^[0-9][0-9 .,]*$/.test(text) || !/[0-9]$/.test(text)) {
    return { ok: false, reason: "invalid" };
  }

  const dots = count(text, ".");
  const commas = count(text, ",");
  let decimalSeparator: "." | "," | null = null;
  if (dots > 0 && commas > 0) {
    // Mixed: the LAST one is the decimal separator ("1.200,50", "1,200.50").
    decimalSeparator = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
  } else if (dots + commas === 1) {
    // One separator: decimals only when one or two digits follow it.
    const separator = dots === 1 ? "." : ",";
    const after = text.slice(text.indexOf(separator) + 1);
    if (/^\d{1,2}$/.test(after)) decimalSeparator = separator;
  }

  let integerPart = text;
  let fraction = "";
  if (decimalSeparator) {
    if (count(text, decimalSeparator) !== 1) return { ok: false, reason: "invalid" };
    const at = text.indexOf(decimalSeparator);
    integerPart = text.slice(0, at);
    fraction = text.slice(at + 1);
    if (!/^\d{1,2}$/.test(fraction)) return { ok: false, reason: "invalid" };
  }

  const digits = integerDigits(integerPart);
  if (digits === null) return { ok: false, reason: "invalid" };

  // Exact integer arithmetic (BigInt), compared before converting back.
  const minor = BigInt(digits) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(MONEY_MAX_MINOR)) return { ok: false, reason: "too_large" };
  return { ok: true, value: Number(minor) };
}

/** A stored amount: a whole number of minor units within the database range. */
export function isMoneyMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MONEY_MAX_MINOR;
}

/** Minor units → the exact decimal string "1234.50" (no floating point). */
function decimalString(minor: number | bigint): `${number}` {
  const digits = String(minor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}` as `${number}`;
}

/** Minor units → the plain editable form ("1200,50", "1200"): what a form field shows. */
export function moneyInputValue(minor: number | null): string {
  if (minor === null) return "";
  const [major, cents] = decimalString(minor).split(".");
  return cents === "00" ? major! : `${major},${cents}`;
}

/**
 * Spanish currency formatting: "2.400.000 ₡", "3.500 US$", "1.200,50 US$".
 * Cents are shown only when not zero. USD is labelled "US$", never a bare
 * "$" that could be read as another dollar.
 */
export function formatMoney(minor: number | bigint, currency: VendorCurrency): string {
  const value = decimalString(minor);
  const hasCents = !value.endsWith(".00");
  return new Intl.NumberFormat("es", {
    style: "currency",
    currency,
    currencyDisplay: currency === "CRC" ? "narrowSymbol" : "symbol",
    useGrouping: "always",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}
