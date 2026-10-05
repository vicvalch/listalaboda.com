import { describe, expect, it } from "vitest";

import {
  checklistItemAnchor,
  checklistItemHref,
  guestPartyAnchor,
  guestPartyHref,
  linkedParty,
} from "@/lib/checklist/guest-work";

// LB-16 (ADR-009): routes between a checklist item and its guest party are
// derived from ids only, and a missing party reads as unlinked.

const WEDDING = "22222222-2222-4222-8222-222222222222";
const ITEM = "55555555-5555-4555-8555-555555555555";
const PARTY = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";

describe("checklist ↔ guest work navigation", () => {
  it("anchors match the DOM ids the pages render", () => {
    expect(checklistItemAnchor(ITEM)).toBe(`item-${ITEM}`);
    expect(guestPartyAnchor(PARTY)).toBe(`party-${PARTY}`);
  });

  it("routes are the app's own paths plus an anchor: no query string, no RSVP link", () => {
    expect(checklistItemHref(WEDDING, ITEM)).toBe(`/app/weddings/${WEDDING}#item-${ITEM}`);
    expect(guestPartyHref(WEDDING, PARTY)).toBe(`/app/weddings/${WEDDING}/guests#party-${PARTY}`);
    for (const href of [checklistItemHref(WEDDING, ITEM), guestPartyHref(WEDDING, PARTY)]) {
      expect(href.startsWith("/app/weddings/")).toBe(true);
      expect(href).not.toContain("?");
      expect(href).not.toContain("/rsvp/");
    }
  });

  it("ids are encoded, so a hostile value can't change the route", () => {
    expect(guestPartyHref("../x?y", "a#b")).toBe("/app/weddings/..%2Fx%3Fy/guests#party-a%23b");
    expect(checklistItemHref("w/1", "i?2")).toBe("/app/weddings/w%2F1#item-i%3F2");
  });
});

describe("linkedParty", () => {
  const parties = [
    { id: PARTY, label: "Familia Pérez" },
    { id: OTHER, label: "Familia Gómez" },
  ];

  it("unlinked items have no party", () => {
    expect(linkedParty(parties, null)).toBeNull();
  });

  it("a linked item shows the party's CURRENT label", () => {
    expect(linkedParty(parties, OTHER)).toEqual({ id: OTHER, label: "Familia Gómez" });
    const renamed = [{ id: OTHER, label: "Los Gómez" }];
    expect(linkedParty(renamed, OTHER)?.label).toBe("Los Gómez");
  });

  it("a party that's gone reads as unlinked, never as a broken link", () => {
    expect(linkedParty(parties, "77777777-7777-4777-8777-777777777777")).toBeNull();
    expect(linkedParty([], PARTY)).toBeNull();
  });
});
