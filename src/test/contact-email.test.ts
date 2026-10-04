import { describe, expect, it } from "vitest";

import {
  CONTACT_EMAIL_MAX_LENGTH,
  isStoredContactEmail,
  normalizeContactEmail,
  parseContactEmail,
} from "@/lib/guests/contact-email";
import { parseNewParty } from "@/lib/guests/validation";
import { es } from "@/lib/i18n/messages/es";

const v = es.guests.contactEmail.validation;

describe("party contact email", () => {
  it("trims and lowercases only the domain; the local part is kept as typed", () => {
    expect(parseContactEmail("  Ana.Perez+Boda@Example.COM ")).toEqual({
      ok: true,
      value: "Ana.Perez+Boda@example.com",
    });
    expect(parseContactEmail("familia@correo.example.org")).toEqual({
      ok: true,
      value: "familia@correo.example.org",
    });
  });

  it("blank means no email (null), never an error", () => {
    expect(parseContactEmail("")).toEqual({ ok: true, value: null });
    expect(parseContactEmail("   ")).toEqual({ ok: true, value: null });
  });

  it.each([
    "familia",
    "familia@",
    "@example.com",
    "familia@example",
    "familia@@example.com",
    "a@b@example.com",
    "fam ilia@example.com",
    "familia@exa mple.com",
    "familia@-example.com",
    "familia@example.c",
    "familia@example.123",
    ".familia@example.com",
    "fami..lia@example.com",
    "familia.@example.com",
    "familia@pérez.com",
    "pérez@example.com",
    '"quoted"@example.com',
    "familia@[127.0.0.1]",
    "familia@example.com\r\nBcc: otra@example.com",
    "familia@example.com\nX",
    "fami\u0000lia@example.com",
    "fami\u0007lia@example.com",
    "fami\u0085lia@example.com",
  ])("refuses %j with a clear, non-technical message", (raw) => {
    expect(parseContactEmail(raw)).toEqual({ ok: false, error: v.invalid });
  });

  it("bounds the length: 254 overall, 64 for the local part", () => {
    const local64 = "a".repeat(64);
    expect(parseContactEmail(`${local64}@example.com`).ok).toBe(true);
    expect(parseContactEmail(`${local64}a@example.com`)).toEqual({ ok: false, error: v.invalid });

    const domain = `${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`;
    const exact = `${"a".repeat(CONTACT_EMAIL_MAX_LENGTH - domain.length - 1)}@${domain}`;
    expect(exact.length).toBeLessThanOrEqual(CONTACT_EMAIL_MAX_LENGTH);
    expect(parseContactEmail(`x${"a".repeat(CONTACT_EMAIL_MAX_LENGTH)}@example.com`)).toEqual({
      ok: false,
      error: v.tooLong,
    });
  });

  it("knows the stored form (what the database accepts)", () => {
    expect(isStoredContactEmail("Ana@example.com")).toBe(true);
    expect(isStoredContactEmail("ana@Example.com")).toBe(false);
    expect(isStoredContactEmail(" ana@example.com")).toBe(false);
    expect(normalizeContactEmail("ana@EXAMPLE.com")).toBe("ana@example.com");
  });

  it("is an optional field of a new party", () => {
    expect(parseNewParty({ label: "Familia", guestNames: "Ana", contactEmail: " ana@Example.com " })).toEqual({
      ok: true,
      input: { label: "Familia", guestNames: ["Ana"], contactEmail: "ana@example.com" },
    });
    expect(parseNewParty({ label: "Familia", guestNames: "Ana", contactEmail: "no válido" })).toEqual({
      ok: false,
      fieldErrors: { contactEmail: v.invalid },
    });
  });
});
