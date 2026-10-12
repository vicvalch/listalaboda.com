import { describe, expect, it } from "vitest";

import { formatMoney } from "@/lib/vendors/money";
import { attentionPath, KIND_LEVEL } from "@/lib/weddings/overview/attention";
import {
  attentionDetail,
  attentionRow,
  basicCard,
  CARD_ATTENTION_CAP,
  checklistFact,
  countdownLabel,
  formatAmounts,
  GLOBAL_ATTENTION_CAP,
  globalAttention,
  guestsFact,
  headerSummary,
  myWeddingsListView,
  richCard,
  showPageAllClear,
  vendorsFact,
} from "@/lib/weddings/overview/presentation";
import type {
  AttentionDestination,
  AttentionItem,
  AttentionKind,
  MoneyBucket,
  OverviewDomain,
  VendorsOverview,
  WeddingOverview,
  WeddingsOverview,
} from "@/lib/weddings/overview/types";
import type { WeddingSummary } from "@/lib/weddings/service";

// LB-24C presentation (ADR-018 §12): copy, caps and gating over the LB-24B
// overview. Nothing here derives attention, order, completeness or all-clear.

const W1 = "00000000-0000-4000-8000-000000000001";
const W2 = "00000000-0000-4000-8000-000000000002";
const W3 = "00000000-0000-4000-8000-000000000003";

const DESTINATION: Record<AttentionKind, AttentionDestination> = {
  payment_overdue: "budget",
  checklist_overdue: "checklist_plan",
  payment_due_soon: "budget",
  seated_declined: "seating",
  payment_to_unbooked_vendor: "budget",
  budget_total_over: "budget",
  wedding_date_missing: "settings",
  wedding_time_zone_missing: "settings",
};

const crc = (amount: number): MoneyBucket => ({ currency: "CRC", amountMinor: BigInt(amount) });
const usd = (amount: number): MoneyBucket => ({ currency: "USD", amountMinor: BigInt(amount) });

function item(
  kind: AttentionKind,
  fields: Partial<Pick<AttentionItem, "count" | "amounts" | "since" | "weddingId">> = {},
): AttentionItem {
  const weddingId = fields.weddingId ?? W1;
  return {
    id: `${weddingId}:${kind}`,
    weddingId,
    kind,
    level: KIND_LEVEL[kind],
    count: fields.count ?? 1,
    amounts: fields.amounts ?? [],
    since: fields.since ?? null,
    destination: DESTINATION[kind],
  };
}

function summary(id: string, overrides: Partial<WeddingSummary> = {}): WeddingSummary {
  return {
    id,
    name: `Boda ${id.slice(-1)}`,
    weddingDate: "2027-03-20",
    city: null,
    timeZone: "America/Costa_Rica",
    role: "owner",
    ...overrides,
  };
}

const vendors = (total: number, booked: number): VendorsOverview => ({
  total,
  byStatus: { considering: total - booked, quoted: 0, selected: 0, booked, discarded: 0 },
  contractedTotals: [],
  bookedWithoutAmount: 0,
});

function wedding(
  id: string,
  options: Partial<{
    summary: Partial<WeddingSummary>;
    attention: readonly AttentionItem[];
    unavailable: OverviewDomain[];
  }> = {},
): WeddingOverview {
  const attention = options.attention ?? [];
  const unavailable = options.unavailable ?? [];
  const down = (domain: OverviewDomain) => unavailable.includes(domain);
  return {
    wedding: summary(id, options.summary),
    countdown: { state: "before", days: 30 },
    checklist: down("checklist")
      ? { status: "unavailable" }
      : {
          status: "ok",
          value: {
            progress: { done: 3, pending: 7, notApplicable: 2, applicable: 10, percent: 30 },
            overdueCount: 0,
            oldestOverdueOn: null,
          },
        },
    guests: down("guests")
      ? { status: "unavailable" }
      : {
          status: "ok",
          value: {
            guests: { parties: 4, total: 12, responded: 8, attending: 7, notAttending: 1, pending: 4 },
            seating: { confirmed: 7, seated: 0, confirmedUnseated: 7, seatedDeclined: 0 },
          },
        },
    vendors: down("budget") ? { status: "unavailable" } : { status: "ok", value: vendors(5, 2) },
    budget: { status: "unavailable" },
    timeline: down("timeline") ? { status: "unavailable" } : { status: "ok", value: { entryCount: 0, timedCount: 0, untimedCount: 0, now: null } },
    attention,
    attentionLevel: attention[0]?.level ?? null,
    unavailableDomains: unavailable,
  };
}

