import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import { parseInviteInput } from "@/lib/membership-invites/validation";
import { isIsoCalendarDate, parseWeddingInput } from "@/lib/weddings/validation";

describe("parseWeddingInput", () => {
  it("trims the name and accepts an optional date", () => {
    expect(parseWeddingInput({ name: "  Boda de Ana y Luis ", weddingDate: "2027-06-12" })).toEqual(
      { ok: true, input: { name: "Boda de Ana y Luis", weddingDate: "2027-06-12" } },
    );
    expect(parseWeddingInput({ name: "Boda", weddingDate: "" })).toEqual({
      ok: true,
      input: { name: "Boda", weddingDate: null },
    });
  });

  it.each(["", "   ", "\t\n"])("rejects a blank name %j", (name) => {
    expect(parseWeddingInput({ name, weddingDate: "" })).toEqual({
      ok: false,
      fieldErrors: { name: es.weddingNew.validation.nameRequired },
    });
  });

  it("rejects names over 200 characters", () => {
    expect(parseWeddingInput({ name: "a".repeat(201), weddingDate: "" })).toMatchObject({
      ok: false,
      fieldErrors: { name: es.weddingNew.validation.nameTooLong },
    });
  });

  it.each(["2027-02-30", "2027-13-01", "12/06/2027", "2027-6-1", "tomorrow", "0001-01-01"])(
    "rejects invalid date %j",
    (weddingDate) => {
      expect(parseWeddingInput({ name: "Boda", weddingDate })).toMatchObject({
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
