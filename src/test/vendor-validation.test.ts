import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import { VENDOR_CATEGORIES, VENDOR_STATUSES } from "@/lib/vendors/presentation";
import {
  isValidVendorInput,
  parseVendorInput,
  vendorFormValues,
  type VendorFormValues,
  type VendorInput,
} from "@/lib/vendors/validation";

// LB-21 (ADR-014): the vendor form's validation, mirroring the wedding_vendors
// CHECKs (tested against the database in tests/db/wedding-vendors.test.ts).

const v = es.vendors.validation;

const BLANK: VendorFormValues = {
  name: "",
  category: "",
  customCategory: "",
  status: "",
  contactName: "",
  email: "",
  phone: "",
  instagramHandle: "",
  currency: "",
  quotedAmount: "",
  contractedAmount: "",
  notes: "",
};

function form(overrides: Partial<VendorFormValues>): VendorFormValues {
  return { ...BLANK, name: "Floristería Las Gardenias", category: "flowers_decor", ...overrides };
}

function parsed(overrides: Partial<VendorFormValues>): VendorInput {
  const result = parseVendorInput(form(overrides));
  if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.fieldErrors)}`);
  return result.input;
}

function errors(overrides: Partial<VendorFormValues>) {
  const result = parseVendorInput(form(overrides));
  if (result.ok) throw new Error("expected errors");
  return result.fieldErrors;
}

describe("parseVendorInput", () => {
  it("accepts a minimal vendor: blank optional fields become null, status defaults to En evaluación", () => {
    expect(parsed({})).toEqual({
      name: "Floristería Las Gardenias",
      category: "flowers_decor",
      customCategory: null,
      status: "considering",
      contactName: null,
      email: null,
      phone: null,
      instagramHandle: null,
      currency: null,
      quotedAmountMinor: null,
      contractedAmountMinor: null,
      notes: null,
    });
  });

  it("accepts a complete vendor, trimmed, as typed", () => {
    expect(
      parsed({
        name: "  Foto Estudio Luz  ",
        category: "photography",
        status: "booked",
        contactName: "  Andrea Solís ",
        email: "  Andrea.Solis@Example.COM ",
        phone: " +506 8888-1234 ",
        instagramHandle: " @foto.luz_cr ",
        currency: "USD",
        quotedAmount: "3.800",
        contractedAmount: "3.500,50",
        notes: "  Incluye sesión previa.\r\nPagar en dos tractos.\t ",
      }),
    ).toEqual({
      name: "Foto Estudio Luz",
      category: "photography",
      customCategory: null,
      status: "booked",
      contactName: "Andrea Solís",
      // Only the domain is lowercased (the guest contact-email rule).
      email: "Andrea.Solis@example.com",
      phone: "+506 8888-1234",
      instagramHandle: "foto.luz_cr",
      currency: "USD",
      quotedAmountMinor: 380_000,
      contractedAmountMinor: 350_050,
      notes: "Incluye sesión previa.\r\nPagar en dos tractos.",
    });
  });

  // ---------------------------------------------------------------- name

  it("requires a name of 1–120 plain-text characters", () => {
    expect(errors({ name: "" })).toEqual({ name: v.nameRequired });
    expect(errors({ name: "   " })).toEqual({ name: v.nameRequired });
    expect(parsed({ name: "x".repeat(120) }).name).toHaveLength(120);
    expect(errors({ name: "x".repeat(121) })).toEqual({ name: v.nameTooLong });
    // Counted in characters, not UTF-16 units.
    expect(parsed({ name: "💐".repeat(120) }).name).toBe("💐".repeat(120));
    expect(errors({ name: "Flores\u0007" })).toEqual({ name: v.nameInvalid });
    expect(errors({ name: "Flores\nDos" })).toEqual({ name: v.nameInvalid });
    expect(errors({ name: "Flores\u0085" })).toEqual({ name: v.nameInvalid });
  });

  // ------------------------------------------------------------ category

  it("accepts every category and refuses anything else", () => {
    for (const category of VENDOR_CATEGORIES) {
      const extra = category === "other" ? { customCategory: "Seguridad" } : {};
      expect(parsed({ category, ...extra }).category).toBe(category);
    }
    for (const category of ["", "florist", "Photography", "OTHER", " venue x"]) {
      expect(errors({ category })).toMatchObject({ category: v.categoryRequired });
    }
  });

  it("requires a custom category for Otro, 1–60 plain-text characters", () => {
    expect(parsed({ category: "other", customCategory: "  Seguridad " }).customCategory).toBe("Seguridad");
    expect(errors({ category: "other", customCategory: "" })).toEqual({ customCategory: v.customCategoryRequired });
    expect(errors({ category: "other", customCategory: "  " })).toEqual({ customCategory: v.customCategoryRequired });
    expect(parsed({ category: "other", customCategory: "x".repeat(60) }).customCategory).toHaveLength(60);
    expect(errors({ category: "other", customCategory: "x".repeat(61) })).toEqual({
      customCategory: v.customCategoryTooLong,
    });
    expect(errors({ category: "other", customCategory: "Segu\u0000ridad" })).toEqual({
      customCategory: v.customCategoryInvalid,
    });
  });

  it("drops a custom category for any built-in category (a leftover from switching away from Otro)", () => {
    expect(parsed({ category: "photography", customCategory: "Fotos" }).customCategory).toBeNull();
  });

  // -------------------------------------------------------------- status

  it("accepts the five statuses; blank is En evaluación; anything else is refused", () => {
    for (const status of VENDOR_STATUSES) expect(parsed({ status }).status).toBe(status);
    expect(parsed({ status: "" }).status).toBe("considering");
    for (const status of ["contacted", "completed", "paid", "archived", "BOOKED"]) {
      expect(errors({ status })).toEqual({ status: v.statusInvalid });
    }
  });

  // ------------------------------------------------------------- contact

  it("validates the contact name like the vendor name, but optional", () => {
    expect(parsed({ contactName: "" }).contactName).toBeNull();
    expect(parsed({ contactName: "x".repeat(120) }).contactName).toHaveLength(120);
    expect(errors({ contactName: "x".repeat(121) })).toEqual({ contactName: v.contactNameTooLong });
    expect(errors({ contactName: "Ana\tSolís" })).toEqual({ contactName: v.contactNameInvalid });
  });

  it("normalizes email like a guest contact email: domain lowercased, local part kept", () => {
    expect(parsed({ email: "Ventas@Flores.CR" }).email).toBe("Ventas@flores.cr");
    expect(parsed({ email: "" }).email).toBeNull();
    for (const email of ["sin-arroba", "a@b", "a b@c.com", "ñandú@flores.cr", "a@flores..cr", "@flores.cr", "a@@b.cr"]) {
      expect(errors({ email }), email).toEqual({ email: v.emailInvalid });
    }
    expect(errors({ email: `${"a".repeat(250)}@b.cr` })).toEqual({ email: v.emailTooLong });
  });

  it("keeps a phone as typed: 4–40 characters, digits and common separators", () => {
    for (const phone of ["8888-1234", "+506 8888 1234", "(506) 2222-3333", "+1 (555) 010.9999", "2222"]) {
      expect(parsed({ phone }).phone, phone).toBe(phone);
    }
    expect(parsed({ phone: "" }).phone).toBeNull();
    for (const phone of ["123", "abc-1234", "8888-1234 ext 2", "+", "--1234", "1234-", "+506 8888 1234#", "1".repeat(41), "tel:88881234"]) {
      expect(errors({ phone }), phone).toEqual({ phone: v.phoneInvalid });
    }
  });

  it("stores an Instagram handle without @ and refuses URLs", () => {
    expect(parsed({ instagramHandle: "floreria.gardenias" }).instagramHandle).toBe("floreria.gardenias");
    expect(parsed({ instagramHandle: "@Flores_CR" }).instagramHandle).toBe("Flores_CR");
    expect(parsed({ instagramHandle: "x".repeat(30) }).instagramHandle).toHaveLength(30);
    expect(parsed({ instagramHandle: "" }).instagramHandle).toBeNull();
    for (const handle of [
      "@",
      "@@flores",
      "x".repeat(31),
      "flores cr",
      "flores-cr",
      "https://www.instagram.com/flores/",
      "instagram.com/flores",
      "javascript:alert(1)",
      "flores/",
      "flóres",
    ]) {
      expect(errors({ instagramHandle: handle }), handle).toEqual({ instagramHandle: v.instagramInvalid });
    }
  });

  // --------------------------------------------------------------- money

  it("stores amounts as integer minor units with their currency", () => {
    expect(parsed({ currency: "CRC", quotedAmount: "1.200.000" })).toMatchObject({
      currency: "CRC",
      quotedAmountMinor: 120_000_000,
      contractedAmountMinor: null,
    });
    expect(parsed({ currency: "USD", contractedAmount: "3500" })).toMatchObject({
      currency: "USD",
      quotedAmountMinor: null,
      contractedAmountMinor: 350_000,
    });
    expect(parsed({ currency: "USD", quotedAmount: "0", contractedAmount: "0" })).toMatchObject({
      quotedAmountMinor: 0,
      contractedAmountMinor: 0,
    });
  });

  it("requires a currency when either amount is typed", () => {
    expect(errors({ quotedAmount: "1200" })).toEqual({ currency: v.currencyRequired });
    expect(errors({ contractedAmount: "1200" })).toEqual({ currency: v.currencyRequired });
    // Even when the amount itself is invalid: both problems are reported.
    expect(errors({ quotedAmount: "1.2.3" })).toEqual({ quotedAmount: v.amountInvalid, currency: v.currencyRequired });
  });

  it("drops a currency when there is no amount (a preselection is never stored on its own)", () => {
    expect(parsed({ currency: "CRC" }).currency).toBeNull();
    expect(parsed({ currency: "USD", quotedAmount: "  ", contractedAmount: "" }).currency).toBeNull();
  });

  it("supports only CRC and USD", () => {
    for (const currency of ["EUR", "MXN", "crc", "US$", "₡"]) {
      expect(errors({ currency, quotedAmount: "100" }), currency).toEqual({ currency: v.currencyInvalid });
    }
  });

  it("refuses malformed and too-large amounts per field", () => {
    expect(errors({ currency: "CRC", quotedAmount: "-5" })).toEqual({ quotedAmount: v.amountInvalid });
    expect(errors({ currency: "CRC", contractedAmount: "1e6" })).toEqual({ contractedAmount: v.amountInvalid });
    expect(errors({ currency: "CRC", quotedAmount: "1000000000000" })).toEqual({ quotedAmount: v.amountTooLarge });
  });

  // --------------------------------------------------------------- notes

  it("keeps multiline notes up to 4000 characters and refuses other controls", () => {
    expect(parsed({ notes: "Línea 1\nLínea 2\r\n\tLínea 3" }).notes).toBe("Línea 1\nLínea 2\r\n\tLínea 3");
    expect(parsed({ notes: " \n " }).notes).toBeNull();
    expect(parsed({ notes: "x".repeat(4000) }).notes).toHaveLength(4000);
    expect(errors({ notes: "x".repeat(4001) })).toEqual({ notes: v.notesTooLong });
    expect(errors({ notes: "Hola\u0000" })).toEqual({ notes: v.notesInvalid });
    expect(errors({ notes: "Hola\u000bmundo" })).toEqual({ notes: v.notesInvalid });
    expect(errors({ notes: "Hola\u0085mundo" })).toEqual({ notes: v.notesInvalid });
  });

  it("reports every invalid field at once", () => {
    const result = parseVendorInput({
      ...BLANK,
      email: "x",
      phone: "x",
      instagramHandle: "x y",
      quotedAmount: "abc",
    });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        name: v.nameRequired,
        category: v.categoryRequired,
        email: v.emailInvalid,
        phone: v.phoneInvalid,
        instagramHandle: v.instagramInvalid,
        quotedAmount: v.amountInvalid,
        currency: v.currencyRequired,
      },
    });
  });
});

describe("vendorFormValues + isValidVendorInput", () => {
  const complete = parsed({
    name: "Banquetes Ríos",
    category: "other",
    customCategory: "Seguridad",
    status: "quoted",
    contactName: "Luis",
    email: "Luis@rios.cr",
    phone: "2222-3333",
    instagramHandle: "rios",
    currency: "CRC",
    quotedAmount: "1.250.000,50",
    notes: "Hola\nmundo",
  });

  it("round-trips a stored vendor through the edit form", () => {
    expect(parseVendorInput(vendorFormValues(complete))).toEqual({ ok: true, input: complete });
    expect(isValidVendorInput(complete)).toBe(true);
  });

  it("refuses inputs that were not normalized or are inconsistent", () => {
    const bad: Partial<VendorInput>[] = [
      { name: " Banquetes " },
      { name: "" },
      { email: "Luis@RIOS.cr" },
      { instagramHandle: "@rios" },
      { category: "photography" }, // keeps "Seguridad": custom category outside Otro
      { customCategory: null }, // Otro without a type
      { currency: null }, // amount without currency
      { currency: "CRC", quotedAmountMinor: null }, // currency without amount
      { quotedAmountMinor: -1 },
      { quotedAmountMinor: 1.5 },
      { quotedAmountMinor: 100_000_000_000_000 },
      { status: "paid" as VendorInput["status"] },
      { currency: "EUR" as VendorInput["currency"] },
      { notes: "Hola\u0000" },
      { notes: "" },
    ];
    for (const change of bad) {
      expect(isValidVendorInput({ ...complete, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});
