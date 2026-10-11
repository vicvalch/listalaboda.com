import { describe, expect, it } from "vitest";

import { matchesWeddingSearch, searchForm, switchWeddingPath } from "@/lib/weddings/navigation";

// LB-24C wedding switching (ADR-017): known sections only, settings by the
// TARGET role, never a query string or hash across weddings.

const FROM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const owner = { id: TO, role: "owner" as const };
const collaborator = { id: TO, role: "collaborator" as const };
const home = `/app/weddings/${TO}`;
const from = (rest = "") => `/app/weddings/${FROM}${rest}`;

describe("switchWeddingPath", () => {
  it("home → home", () => {
    expect(switchWeddingPath(from(), owner)).toBe(home);
    expect(switchWeddingPath(from("/"), collaborator)).toBe(home);
  });

  it.each(["guests", "seating", "budget", "timeline", "site", "activity"])(
    "%s is kept for owners and collaborators",
    (section) => {
      expect(switchWeddingPath(from(`/${section}`), owner)).toBe(`${home}/${section}`);
      expect(switchWeddingPath(from(`/${section}`), collaborator)).toBe(`${home}/${section}`);
    },
  );

  it("vendors and a vendor's detail → the target's vendor list", () => {
    expect(switchWeddingPath(from("/vendors"), collaborator)).toBe(`${home}/vendors`);
    expect(switchWeddingPath(from("/vendors/cccccccc-cccc-4ccc-8ccc-cccccccccccc"), owner)).toBe(`${home}/vendors`);
  });

  it("settings: kept only when the TARGET role is owner", () => {
    expect(switchWeddingPath(from("/settings"), owner)).toBe(`${home}/settings`);
    expect(switchWeddingPath(from("/settings"), collaborator)).toBe(home);
  });

  it("unknown or deeper subroutes → home", () => {
    for (const rest of ["/unknown", "/guests/extra", "/budget/x", "/settings/x", "/admin", "/new"]) {
      expect(switchWeddingPath(from(rest), owner)).toBe(home);
    }
  });

  it("malformed or foreign paths → home", () => {
    for (const pathname of ["", "/", "/app", "/app/weddings", "/app/weddings/", "/boda/x", "//evil.example/guests", "guests"]) {
      expect(switchWeddingPath(pathname, owner)).toBe(home);
    }
  });

  it("query strings and hashes are always dropped", () => {
    expect(switchWeddingPath(from("?view=plan&saved=settings"), owner)).toBe(home);
    expect(switchWeddingPath(from("/seating?view=plan"), owner)).toBe(`${home}/seating`);
    expect(switchWeddingPath(from("/guests#party-123"), owner)).toBe(`${home}/guests`);
    expect(switchWeddingPath(from("/vendors?category=music&status=booked"), owner)).toBe(`${home}/vendors`);
    expect(switchWeddingPath(from("#item-1"), owner)).toBe(home);
  });

  it("the target id is the only id in the result", () => {
    expect(switchWeddingPath(from("/budget"), owner)).not.toContain(FROM);
  });
});

describe("matchesWeddingSearch", () => {
  const sofi = { name: "Boda de Sofía y Víctor", city: "San José" };
  const noCity = { name: "Boda Ñandú", city: null };

  it("empty or blank query matches everything", () => {
    expect(matchesWeddingSearch(sofi, "")).toBe(true);
    expect(matchesWeddingSearch(noCity, "   ")).toBe(true);
  });

  it("case-insensitive", () => {
    expect(matchesWeddingSearch(sofi, "BODA DE")).toBe(true);
  });

  it("accent-insensitive both ways", () => {
    expect(matchesWeddingSearch(sofi, "sofia")).toBe(true);
    expect(matchesWeddingSearch(sofi, "VICTOR")).toBe(true);
    expect(matchesWeddingSearch(sofi, "jose")).toBe(true);
    expect(matchesWeddingSearch({ name: "Boda de Jose", city: null }, "José")).toBe(true);
    expect(matchesWeddingSearch(noCity, "nandu")).toBe(true);
  });

  it("by name and by city; no match otherwise", () => {
    expect(matchesWeddingSearch(sofi, "víctor")).toBe(true);
    expect(matchesWeddingSearch(sofi, "san jo")).toBe(true);
    expect(matchesWeddingSearch(sofi, "Cartago")).toBe(false);
    expect(matchesWeddingSearch(noCity, "San José")).toBe(false);
  });

  it("comparison form", () => {
    expect(searchForm("ÁÉÍÓÚ Ñ ü")).toBe("aeiou n u");
  });
});