type Ready = Extract<WeddingsOverview, { status: "ready" }>;

/** A ready overview exactly as LB-24B would state it (the flags are given, not derived here). */
function ready(weddings: WeddingOverview[], attention: readonly AttentionItem[], flags: Partial<Ready> = {}): Ready {
  const unavailableDomains = [...new Set(weddings.flatMap((w) => w.unavailableDomains))];
  const complete = unavailableDomains.length === 0;
  return {
    status: "ready",
    weddings,
    attention,
    weddingsNeedingAttention: weddings.filter((w) => w.attention.length > 0).length,
    unavailableDomains,
    complete,
    allClear: complete && attention.length === 0,
    ...flags,
  };
}

// ------------------------------------------------------------- the 8 kinds

describe("attention rows: all 8 kinds", () => {
  const owner = { name: "Boda de Ana", role: "owner" as const };
  const collaborator = { name: "Boda de Ana", role: "collaborator" as const };

  const cases: [AttentionItem, string, string, string][] = [
    [
      item("payment_overdue", { count: 2, amounts: [crc(15_000_000), usd(120_000)], since: "2026-09-01" }),
      "Cuotas vencidas",
      "Atrasado",
      `2 cuotas · ${formatMoney(BigInt(15_000_000), "CRC")} · ${formatMoney(BigInt(120_000), "USD")} · desde el 1 de septiembre de 2026`,
    ],
    [
      item("checklist_overdue", { count: 4, since: "2026-08-15" }),
      "Pendientes atrasados",
      "Atrasado",
      "4 pendientes · desde el 15 de agosto de 2026",
    ],
    [
      item("payment_due_soon", { count: 3, amounts: [usd(50_000)], since: "2026-10-15" }),
      "Cuotas en los próximos 14 días",
      "Pronto",
      `3 cuotas · ${formatMoney(BigInt(50_000), "USD")} · la primera el 15 de octubre de 2026`,
    ],
    [item("seated_declined", { count: 2 }), "Personas sentadas que no asistirán", "Revisar", "2 personas"],
    [
      item("payment_to_unbooked_vendor", { count: 2, amounts: [crc(500_000)] }),
      "Pagos a proveedores no contratados",
      "Revisar",
      `2 proveedores · ${formatMoney(BigInt(500_000), "CRC")}`,
    ],
    [
      item("budget_total_over", { count: 2, amounts: [crc(100_000), usd(2_500)] }),
      "Sobre presupuesto",
      "Revisar",
      `por ${formatMoney(BigInt(100_000), "CRC")} · por ${formatMoney(BigInt(2_500), "USD")}`,
    ],
    [item("wedding_date_missing"), "Falta la fecha de la boda", "Por completar", "Puedes definirla en Ajustes de la boda."],
    [item("wedding_time_zone_missing"), "Falta la zona horaria", "Por completar", "Puedes definirla en Ajustes de la boda."],
  ];

  it("covers exactly the closed taxonomy", () => {
    expect(cases.map(([i]) => i.kind).sort()).toEqual(Object.keys(DESTINATION).sort());
  });

  it.each(cases)("%# exact title, level label, detail and attentionPath href (owner)", (input, title, level, detail) => {
    const row = attentionRow(input, owner);
    expect(row.title).toBe(title);
    expect(row.levelLabel).toBe(level);
    expect(row.detail).toBe(detail);
    expect(row.href).toBe(attentionPath(input.weddingId, input.destination, "owner"));
    expect(row.weddingName).toBe("Boda de Ana");
    expect(row.linkLabel).toBe(`Revisar: ${title}, Boda de Ana`);
  });

  it("hrefs: budget, ?view=plan, seating; settings only for owners", () => {
    const href = (kind: AttentionKind, role: "owner" | "collaborator") =>
      attentionRow(item(kind), role === "owner" ? owner : collaborator).href;
    const base = `/app/weddings/${W1}`;
    expect(href("payment_overdue", "collaborator")).toBe(`${base}/budget`);
    expect(href("payment_due_soon", "owner")).toBe(`${base}/budget`);
    expect(href("payment_to_unbooked_vendor", "owner")).toBe(`${base}/budget`);
    expect(href("budget_total_over", "collaborator")).toBe(`${base}/budget`);
    expect(href("checklist_overdue", "collaborator")).toBe(`${base}?view=plan`);
    expect(href("seated_declined", "collaborator")).toBe(`${base}/seating`);
    expect(href("wedding_date_missing", "owner")).toBe(`${base}/settings`);
    expect(href("wedding_time_zone_missing", "owner")).toBe(`${base}/settings`);
    expect(href("wedding_date_missing", "collaborator")).toBe(base);
    expect(href("wedding_time_zone_missing", "collaborator")).toBe(base);
  });

  it("collaborator setup items explain that only the organizer can define them", () => {
    for (const kind of ["wedding_date_missing", "wedding_time_zone_missing"] as const) {
      const row = attentionRow(item(kind), collaborator);
      expect(row.detail).toBe("Solo quien organiza la boda puede definirla.");
      expect(row.href).not.toContain("/settings");
    }
  });

  it("singular forms", () => {
    expect(attentionDetail(item("payment_overdue", { count: 1, amounts: [crc(100)], since: "2026-09-01" }), "owner")).toBe(
      `1 cuota · ${formatMoney(BigInt(100), "CRC")} · desde el 1 de septiembre de 2026`,
    );
    expect(attentionDetail(item("checklist_overdue", { count: 1, since: "2026-09-01" }), "owner")).toBe(
      "1 pendiente · desde el 1 de septiembre de 2026",
    );
    expect(attentionDetail(item("payment_due_soon", { count: 1, amounts: [usd(100)], since: "2026-10-20" }), "owner")).toBe(
      `1 cuota · ${formatMoney(BigInt(100), "USD")} · vence el 20 de octubre de 2026`,
    );
    expect(attentionDetail(item("seated_declined", { count: 1 }), "owner")).toBe("1 persona");
    expect(attentionDetail(item("payment_to_unbooked_vendor", { count: 1, amounts: [usd(100)] }), "owner")).toBe(
      `1 proveedor · ${formatMoney(BigInt(100), "USD")}`,
    );
  });

  it("budget_total_over never shows its count", () => {
    const detail = attentionDetail(item("budget_total_over", { count: 1, amounts: [usd(2_500)] }), "owner");
    expect(detail).toBe(`por ${formatMoney(BigInt(2_500), "USD")}`);
    expect(detail).not.toMatch(/^1\b/);
  });
});

