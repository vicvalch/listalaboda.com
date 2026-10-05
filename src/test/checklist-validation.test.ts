import { describe, expect, it } from "vitest";

import type { ChecklistItem } from "@/lib/checklist/types";
import {
  EMPTY_ITEM_FORM_VALUES,
  itemFormValues,
  parseChecklistItemInput,
  parseStatusInput,
  type ChecklistItemRawInput,
} from "@/lib/checklist/validation";
import { es } from "@/lib/i18n/messages/es";

const messages = es.checklist.validation;

function parse(overrides: Partial<ChecklistItemRawInput>) {
  return parseChecklistItemInput({ ...EMPTY_ITEM_FORM_VALUES, ...overrides });
}

describe("parseChecklistItemInput", () => {
  it("accepts a title alone: no category, no date", () => {
    expect(parse({ title: "  Probar el menú  " })).toEqual({
      ok: true,
      input: { title: "Probar el menú", description: null, category: null, timing: { mode: "none" } },
    });
  });

  it("requires a non-blank title within the length cap", () => {
    expect(parse({ title: "   " })).toEqual({ ok: false, fieldErrors: { title: messages.titleRequired } });
    expect(parse({ title: "a".repeat(201) })).toEqual({
      ok: false,
      fieldErrors: { title: messages.titleTooLong },
    });
    expect(parse({ title: "a".repeat(200) }).ok).toBe(true);
  });

  it("accepts known categories only", () => {
    const ok = parse({ title: "X", category: "reception" });
    expect(ok.ok && ok.input.category).toBe("reception");
    expect(parse({ title: "X", category: "budget" })).toEqual({
      ok: false,
      fieldErrors: { category: messages.categoryInvalid },
    });
  });

  it("trims description and caps its length", () => {
    const ok = parse({ title: "X", description: "  Llevar zapatos  " });
    expect(ok.ok && ok.input.description).toBe("Llevar zapatos");
    expect(parse({ title: "X", description: "a".repeat(2001) })).toEqual({
      ok: false,
      fieldErrors: { description: messages.descriptionTooLong },
    });
  });

  it("maps 'N días antes' to a negative offset", () => {
    const result = parse({
      title: "X",
      timingMode: "relative_to_wedding",
      relativeAmount: "30",
      relativeDirection: "before",
    });
    expect(result.ok && result.input.timing).toEqual({ mode: "relative_to_wedding", relativeDays: -30 });
  });

  it("maps 'N días después' to a positive offset and the wedding day to 0", () => {
    const after = parse({
      title: "X",
      timingMode: "relative_to_wedding",
      relativeAmount: "7",
      relativeDirection: "after",
    });
    expect(after.ok && after.input.timing).toEqual({ mode: "relative_to_wedding", relativeDays: 7 });
    const on = parse({
      title: "X",
      timingMode: "relative_to_wedding",
      relativeAmount: "",
      relativeDirection: "on",
    });
    expect(on.ok && on.input.timing).toEqual({ mode: "relative_to_wedding", relativeDays: 0 });
  });

  it.each(["", "0", "-30", "1001", "2.5", "30 días", "1e2"])(
    "rejects %o as a number of days",
    (relativeAmount) => {
      expect(
        parse({ title: "X", timingMode: "relative_to_wedding", relativeAmount, relativeDirection: "before" }),
      ).toEqual({ ok: false, fieldErrors: { relativeAmount: messages.daysInvalid } });
    },
  );

  it("rejects an unknown direction", () => {
    expect(
      parse({ title: "X", timingMode: "relative_to_wedding", relativeAmount: "3", relativeDirection: "sideways" }),
    ).toEqual({ ok: false, fieldErrors: { relativeDirection: messages.directionInvalid } });
  });

  it("requires a real date for a specific date", () => {
    const ok = parse({ title: "X", timingMode: "absolute", dueDate: "2027-03-15" });
    expect(ok.ok && ok.input.timing).toEqual({ mode: "absolute", dueDate: "2027-03-15" });
    for (const dueDate of ["", "2027-02-30", "15/03/2027"]) {
      expect(parse({ title: "X", timingMode: "absolute", dueDate })).toEqual({
        ok: false,
        fieldErrors: { dueDate: messages.dateInvalid },
      });
    }
  });

  it("ignores fields that don't belong to the chosen timing", () => {
    const result = parse({ title: "X", timingMode: "none", dueDate: "nonsense", relativeAmount: "-5" });
    expect(result.ok && result.input.timing).toEqual({ mode: "none" });
  });

  it("rejects an unknown timing mode", () => {
    expect(parse({ title: "X", timingMode: "weekly" })).toEqual({
      ok: false,
      fieldErrors: { timingMode: messages.timingInvalid },
    });
  });

  it("reports several field errors at once", () => {
    const result = parse({ title: "", category: "nope", timingMode: "absolute", dueDate: "" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        title: messages.titleRequired,
        category: messages.categoryInvalid,
        dueDate: messages.dateInvalid,
      },
    });
  });
});

describe("parseStatusInput", () => {
  it("accepts only the closed status set", () => {
    expect(parseStatusInput("done")).toBe("done");
    expect(parseStatusInput("not_applicable")).toBe("not_applicable");
    expect(parseStatusInput("in_progress")).toBeNull();
    expect(parseStatusInput("")).toBeNull();
  });
});

describe("itemFormValues", () => {
  const base: ChecklistItem = {
    id: "i",
    title: "Reservar el lugar",
    description: null,
    category: "venue_and_date",
    status: "pending",
    timing: { mode: "relative_to_wedding", relativeDays: -270 },
    sortOrder: 10,
    assigneeMembershipId: null,
    guestInvitationId: null,
  };

  it("turns a stored offset back into friendly fields", () => {
    expect(itemFormValues(base)).toMatchObject({
      title: "Reservar el lugar",
      category: "venue_and_date",
      timingMode: "relative_to_wedding",
      relativeAmount: "270",
      relativeDirection: "before",
    });
  });

  it("round-trips through the parser for every timing", () => {
    for (const timing of [
      { mode: "none" },
      { mode: "absolute", dueDate: "2027-03-15" },
      { mode: "relative_to_wedding", relativeDays: -270 },
      { mode: "relative_to_wedding", relativeDays: 0 },
      { mode: "relative_to_wedding", relativeDays: 5 },
    ] as const) {
      const item = { ...base, timing, description: "Notas" };
      expect(parseChecklistItemInput(itemFormValues(item))).toEqual({
        ok: true,
        input: { title: item.title, description: "Notas", category: item.category, timing },
      });
    }
  });
});
