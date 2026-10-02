import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import { parseInviteInput } from "@/lib/membership-invites/validation";
import {
  isIsoCalendarDate,
  parseCity,
  parseWeddingInput,
  weddingFieldErrorMessage,
} from "@/lib/weddings/validation";

const blank = { city: "", timeZone: "" };

describe("parseWeddingInput", () => {
  it("trims the name and accepts an optional date", () => {
    expect(parseWeddingInput({ name: "  Boda de Ana y Luis ", weddingDate: "2027-06-12", ...blank }),
    ).toEqual({
      ok: true,
      input: { name: "Boda de Ana y Luis", weddingDate: "2027-06-12", city: null, timeZone: null },
    });
    expect(parseWeddingInput({ name: "Boda", weddingDate: "", ...blank })).toEqual({
      ok: true,
      input: { name: "Boda", weddingDate: null, city: null, timeZone: null },
    });
  });

  it.each(["", "   ", "\t\n"])("rejects a blank name %j", (name) => {
    expect(parseWeddingInput({ name, weddingDate: "", ...blank })).toEqual({
      ok: false,
      fieldErrors: { name: es.weddingNew.validation.nameRequired },
    });
  });

  it("rejects names over 200 characters", () => {
    expect(parseWeddingInput({ name: "a".repeat(201), weddingDate: "", ...blank })).toMatchObject({
      ok: false,
      fieldErrors: { name: es.weddingNew.validation.nameTooLong },
    });
  });

  it.each(["2027-02-30", "2027-13-01", "12/06/2027", "2027-6-1", "tomorrow", "0001-01-01"])(
    "rejects invalid date %j",
    (weddingDate) => {
      expect(parseWeddingInput({ name: "Boda", weddingDate, ...blank })).toMatchObject({
        ok: false,
        fieldErrors: { weddingDate: es.weddingNew.validation.dateInvalid },
      });
    },
  );

  it("accepts leap days only in leap years", () => {
    expect(isIsoCalendarDate("2028-02-29")).toBe(true);
    expect(isIsoCalendarDate("2027-02-29")).toBe(false);
  });
});

describe("wedding city", () => {
  const v = es.weddingNew.validation;

  it("is optional: blank or whitespace is null", () => {
    for (const raw of ["", "   ", "\t\n"]) expect(parseCity(raw)).toEqual({ ok: true, city: null });
  });

  it("is trimmed but otherwise kept as typed (case, accents)", () => {
    expect(parseCity("  San José ")).toEqual({ ok: true, city: "San José" });
    expect(parseCity("SÃO PAULO")).toEqual({ ok: true, city: "SÃO PAULO" });
    expect(parseCity("Ñuñoa")).toEqual({ ok: true, city: "Ñuñoa" });
  });

  it("allows 120 characters (code points), not 121", () => {
    expect(parseCity("é".repeat(120))).toEqual({ ok: true, city: "é".repeat(120) });
    expect(parseCity("é".repeat(121))).toEqual({ ok: false, error: v.cityTooLong });
    // Astral characters count once, like Postgres char_length.
    expect(parseCity("💍".repeat(120)).ok).toBe(true);
  });

  it.each(["San\u0000José", "Lima\u0007x", "Ma\ndrid", "Ma\u0085drid"])(
    "rejects control characters in %j",
    (raw) => {
      expect(parseCity(raw)).toEqual({ ok: false, error: v.cityInvalid });
    },
  );
});

describe("wedding form: city and time zone", () => {
  const v = es.weddingNew.validation;
  const base = { name: "Boda", weddingDate: "" };

  it("accepts a city and an IANA zone", () => {
    expect(parseWeddingInput({ ...base, city: " Lima ", timeZone: "America/Lima" })).toEqual({
      ok: true,
      input: { name: "Boda", weddingDate: null, city: "Lima", timeZone: "America/Lima" },
    });
  });

  it("a blank zone is null (optional); never guessed", () => {
    const parsed = parseWeddingInput({ ...base, city: "", timeZone: "  " });
    expect(parsed).toMatchObject({ ok: true, input: { timeZone: null } });
  });

  it.each(["Mars/Olympus", "America/Not_A_Real_Place", "GMT-Definitely-Fake", "random text", "-06:00"])(
    "rejects zone %j with a Spanish field error",
    (timeZone) => {
      expect(parseWeddingInput({ ...base, city: "", timeZone })).toEqual({
        ok: false,
        fieldErrors: { timeZone: v.timeZoneInvalid },
      });
    },
  );

  it("reports every invalid field at once", () => {
    expect(
      parseWeddingInput({ name: "", weddingDate: "x", city: "a\u0007", timeZone: "Mars/Olympus" }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        name: v.nameRequired,
        weddingDate: v.dateInvalid,
        city: v.cityInvalid,
        timeZone: v.timeZoneInvalid,
      },
    });
  });

  it("maps database rejections to field messages, and nothing else", () => {
    expect(weddingFieldErrorMessage("invalid_city")).toEqual({ city: v.cityInvalid });
    expect(weddingFieldErrorMessage("invalid_time_zone")).toEqual({ timeZone: v.timeZoneInvalid });
    expect(weddingFieldErrorMessage("forbidden")).toBeNull();
    expect(weddingFieldErrorMessage("error")).toBeNull();
  });
});

describe("parseInviteInput", () => {
  it("defaults to collaborator with no email (a copyable link)", () => {
    expect(parseInviteInput({ email: "", role: "" })).toEqual({
      ok: true,
      input: { email: null, role: "collaborator" },
    });
  });

  it("accepts an owner invite for a partner", () => {
    expect(parseInviteInput({ email: "", role: "owner" })).toEqual({
      ok: true,
      input: { email: null, role: "owner" },
    });
  });

  it("normalizes the email exactly as the database requires", () => {
    expect(parseInviteInput({ email: "  Pareja@Example.TEST ", role: "collaborator" })).toEqual({
      ok: true,
      input: { email: "pareja@example.test", role: "collaborator" },
    });
  });

  it.each(["admin", "planner", "viewer", "OWNER"])("rejects unknown role %j", (role) => {
    expect(parseInviteInput({ email: "", role })).toEqual({
      ok: false,
      fieldErrors: { role: es.invites.validation.roleInvalid },
    });
  });

  it("rejects an implausible email", () => {
    expect(parseInviteInput({ email: "not-an-email", role: "owner" })).toMatchObject({
      ok: false,
      fieldErrors: { email: es.invites.validation.emailInvalid },
    });
  });
});