describe("currencies stay separate", () => {
  it("CRC only, USD only, both: one formatted amount per bucket, in the overview's order", () => {
    expect(formatAmounts([crc(1_500_000)])).toEqual([formatMoney(BigInt(1_500_000), "CRC")]);
    expect(formatAmounts([usd(99_900)])).toEqual([formatMoney(BigInt(99_900), "USD")]);
    expect(formatAmounts([crc(1_500_000), usd(99_900)])).toEqual([
      formatMoney(BigInt(1_500_000), "CRC"),
      formatMoney(BigInt(99_900), "USD"),
    ]);
  });

  it("never combines CRC and USD into one figure", () => {
    const detail = attentionDetail(item("payment_overdue", { count: 2, amounts: [crc(10_000), usd(10_000)] }), "owner");
    expect(detail).toContain(formatMoney(BigInt(10_000), "CRC"));
    expect(detail).toContain(formatMoney(BigInt(10_000), "USD"));
    expect(detail).not.toContain(formatMoney(BigInt(20_000), "CRC"));
    expect(detail).not.toContain(formatMoney(BigInt(20_000), "USD"));
    expect(detail).toMatch(/₡/);
    expect(detail).toMatch(/US\$/);
  });

  it("a view model never carries a bigint", () => {
    const w = wedding(W1, { attention: [item("payment_overdue", { count: 1, amounts: [crc(10), usd(10)] })] });
    // JSON.stringify throws on a bigint anywhere in the structure.
    expect(() => JSON.stringify(richCard(w))).not.toThrow();
  });
});

