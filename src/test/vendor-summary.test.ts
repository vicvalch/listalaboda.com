import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import {
  VENDOR_CATEGORIES,
  VENDOR_STATUSES,
  VENDOR_STATUS_RANK,
  instagramProfileUrl,
  mailtoHref,
  phoneHref,
  vendorCategoryDisplay,
  vendorCategoryLabel,
  vendorStatusLabel,
} from "@/lib/vendors/presentation";
import {
  compareVendors,
  filterVendors,
  groupVendorsByCategory,
  matchesVendorSearch,
  normalizeSearchText,
  parseVendorCategoryParam,
  parseVendorStatusParam,
  suggestedCurrency,
  summarizeVendors,
  vendorFilterQuery,
  vendorMainAmount,
  type VendorListItem,
} from "@/lib/vendors/summary";

// LB-21 (ADR-014): the list's derived views, all pure and in memory.

let counter = 0;
function vendor(overrides: Partial<VendorListItem>): VendorListItem {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name: `Proveedor ${counter}`,
    category: "photography",
    customCategory: null,
    status: "considering",
    contactName: null,
    email: null,
    phone: null,
    instagramHandle: null,
    currency: null,
    quotedAmountMinor: null,
    contractedAmountMinor: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

// --------------------------------------------------------------- catalog

describe("presentation", () => {
  it("labels every category and status in Spanish, exactly", () => {
    expect(Object.fromEntries(VENDOR_CATEGORIES.map((c) => [c, vendorCategoryLabel(c)]))).toEqual({
      venue: "Lugar",
      catering: "Comida y bebida",
      photography: "Fotografía",
      video: "Video",
      music: "Música",
      flowers_decor: "Flores y decoración",
      cake_desserts: "Pastel y postres",
      beauty: "Peinado y maquillaje",
      attire: "Vestuario",
      officiant: "Oficiante",
      stationery: "Invitaciones y papelería",
      transport: "Transporte",
      lodging: "Hospedaje",
      rentals: "Alquileres",
      planning: "Coordinación",
      other: "Otro",
    });
    expect(Object.fromEntries(VENDOR_STATUSES.map((s) => [s, vendorStatusLabel(s)]))).toEqual({
      considering: "En evaluación",
      quoted: "Cotizado",
      selected: "Elegido",
      booked: "Contratado",
      discarded: "Descartado",
    });
  });

  it("uses no payment vocabulary for statuses", () => {
    const labels = Object.values(es.vendors.statuses).join(" ").toLowerCase();
    for (const word of ["pagado", "pago", "abono", "depósito", "factura"]) expect(labels).not.toContain(word);
  });

  it("shows the custom type for Otro", () => {
    expect(vendorCategoryDisplay({ category: "other", customCategory: "Seguridad" })).toBe("Seguridad");
    expect(vendorCategoryDisplay({ category: "music", customCategory: null })).toBe("Música");
  });

  it("builds an Instagram URL only from a validated handle", () => {
    expect(instagramProfileUrl("floreria.gardenias")).toBe("https://www.instagram.com/floreria.gardenias/");
    for (const handle of ["", "@x", "a/b", "javascript:alert(1)", "x y", "x".repeat(31), "evil.com/?q="]) {
      expect(instagramProfileUrl(handle), handle).toBeNull();
    }
  });

  it("builds tel: and mailto: links without arbitrary schemes", () => {
    expect(phoneHref("+506 8888-1234")).toBe("tel:+50688881234");
    expect(phoneHref("(506) 2222.3333")).toBe("tel:50622223333");
    expect(phoneHref("javascript:alert(1)")).toBeNull();
    expect(mailtoHref("Ventas@flores.cr")).toBe("mailto:Ventas@flores.cr");
    expect(mailtoHref("a?b#c@flores.cr")).toBe("mailto:a%3Fb%23c@flores.cr");
    expect(mailtoHref("no-at")).toBeNull();
  });
});

// --------------------------------------------------------------- summary

describe("summarizeVendors", () => {
  it("counts all vendors and each status", () => {
    const summary = summarizeVendors([
      vendor({ status: "considering" }),
      vendor({ status: "considering" }),
      vendor({ status: "quoted" }),
      vendor({ status: "booked" }),
      vendor({ status: "discarded" }),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual({ considering: 2, quoted: 1, selected: 0, booked: 1, discarded: 1 });
  });

  it("totals only booked vendors' contracted amounts, per currency, never mixed", () => {
    const summary = summarizeVendors([
      vendor({ status: "booked", currency: "CRC", contractedAmountMinor: 150_000_000 }),
      vendor({ status: "booked", currency: "CRC", contractedAmountMinor: 90_000_000, quotedAmountMinor: 99_000_000 }),
      vendor({ status: "booked", currency: "USD", contractedAmountMinor: 350_000 }),
      // Not booked yet: never counted, even with a contracted amount.
      vendor({ status: "selected", currency: "USD", contractedAmountMinor: 1_000_000 }),
      vendor({ status: "discarded", currency: "CRC", contractedAmountMinor: 7_000_000 }),
      // Quotes are never summed.
      vendor({ status: "quoted", currency: "CRC", quotedAmountMinor: 80_000_000 }),
      vendor({ status: "booked", currency: "USD", quotedAmountMinor: 900_000 }),
    ]);
    expect(summary.contractedTotals).toEqual([
      { currency: "CRC", totalMinor: BigInt(240_000_000) },
      { currency: "USD", totalMinor: BigInt(350_000) },
    ]);
  });

  it("lists only currencies that have a total, and none when nothing is booked", () => {
    expect(summarizeVendors([vendor({ status: "booked", currency: "USD", contractedAmountMinor: 0 })]).contractedTotals).toEqual([
      { currency: "USD", totalMinor: BigInt(0) },
    ]);
    expect(summarizeVendors([vendor({ status: "quoted", currency: "CRC", quotedAmountMinor: 5 })]).contractedTotals).toEqual([]);
    expect(summarizeVendors([])).toEqual({
      total: 0,
      byStatus: { considering: 0, quoted: 0, selected: 0, booked: 0, discarded: 0 },
      contractedTotals: [],
    });
  });

  it("sums exactly beyond the safe-integer range", () => {
    const max = 99_999_999_999_999;
    const many = Array.from({ length: 100 }, () => vendor({ status: "booked", currency: "CRC", contractedAmountMinor: max }));
    expect(summarizeVendors(many).contractedTotals).toEqual([{ currency: "CRC", totalMinor: BigInt(max) * BigInt(100) }]);
  });
});

describe("vendorMainAmount", () => {
  it("prefers the contracted amount, else the quote", () => {
    expect(vendorMainAmount(vendor({ currency: "CRC", quotedAmountMinor: 100, contractedAmountMinor: 90 }))).toEqual({
      kind: "contracted",
      minor: 90,
      currency: "CRC",
    });
    expect(vendorMainAmount(vendor({ currency: "USD", quotedAmountMinor: 100 }))).toEqual({
      kind: "quote",
      minor: 100,
      currency: "USD",
    });
    expect(vendorMainAmount(vendor({}))).toBeNull();
  });
});

describe("suggestedCurrency", () => {
  it("is the currency of the most recently updated vendor that has one", () => {
    expect(suggestedCurrency([])).toBeNull();
    expect(
      suggestedCurrency([
        vendor({ currency: "CRC", quotedAmountMinor: 1, updatedAt: "2026-10-01T10:00:00.000Z" }),
        vendor({ currency: "USD", quotedAmountMinor: 1, updatedAt: "2026-10-03T10:00:00.000Z" }),
        vendor({ currency: null, updatedAt: "2026-10-05T10:00:00.000Z" }),
      ]),
    ).toBe("USD");
  });
});

// -------------------------------------------------------------- ordering

describe("ordering and grouping", () => {
  it("ranks Contratado, Elegido, Cotizado, En evaluación, Descartado", () => {
    expect([...VENDOR_STATUSES].sort((a, b) => VENDOR_STATUS_RANK[a] - VENDOR_STATUS_RANK[b])).toEqual([
      "booked",
      "selected",
      "quoted",
      "considering",
      "discarded",
    ]);
  });

  it("sorts by status rank, then name in Spanish order", () => {
    const vendors = [
      vendor({ name: "Zeta", status: "discarded" }),
      vendor({ name: "Ñandú", status: "considering" }),
      vendor({ name: "nube", status: "considering" }),
      vendor({ name: "Álamo", status: "considering" }),
      vendor({ name: "Beta", status: "booked" }),
      vendor({ name: "Omega", status: "selected" }),
      vendor({ name: "Alfa", status: "quoted" }),
    ];
    expect([...vendors].sort(compareVendors).map((v) => v.name)).toEqual([
      "Beta",
      "Omega",
      "Alfa",
      "Álamo",
      "nube",
      "Ñandú",
      "Zeta",
    ]);
  });

  it("groups by category in display order, skipping empty categories, discarded last within each", () => {
    const groups = groupVendorsByCategory([
      vendor({ name: "Flores B", category: "flowers_decor", status: "discarded" }),
      vendor({ name: "Lugar", category: "venue" }),
      vendor({ name: "Flores A", category: "flowers_decor", status: "considering" }),
      vendor({ name: "Seguridad", category: "other", customCategory: "Seguridad" }),
    ]);
    expect(groups.map((g) => [g.category, g.vendors.map((v) => v.name)])).toEqual([
      ["venue", ["Lugar"]],
      ["flowers_decor", ["Flores A", "Flores B"]],
      ["other", ["Seguridad"]],
    ]);
  });
});

// ---------------------------------------------------------------- search

describe("search and filters", () => {
  const florist = vendor({
    name: "Floristería Las Gardenias",
    category: "flowers_decor",
    status: "quoted",
    contactName: "María José Núñez",
    email: "ventas@gardenias.cr",
    phone: "8888-1234",
  });
  const photographer = vendor({ name: "Estudio Luz", category: "photography", status: "booked", contactName: "Andrés" });
  const all = [florist, photographer];

  it("normalizes case and accents", () => {
    expect(normalizeSearchText("  FotografÍa Ñandú ")).toBe("fotografia nandu");
  });

  it("matches vendor and contact names, case- and accent-insensitively", () => {
    expect(matchesVendorSearch(florist, "floristeria")).toBe(true);
    expect(matchesVendorSearch(florist, "GARDENIAS")).toBe(true);
    expect(matchesVendorSearch(florist, "maria jose")).toBe(true);
    expect(matchesVendorSearch(florist, "nunez")).toBe(true);
    expect(matchesVendorSearch(photographer, "andres")).toBe(true);
    expect(matchesVendorSearch(photographer, "   ")).toBe(true);
  });

  it("does not search email, phone, notes or category labels", () => {
    expect(matchesVendorSearch(florist, "ventas@")).toBe(false);
    expect(matchesVendorSearch(florist, "8888")).toBe(false);
    expect(matchesVendorSearch(photographer, "fotografia")).toBe(false);
  });

  it("filters by category, status and text together", () => {
    expect(filterVendors(all, { query: "", category: null, status: null })).toEqual(all);
    expect(filterVendors(all, { query: "", category: "flowers_decor", status: null })).toEqual([florist]);
    expect(filterVendors(all, { query: "", category: null, status: "booked" })).toEqual([photographer]);
    expect(filterVendors(all, { query: "luz", category: "flowers_decor", status: null })).toEqual([]);
    expect(filterVendors(all, { query: "maria", category: null, status: null })).toEqual([florist]);
  });

  it("puts only category and status in the URL, never the search text", () => {
    expect(vendorFilterQuery({ category: null, status: null })).toBe("");
    expect(vendorFilterQuery({ category: "flowers_decor", status: "booked" })).toBe("?category=flowers_decor&status=booked");
    const withQuery = { category: "venue", status: null, query: "Floristería secreta" } as const;
    expect(vendorFilterQuery(withQuery)).toBe("?category=venue");
    expect(vendorFilterQuery(withQuery)).not.toContain("secreta");
  });

  it("parses URL filters, ignoring unknown or repeated values", () => {
    expect(parseVendorCategoryParam("music")).toBe("music");
    expect(parseVendorCategoryParam("musica")).toBeNull();
    expect(parseVendorCategoryParam(["music", "venue"])).toBeNull();
    expect(parseVendorCategoryParam(undefined)).toBeNull();
    expect(parseVendorStatusParam("booked")).toBe("booked");
    expect(parseVendorStatusParam("paid")).toBeNull();
  });
});
