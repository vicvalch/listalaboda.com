import { expect, test, type Page } from "@playwright/test";

import { formatMoney } from "../src/lib/vendors/money";
import { es, logIn } from "./support/flows";
import { createAccountWithId, seedManyWeddings, seedWedding } from "./support/overview";

// LB-24C (ADR-017, ADR-018 §12): the operational "Mis bodas" page and its
// deep links. Fixtures are written straight to the local database; the page
// always reads them as the signed-in user, through their memberships only.

const copy = es.app.weddings;
const WEDDING_URL = (id: string, rest = "") => new RegExp(`/app/weddings/${id}${rest.replace("?", "\\?")}$`);

/** Intl's no-break spaces, as Playwright normalizes them. */
function money(minor: number, currency: "CRC" | "USD"): string {
  return formatMoney(minor, currency).replace(/\s/g, " ");
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** No link or button inside another interactive element. */
async function expectNoNestedInteractive(page: Page) {
  const nested = await page.evaluate(
    () => document.querySelectorAll("a a, a button, button a, button button, summary a, summary button").length,
  );
  expect(nested).toBe(0);
}

function cards(page: Page) {
  return page.getByTestId("wedding-card");
}

function card(page: Page, name: string) {
  return cards(page).filter({ has: page.getByRole("heading", { level: 3, name }) });
}

function panel(page: Page) {
  return page.getByTestId("global-attention");
}

test.describe("Mis bodas: account states", () => {
  test("one wedding: /app redirects; ?all=1 shows one rich card and no global panel", async ({ page }) => {
    const me = await createAccountWithId("lb24c-one");
    const id = await seedWedding({
      name: "Boda de Lucía y Andrés",
      city: "Heredia",
      members: [{ userId: me.id, role: "owner" }],
      overdueChecklist: 2,
      doneChecklist: 3,
      attending: 2,
      unanswered: 1,
    });
    await logIn(page, me.email);
    await expect(page).toHaveURL(WEDDING_URL(id));

    await page.goto("/app?all=1");
    await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: copy.overview.listTitle })).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByTestId("my-weddings-summary")).toHaveText(copy.overview.summarySingle);

    const only = card(page, "Boda de Lucía y Andrés");
    await expect(only.getByTestId("wedding-card-date")).toContainText("· Heredia · Faltan 120 días");
    await expect(only.getByTestId("wedding-card-role")).toHaveText(copy.roleOwner);
    await expect(only.getByTestId("wedding-card-attention")).toContainText("1 tema para revisar");
    await expect(only.getByTestId("attention-row")).toHaveCount(1);
    await expect(only.getByTestId("attention-row")).toContainText("Pendientes atrasados");
    await expect(only.getByTestId("wedding-card-fact")).toHaveText([
      "Pendientes3 de 5 completados",
      "Invitados2 sí · 1 sin responder",
      "ProveedoresSin proveedores todavía",
    ]);
    await expect(only).toHaveAttribute("data-attention-level", "overdue");

    // The card is an article whose name and "Abrir boda" link open the wedding.
    await only.getByRole("link", { name: `${copy.card.open}: Boda de Lucía y Andrés` }).click();
    await expect(page).toHaveURL(WEDDING_URL(id));
  });

  test("three weddings, mixed attention: header, global panel, cards, disclosure, deep links", async ({ page }) => {
    const me = await createAccountWithId("lb24c-mixed");
    const other = await createAccountWithId("lb24c-mixed-other");
    const busy = await seedWedding({
      name: "Boda de Sofía y Víctor",
      city: "San José",
      members: [{ userId: me.id, role: "owner" }],
      overduePayments: { crc: 150_000_000, usd: 120_000 },
      overdueChecklist: 3,
      seatedDeclined: 2,
      attending: 4,
    });
    const shared = await seedWedding({
      name: "Boda de un cliente sin fecha",
      date: null,
      members: [
        { userId: other.id, role: "owner" },
        { userId: me.id, role: "collaborator" },
      ],
    });
    const calm = await seedWedding({ name: "Boda tranquila", members: [{ userId: me.id, role: "owner" }] });
    // Someone else's wedding never appears.
    await seedWedding({ name: "Boda ajena", members: [{ userId: other.id, role: "owner" }], overdueChecklist: 1 });

    await logIn(page, me.email);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByTestId("my-weddings-summary")).toHaveText("2 de 3 bodas necesitan atención");
    await expect(page.getByText("Boda ajena")).toHaveCount(0);

    // List order is the membership list's (dated first, undated last), never attention.
    await expect(cards(page).locator("h3")).toHaveText([
      "Boda de Sofía y Víctor",
      "Boda tranquila",
      "Boda de un cliente sin fecha",
    ]);

    // Global panel: the overview's order, each row with badge, wedding, title, detail and "Revisar".
    await expect(panel(page).getByRole("heading", { level: 2, name: copy.overview.attentionTitle })).toBeVisible();
    const rows = panel(page).getByTestId("attention-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.getByTestId("attention-level")).toHaveText(["Atrasado", "Atrasado", "Revisar", "Por completar"]);
    const overdue = rows.filter({ hasText: "Cuotas vencidas" });
    await expect(overdue).toContainText("Boda de Sofía y Víctor");
    await expect(overdue).toContainText(
      `2 cuotas · ${money(150_000_000, "CRC")} · ${money(120_000, "USD")} · desde el`,
    );
    await expect(panel(page)).not.toContainText(/temas más/);

    // Busy card: count, first two rows, the rest behind native "Ver 1 más".
    const busyCard = card(page, "Boda de Sofía y Víctor");
    await expect(busyCard).toHaveAttribute("data-attention-level", "overdue");
    await expect(busyCard.getByTestId("wedding-card-attention")).toContainText("3 temas para revisar");
    const more = busyCard.getByText("Ver 1 más");
    await expect(busyCard.getByTestId("attention-row").filter({ visible: true })).toHaveCount(2);
    await more.click();
    await expect(busyCard.getByTestId("attention-row").filter({ visible: true })).toHaveCount(3);
    await expect(busyCard.getByTestId("attention-row").nth(2)).toContainText("Personas sentadas que no asistirán");

    // Collaborator card: setup items explained, never a settings link.
    const sharedCard = card(page, "Boda de un cliente sin fecha");
    await expect(sharedCard.getByTestId("wedding-card-role")).toHaveText(copy.roleCollaborator);
    await expect(sharedCard.getByTestId("wedding-card-date")).toHaveText(copy.noDate);
    await expect(sharedCard).toContainText(copy.attention.setupCollaborator);
    await expect(sharedCard.locator('a[href$="/settings"]')).toHaveCount(0);

    // Calm card: all-clear, its facts.
    const calmCard = card(page, "Boda tranquila");
    await expect(calmCard).toContainText(copy.card.allClear);
    await expect(calmCard).not.toHaveAttribute("data-attention-level", /.+/);
    await expect(page.getByTestId("my-weddings-all-clear")).toHaveCount(0);

    // Accessibility: headings, no nested controls, text badges, link names.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText([copy.title]);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([copy.overview.attentionTitle, copy.overview.listTitle]);
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(3);
    await expectNoNestedInteractive(page);
    await expect(
      panel(page).getByRole("link", { name: "Revisar: Cuotas vencidas, Boda de Sofía y Víctor" }),
    ).toBeVisible();

    // Deep links: each row's own destination.
    const destinations: [string, string, RegExp][] = [
      ["Cuotas vencidas", "Boda de Sofía y Víctor", WEDDING_URL(busy, "/budget")],
      ["Pendientes atrasados", "Boda de Sofía y Víctor", WEDDING_URL(busy, "?view=plan")],
      ["Personas sentadas que no asistirán", "Boda de Sofía y Víctor", WEDDING_URL(busy, "/seating")],
      ["Falta la fecha de la boda", "Boda de un cliente sin fecha", WEDDING_URL(shared)],
    ];
    for (const [title, wedding, url] of destinations) {
      await page.goto("/app");
      await panel(page).getByRole("link", { name: `Revisar: ${title}, ${wedding}` }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    expect(calm).toBeTruthy();
  });

  test("owner setup items open settings", async ({ page }) => {
    const me = await createAccountWithId("lb24c-setup");
    const undated = await seedWedding({ name: "Boda sin fecha propia", date: null, members: [{ userId: me.id, role: "owner" }] });
    await seedWedding({ name: "Boda sin zona", timeZone: null, members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await expect(card(page, "Boda sin fecha propia")).toContainText(copy.attention.setupOwner);
    await panel(page).getByRole("link", { name: "Revisar: Falta la fecha de la boda, Boda sin fecha propia" }).click();
    await expect(page).toHaveURL(WEDDING_URL(undated, "/settings"));
    await expect(page.getByRole("heading", { level: 1, name: es.weddingSettings.title })).toBeVisible();
  });

  test("all clear: only with complete data and 2+ weddings", async ({ page }) => {
    const me = await createAccountWithId("lb24c-clear");
    await seedWedding({ name: "Boda uno", members: [{ userId: me.id, role: "owner" }], doneChecklist: 2 });
    await seedWedding({ name: "Boda dos", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await expect(page.getByTestId("my-weddings-all-clear")).toHaveText(copy.overview.allClear);
    await expect(page.getByTestId("my-weddings-summary")).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("main").getByRole("status")).toHaveCount(0);
    await expect(cards(page).getByText(copy.card.allClear)).toHaveCount(2);
    await expect(page.getByText("Todo está listo")).toHaveCount(0);
  });

  test("partial data: info notice, 'No disponible', never all-clear", async ({ page }) => {
    const me = await createAccountWithId("lb24c-partial");
    await seedWedding({ name: "Boda enorme", members: [{ userId: me.id, role: "owner" }], truncatedChecklist: true });
    await seedWedding({ name: "Boda normal", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await expect(page.locator("main").getByRole("status")).toHaveText(
      "No pudimos cargar algunos datos (pendientes). Lo que ves puede estar incompleto; tus bodas siguen disponibles.",
    );
    await expect(page.getByTestId("my-weddings-all-clear")).toHaveCount(0);
    const huge = card(page, "Boda enorme");
    await expect(huge.getByTestId("wedding-card-fact").first()).toHaveText(`Pendientes${copy.card.unavailable}`);
    await expect(huge).toContainText(copy.card.partial);
    await expect(huge).not.toContainText(copy.card.allClear);
    await expect(card(page, "Boda normal")).toContainText(copy.card.allClear);
  });

  test("over the overview limit: the whole list, basic cards, a notice", async ({ page }) => {
    const me = await createAccountWithId("lb24c-over");
    await seedManyWeddings(me.id, 101);
    await logIn(page, me.email);
    await expect(page.locator("main").getByRole("status")).toHaveText(
      "El resumen de pendientes funciona con hasta 100 bodas. Tienes 101, así que mostramos solo la lista.",
    );
    await expect(cards(page)).toHaveCount(101);
    await expect(page.getByTestId("wedding-card-fact")).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByTestId("my-weddings-summary")).toHaveCount(0);
    await expect(page.getByTestId("my-weddings-all-clear")).toHaveCount(0);
    await expect(page.getByText(copy.emptyTitle)).toHaveCount(0);
  });

  test("no browser-side REST reads: the overview is server-rendered", async ({ page }) => {
    const me = await createAccountWithId("lb24c-norest");
    await seedWedding({ name: "Boda A", members: [{ userId: me.id, role: "owner" }], overdueChecklist: 1 });
    await seedWedding({ name: "Boda B", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    const rest: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/rest/v1/")) rest.push(request.url());
    });
    await page.goto("/app");
    await expect(cards(page)).toHaveCount(2);
    await page.waitForLoadState("networkidle");
    expect(rest).toEqual([]);
  });
});

test.describe("Mis bodas on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("stacked header, readable rows and cards, no overflow, long names", async ({ page }) => {
    const me = await createAccountWithId("lb24c-mobile");
    await seedWedding({
      name: "Boda de Alejandra Montenegro Villalobos y Sebastián Rodríguez Quesada",
      city: "San Rafael de Escazú, San José, Costa Rica",
      members: [{ userId: me.id, role: "owner" }],
      overduePayments: { crc: 2_500_000_000, usd: 1_250_000 },
      overdueChecklist: 2,
      seatedDeclined: 1,
    });
    await seedWedding({ name: "Boda corta", date: null, members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await expect(cards(page)).toHaveCount(2);
    await expectNoHorizontalOverflow(page);
    const cta = page.locator("main").getByRole("link", { name: copy.createAnother });
    const box = await cta.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    for (const link of await panel(page).getByRole("link").all()) {
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