// --------------------------------------------------------------- countdown

describe("countdown copy (from the overview's state only)", () => {
  it("all five states", () => {
    expect(countdownLabel({ state: "before", days: 12 })).toBe("Faltan 12 días");
    expect(countdownLabel({ state: "before", days: 1 })).toBe("Falta 1 día");
    expect(countdownLabel({ state: "today" })).toBe("Es hoy");
    expect(countdownLabel({ state: "after", days: 3 })).toBe("Fue hace 3 días");
    expect(countdownLabel({ state: "after", days: 1 })).toBe("Fue ayer");
    expect(countdownLabel({ state: "undated" })).toBeNull();
    expect(countdownLabel({ state: "no_time_zone" })).toBeNull();
  });
});

// ------------------------------------------------------------------- facts

describe("card facts", () => {
  const w = wedding(W1);

  it("checklist: done of applicable, empty, unavailable", () => {
    expect(checklistFact(w.checklist)).toEqual({ label: "Pendientes", value: "3 de 10 completados", unavailable: false });
    expect(
      checklistFact({
        status: "ok",
        value: { progress: { done: 0, pending: 0, notApplicable: 4, applicable: 0, percent: 0 }, overdueCount: 0, oldestOverdueOn: null },
      }).value,
    ).toBe("Sin pendientes todavía");
    expect(checklistFact({ status: "unavailable" })).toEqual({ label: "Pendientes", value: "No disponible", unavailable: true });
  });

  it("guests: attending and unanswered, empty, unavailable", () => {
    expect(guestsFact(w.guests).value).toBe("7 sí · 4 sin responder");
    expect(
      guestsFact({
        status: "ok",
        value: {
          guests: { parties: 0, total: 0, responded: 0, attending: 0, notAttending: 0, pending: 0 },
          seating: { confirmed: 0, seated: 0, confirmedUnseated: 0, seatedDeclined: 0 },
        },
      }).value,
    ).toBe("Sin invitados todavía");
    expect(guestsFact({ status: "unavailable" }).value).toBe("No disponible");
  });

  it("vendors: booked, singular, empty, unavailable (never zero)", () => {
    expect(vendorsFact({ status: "ok", value: vendors(5, 2) }).value).toBe("2 contratados");
    expect(vendorsFact({ status: "ok", value: vendors(5, 1) }).value).toBe("1 contratado");
    expect(vendorsFact({ status: "ok", value: vendors(3, 0) }).value).toBe("0 contratados");
    expect(vendorsFact({ status: "ok", value: vendors(0, 0) }).value).toBe("Sin proveedores todavía");
    expect(vendorsFact({ status: "unavailable" }).value).toBe("No disponible");
  });

  it("exactly three facts: checklist, guests, vendors", () => {
    expect(richCard(w).facts.map((fact) => fact.label)).toEqual(["Pendientes", "Invitados", "Proveedores"]);
  });
});

// ------------------------------------------------------------------- cards

