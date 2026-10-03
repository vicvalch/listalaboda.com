import { describe, expect, it } from "vitest";

import { getMessages } from "@/lib/i18n";
import {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  isValidSlug,
  parseSlug,
  publicSitePath,
  suggestSlug,
} from "@/lib/wedding-site/slug";

const v = getMessages().site.slug.validation;

describe("parseSlug", () => {
  it.each(["ana-y-luis", "abc", "boda-2090", "2090", "a1-b2-c3", "x".repeat(SLUG_MAX_LENGTH)])(
    "accepts the canonical %s",
    (slug) => {
      expect(parseSlug(slug)).toEqual({ ok: true, slug });
      expect(isValidSlug(slug)).toBe(true);
    },
  );

  it("trims surrounding whitespace only", () => {
    expect(parseSlug("  ana-y-luis \n")).toEqual({ ok: true, slug: "ana-y-luis" });
  });

  it.each([
    ["", v.required],
    ["   ", v.required],
    ["ab", v.tooShort],
    ["x".repeat(SLUG_MAX_LENGTH + 1), v.tooLong],
    ["Ana-y-Luis", v.invalid],
    ["ana y luis", v.invalid],
    ["-ana", v.invalid],
    ["ana-", v.invalid],
    ["ana--luis", v.invalid],
    ["ana_luis", v.invalid],
    ["ana.luis", v.invalid],
    ["ana/luis", v.invalid],
    ["boda-ñandú", v.invalid],
    ["<script>", v.invalid],
  ])("refuses %j without transforming it", (raw, error) => {
    expect(parseSlug(raw)).toEqual({ ok: false, error });
  });

  it("refuses the app's reserved words", () => {
    expect(RESERVED_SLUGS).toEqual(["admin", "api", "app", "auth", "boda", "invite", "login", "rsvp", "signup"]);
    for (const slug of RESERVED_SLUGS) {
      expect(parseSlug(slug)).toEqual({ ok: false, error: v.reserved });
      expect(isValidSlug(slug)).toBe(false);
    }
  });
});

describe("suggestSlug", () => {
  it.each([
    ["Boda de Ana y Luis", "boda-de-ana-y-luis"],
    ["  María José & Íñigo  ", "maria-jose-inigo"],
    ["Ana + Luis 2090!!", "ana-luis-2090"],
    // Reserved and too-short results are not suggested.
    ["BODA", ""],
    ["ab", ""],
    ["💍💍💍", ""],
    ["Rsvp", ""],
  ])("%j → %j", (name, expected) => {
    expect(suggestSlug(name)).toBe(expected);
  });

  it("is deterministic and always valid or empty", () => {
    const names = ["Boda de Sofía y Mateo", "Ñandú", "a".repeat(300), "x -- y", "Çà et là"];
    for (const name of names) {
      const suggestion = suggestSlug(name);
      expect(suggestSlug(name)).toBe(suggestion);
      expect(suggestion === "" || isValidSlug(suggestion)).toBe(true);
    }
  });

  it("cuts long names to the limit without a trailing hyphen", () => {
    const suggestion = suggestSlug(`${"palabra ".repeat(20)}final`);
    expect(suggestion.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(suggestion.endsWith("-")).toBe(false);
    expect(isValidSlug(suggestion)).toBe(true);
  });
});

describe("publicSitePath", () => {
  it("is /boda/<slug>, never a wedding id", () => {
    expect(publicSitePath("ana-y-luis")).toBe("/boda/ana-y-luis");
  });
});
