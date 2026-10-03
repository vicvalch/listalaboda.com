import { describe, expect, it } from "vitest";

import {
  parseGuestName,
  parseGuestNames,
  parseNewParty,
  parsePartyLabel,
} from "@/lib/guests/validation";
import { es } from "@/lib/i18n/messages/es";
import { DIETARY_NOTE_MAX_LENGTH, parseDietaryNote, parseRsvpForm } from "@/lib/rsvp/validation";

const v = es.guests.validation;
const rv = es.rsvp.validation;

const ANA = "11111111-1111-4111-8111-111111111111";
const CARLOS = "22222222-2222-4222-8222-222222222222";

describe("party label and guest names", () => {
  it("trims and keeps Unicode and case as typed", () => {
    expect(parsePartyLabel("  Familia Pérez  ")).toEqual({ ok: true, value: "Familia Pérez" });
    expect(parseGuestName(" josé ÑANDÚ 💍 ")).toEqual({ ok: true, value: "josé ÑANDÚ 💍" });
  });

  it("requires a nonblank value of at most 120 characters, without control characters", () => {
    expect(parsePartyLabel("   ")).toEqual({ ok: false, error: v.labelRequired });
    expect(parsePartyLabel("a".repeat(121))).toEqual({ ok: false, error: v.labelTooLong });
    expect(parsePartyLabel("é".repeat(120)).ok).toBe(true);
    expect(parsePartyLabel("Familia\u0007")).toEqual({ ok: false, error: v.labelInvalid });
    expect(parseGuestName("")).toEqual({ ok: false, error: v.nameRequired });
    expect(parseGuestName("x".repeat(121))).toEqual({ ok: false, error: v.nameTooLong });
    expect(parseGuestName("Ana\u0000")).toEqual({ ok: false, error: v.nameInvalid });
  });

  it("reads one guest per line, skipping blank lines", () => {
    expect(parseGuestNames("Ana Pérez\r\n\n  Carlos Pérez  \n")).toEqual({
      ok: true,
      names: ["Ana Pérez", "Carlos Pérez"],
    });
    expect(parseGuestNames(" \n ")).toEqual({ ok: false, error: v.namesRequired });
  });

  it("has no fixed maximum party size", () => {
    const names = Array.from({ length: 45 }, (_, i) => `Persona ${i + 1}`);
    expect(parseGuestNames(names.join("\n"))).toEqual({ ok: true, names });
  });

  it("reports both new-party fields at once", () => {
    expect(parseNewParty({ label: "", guestNames: "" })).toEqual({
      ok: false,
      fieldErrors: { label: v.labelRequired, guestNames: v.namesRequired },
    });
    expect(parseNewParty({ label: "Ana y Carlos", guestNames: "Ana\nCarlos" })).toEqual({
      ok: true,
      input: { label: "Ana y Carlos", guestNames: ["Ana", "Carlos"] },
    });
  });
});

describe("dietary note", () => {
  it("is optional: trimmed, blank becomes null", () => {
    expect(parseDietaryNote("  sin gluten ")).toEqual({ ok: true, dietaryNote: "sin gluten" });
    expect(parseDietaryNote("   ")).toEqual({ ok: true, dietaryNote: null });
  });

  it("is plain text of at most 500 characters", () => {
    expect(parseDietaryNote("a".repeat(DIETARY_NOTE_MAX_LENGTH)).ok).toBe(true);
    expect(parseDietaryNote("a".repeat(DIETARY_NOTE_MAX_LENGTH + 1))).toEqual({ ok: false, error: rv.noteTooLong });
    expect(parseDietaryNote("uno\ndos")).toEqual({ ok: false, error: rv.noteInvalid });
  });
});

function rsvpForm(entries: [string, string][]): FormData {
  const formData = new FormData();
  for (const [key, value] of entries) formData.append(key, value);
  return formData;
}

describe("RSVP form", () => {
  it("parses a mixed party answer in party order", () => {
    const result = parseRsvpForm(
      rsvpForm([
        ["guestId", ANA],
        ["guestId", CARLOS],
        [`attending-${ANA}`, "yes"],
        [`dietaryNote-${ANA}`, " vegetariana "],
        [`attending-${CARLOS}`, "no"],
        [`dietaryNote-${CARLOS}`, ""],
      ]),
    );
    expect(result).toEqual({
      ok: true,
      responses: [
        { guestId: ANA, attending: true, dietaryNote: "vegetariana" },
        { guestId: CARLOS, attending: false, dietaryNote: null },
      ],
    });
  });

  it("never treats a missing choice as No: every guest must be answered", () => {
    const result = parseRsvpForm(
      rsvpForm([
        ["guestId", ANA],
        ["guestId", CARLOS],
        [`attending-${ANA}`, "yes"],
      ]),
    );
    expect(result).toEqual({
      ok: false,
      fieldErrors: { [CARLOS]: rv.choiceRequired },
      formError: rv.fixErrors,
      values: {
        [ANA]: { attending: "yes", dietaryNote: "" },
        [CARLOS]: { attending: "", dietaryNote: "" },
      },
    });
  });

  it("rejects values other than yes/no", () => {
    const result = parseRsvpForm(rsvpForm([["guestId", ANA], [`attending-${ANA}`, "true"]]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fieldErrors[ANA]).toBe(rv.choiceRequired);
  });

  it("flags a bad note inside that guest's group", () => {
    const result = parseRsvpForm(
      rsvpForm([
        ["guestId", ANA],
        [`attending-${ANA}`, "yes"],
        [`dietaryNote-${ANA}`, "x".repeat(501)],
      ]),
    );
    expect(!result.ok && result.fieldErrors[ANA]).toBe(rv.noteTooLong);
  });

  it("accepts a large party answered in full (no fixed maximum)", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const result = parseRsvpForm(
      rsvpForm(ids.flatMap((id): [string, string][] => [["guestId", id], [`attending-${id}`, "yes"]])),
    );
    expect(result.ok && result.responses).toHaveLength(25);
  });

  it("treats a tampered guest list as stale (no guests, duplicates, bad ids)", () => {
    const tampered = [
      rsvpForm([]),
      rsvpForm([["guestId", ANA], ["guestId", ANA], [`attending-${ANA}`, "yes"]]),
      rsvpForm([["guestId", "not-a-uuid"], ["attending-not-a-uuid", "yes"]]),
    ];
    for (const formData of tampered) {
      const result = parseRsvpForm(formData);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.formError).toBe(rv.stale);
    }
  });
});