describe("wedding cards", () => {
  const many = [
    item("payment_overdue", { count: 1, amounts: [crc(10)] }),
    item("checklist_overdue", { count: 2 }),
    item("seated_declined", { count: 1 }),
    item("wedding_time_zone_missing"),
  ];

  it("shows the first two items and keeps the rest in the disclosure, in order", () => {
    const card = richCard(wedding(W1, { attention: many }));
    expect(CARD_ATTENTION_CAP).toBe(2);
    expect(card.attention.map((row) => row.kind)).toEqual(["payment_overdue", "checklist_overdue"]);
    expect(card.moreAttention.map((row) => row.kind)).toEqual(["seated_declined", "wedding_time_zone_missing"]);
    expect(card.moreLabel).toBe("Ver 2 más");
    expect(card.attentionCount).toBe("4 temas para revisar");
    expect(card.accent).toBe("overdue");
  });

  it("one item: singular count, no disclosure", () => {
    const card = richCard(wedding(W1, { attention: [item("payment_due_soon", { count: 5 })] }));
    expect(card.attentionCount).toBe("1 tema para revisar");
    expect(card.moreLabel).toBeNull();
    expect(card.moreAttention).toEqual([]);
    expect(card.accent).toBe("due_soon");
  });

  it("all-clear only with no attention AND nothing unavailable", () => {
    expect(richCard(wedding(W1)).allClear).toBe(true);
    expect(richCard(wedding(W1)).partial).toBe(false);
    const partial = richCard(wedding(W1, { unavailable: ["guests"] }));
    expect(partial.allClear).toBe(false);
    expect(partial.partial).toBe(true);
    expect(partial.facts[1].value).toBe("No disponible");
    expect(richCard(wedding(W1, { attention: [item("seated_declined")] })).allClear).toBe(false);
  });

  it("the presenter never invents attention: [] stays empty whatever the summaries say", () => {
    const quiet = wedding(W1, { summary: { weddingDate: null, timeZone: null } });
    const busy: WeddingOverview = {
      ...quiet,
      checklist: {
        status: "ok",
        value: { progress: { done: 0, pending: 9, notApplicable: 0, applicable: 9, percent: 0 }, overdueCount: 9, oldestOverdueOn: "2026-01-01" },
      },
    };
    const card = richCard(busy);
    expect(card.attention).toEqual([]);
    expect(card.attentionCount).toBeNull();
    expect(card.accent).toBeNull();
  });

  it("date line, city, role", () => {
    const card = richCard(wedding(W1, { summary: { city: "Escazú", role: "collaborator" } }));
    expect(card.dateLine).toBe("20 de marzo de 2027 · Escazú");
    expect(card.roleLabel).toBe("Colaboras en esta boda");
    expect(card.countdown).toBe("Faltan 30 días");
    expect(basicCard(summary(W2, { weddingDate: null })).dateLine).toBe("Fecha por definir");
    expect(basicCard(summary(W2)).roleLabel).toBe("Organizas esta boda");
    expect(basicCard(summary(W2)).href).toBe(`/app/weddings/${W2}`);
  });
});

// -------------------------------------------------------------------- page

describe("global attention panel", () => {
  it("needs 2+ weddings and some attention", () => {
    const one = wedding(W1, { attention: [item("seated_declined")] });
    expect(globalAttention(ready([one], one.attention))).toBeNull();
    expect(globalAttention(ready([wedding(W1), wedding(W2)], []))).toBeNull();
    const two = ready([one, wedding(W2)], one.attention);
    expect(globalAttention(two)?.rows.map((row) => row.id)).toEqual([`${W1}:seated_declined`]);
  });

  it("first six in the overview's own order (never regrouped or resorted); overflow count", () => {
    const kinds: AttentionKind[] = ["seated_declined", "payment_overdue", "wedding_date_missing", "checklist_overdue"];
    // Deliberately interleaved weddings and not in level order: the given order wins.
    const global = [W2, W1, W3].flatMap((id) => kinds.map((kind) => item(kind, { weddingId: id })));
    const weddings = [W1, W2, W3].map((id) => wedding(id, { attention: global.filter((i) => i.weddingId === id) }));
    const panel = globalAttention(ready(weddings, global));
    expect(GLOBAL_ATTENTION_CAP).toBe(6);
    expect(panel?.rows.map((row) => row.id)).toEqual(global.slice(0, 6).map((i) => i.id));
    expect(panel?.moreLabel).toBe("Y 6 temas más en tus bodas, abajo.");
    expect(panel?.rows[0].weddingName).toBe("Boda 2");

    const seven = global.slice(0, 7);
    expect(globalAttention(ready(weddings, seven))?.moreLabel).toBe("Y 1 tema más en tus bodas, abajo.");
    expect(globalAttention(ready(weddings, global.slice(0, 6)))?.moreLabel).toBeNull();
  });
});

describe("header summary", () => {
  it("complete: n of total, singular and plural; nothing when none need attention", () => {
    const a = wedding(W1, { attention: [item("seated_declined")] });
    const b = wedding(W2, { attention: [item("seated_declined", { weddingId: W2 })] });
    expect(headerSummary(ready([a, wedding(W2), wedding(W3)], a.attention))).toBe("1 de 3 bodas necesita atención");
    expect(headerSummary(ready([a, b, wedding(W3)], [...a.attention, ...b.attention]))).toBe(
      "2 de 3 bodas necesitan atención",
    );
    expect(headerSummary(ready([wedding(W1), wedding(W2)], []))).toBeNull();
    expect(headerSummary(ready([a], a.attention))).toBe("Esta boda necesita atención.");
  });

  it("incomplete: only what was found, never 'n of total'", () => {
    const a = wedding(W1, { attention: [item("seated_declined")] });
    const b = wedding(W2, { unavailable: ["budget"] });
    expect(headerSummary(ready([a, b, wedding(W3)], a.attention))).toBe("Encontramos pendientes en 1 boda.");
    const c = wedding(W3, { attention: [item("wedding_date_missing", { weddingId: W3 })] });
    expect(headerSummary(ready([a, b, c], [...a.attention, ...c.attention]))).toBe("Encontramos pendientes en 2 bodas.");
  });
});

describe("page all-clear gating", () => {
  it("only ready + complete + allClear + 2 or more weddings", () => {
    expect(showPageAllClear(ready([wedding(W1), wedding(W2)], []))).toBe(true);
    expect(showPageAllClear(ready([wedding(W1)], []))).toBe(false);
    const partial = ready([wedding(W1), wedding(W2, { unavailable: ["timeline"] })], []);
    expect(partial.complete).toBe(false);
    expect(showPageAllClear(partial)).toBe(false);
    // Even if a (hypothetical) incomplete overview claimed allClear, the page wouldn't.
    expect(showPageAllClear({ ...partial, allClear: true })).toBe(false);
    const busy = wedding(W1, { attention: [item("seated_declined")] });
    expect(showPageAllClear(ready([busy, wedding(W2)], busy.attention))).toBe(false);
  });
});

describe("myWeddingsListView: fallbacks", () => {
  const list = [summary(W1), summary(W2, { role: "collaborator" })];

  it("error → basic cards from the first list with a notice; never empty", () => {
    const view = myWeddingsListView(list, { status: "error" });
    expect(view.mode).toBe("basic");
    expect(view.notice).toBe("No pudimos cargar el resumen de tus bodas. Puedes seguir entrando a cada una.");
    expect(view.cards.map((card) => card.id)).toEqual([W1, W2]);
    expect(view.cards.every((card) => !("facts" in card))).toBe(true);
  });

  it("over_limit → basic cards, every wedding, never sliced, no summary", () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      summary(`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`),
    );
    const view = myWeddingsListView(many, { status: "over_limit", weddingCount: 101, limit: 100 });
    expect(view.mode).toBe("basic");
    expect(view.notice).toBe(
      "El resumen de pendientes funciona con hasta 100 bodas. Tienes 101, así que mostramos solo la lista.",
    );
    expect(view.cards).toHaveLength(101);
    expect("summary" in view).toBe(false);
  });

  it("ready + complete → rich, no notice; card order is the overview's (never by attention)", () => {
    const busy = wedding(W2, { attention: [item("payment_overdue", { weddingId: W2 })] });
    const view = myWeddingsListView(list, ready([wedding(W1), busy], busy.attention));
    expect(view.mode).toBe("rich");
    expect(view.notice).toBeNull();
    expect(view.cards.map((card) => card.id)).toEqual([W1, W2]);
  });

  it("ready + partial → one info notice naming the areas, no all-clear", () => {
    const view = myWeddingsListView(
      list,
      ready([wedding(W1, { unavailable: ["checklist", "guests"] }), wedding(W2, { unavailable: ["budget", "timeline"] })], []),
    );
    expect(view.mode).toBe("rich");
    expect(view.notice).toBe(
      "No pudimos cargar algunos datos (pendientes, invitados y mesas, proveedores y presupuesto, cronograma). Lo que ves puede estar incompleto; tus bodas siguen disponibles.",
    );
    if (view.mode === "rich") expect(view.allClear).toBe(false);
  });
});
