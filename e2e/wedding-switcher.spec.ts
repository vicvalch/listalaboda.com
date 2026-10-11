import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { es, logIn } from "./support/flows";
import { createAccountWithId, daysFromToday, seedManyWeddings, seedWedding } from "./support/overview";

// LB-24C (ADR-017): the wedding switcher. Navigation only, over the caller's
// own memberships; known sections kept, settings only for owners; query
// strings never cross weddings; nothing remembers a "current" wedding.

const copy = es.app.weddings.switcher;
const URL_OF = (id: string, rest = "") => new RegExp(`/app/weddings/${id}${rest}$`);

function switcher(page: Page) {
  return page.getByTestId("wedding-switcher");
}

function summary(page: Page) {
  return switcher(page).locator("summary");
}

function options(page: Page) {
  return switcher(page).getByTestId("wedding-switcher-option");
}

async function open(page: Page) {
  await summary(page).click();
  await expect(switcher(page)).toHaveAttribute("open", "");
}

async function switchTo(page: Page, name: string) {
  await open(page);
  await options(page).filter({ hasText: name }).click();
}

type StorageSnapshot = { cookies: string[]; local: string[]; session: string[] };

async function snapshot(page: Page, context: BrowserContext): Promise<StorageSnapshot> {
  const cookies = (await context.cookies()).map((cookie) => cookie.name).sort();
  const [local, session] = await page.evaluate(() => [Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]);
  return { cookies, local, session };
}

test.describe("wedding switcher", () => {
  test("one wedding: no switcher", async ({ page }) => {
    const me = await createAccountWithId("lb24c-sw-one");
    const id = await seedWedding({ name: "Boda única", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await expect(page).toHaveURL(URL_OF(id));
    await expect(page.getByRole("heading", { level: 1, name: "Boda única" })).toBeVisible();
    await expect(switcher(page)).toHaveCount(0);
  });

  test("switching keeps known sections, drops queries, respects the target role; no stored state", async ({
    page,
    context,
  }) => {
    const me = await createAccountWithId("lb24c-sw");
    const other = await createAccountWithId("lb24c-sw-other");
    const mine = await seedWedding({
      name: "Boda de Sofía y Víctor",
      city: "San José",
      date: daysFromToday(100),
      members: [{ userId: me.id, role: "owner" }],
      overduePayments: { crc: 100_000 },
    });
    const second = await seedWedding({ name: "Boda de Ana", members: [{ userId: me.id, role: "owner" }] });
    const shared = await seedWedding({
      name: "Boda donde colaboro",
      date: null,
      members: [
        { userId: other.id, role: "owner" },
        { userId: me.id, role: "collaborator" },
      ],
    });
    const foreign = await seedWedding({ name: "Boda ajena", members: [{ userId: other.id, role: "owner" }] });
    // created_by alone is never access.
    await seedWedding({
      name: "Boda creada por mí, sin membresía",
      createdBy: me.id,
      members: [{ userId: other.id, role: "owner" }],
    });

    await logIn(page, me.email);
    await page.goto(`/app/weddings/${mine}`);
    const before = await snapshot(page, context);

    // Current wedding marked; same authorized set as Mis bodas; foreign and created_by-only absent.
    await expect(summary(page)).toHaveAttribute("aria-label", "Cambiar de boda (actual: Boda de Sofía y Víctor)");
    await open(page);
    await expect(options(page)).toHaveCount(3);
    await expect(switcher(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(switcher(page).locator('[aria-current="page"]')).toContainText("Boda de Sofía y Víctor");
    await expect(switcher(page)).not.toContainText("Boda ajena");
    await expect(switcher(page)).not.toContainText("sin membresía");
    await expect(options(page).filter({ hasText: "Boda donde colaboro" })).toContainText(es.app.weddings.noDate);
    await expect(options(page).filter({ hasText: "Boda de Sofía y Víctor" })).toContainText("San José");
    for (const option of await options(page).all()) {
      expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await page.goto("/app?all=1");
    await expect(page.getByTestId("wedding-card").locator("h3")).toHaveText([
      "Boda de Sofía y Víctor",
      "Boda de Ana",
      "Boda donde colaboro",
    ]);

    // Escape closes and returns focus to the summary.
    await page.goto(`/app/weddings/${mine}`);
    await summary(page).focus();
    await page.keyboard.press("Enter");
    await expect(switcher(page)).toHaveAttribute("open", "");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(switcher(page)).not.toHaveAttribute("open", "");
    await expect(summary(page)).toBeFocused();

    // Outside click closes.
    await open(page);
    await page.getByRole("heading", { level: 1 }).click();
    await expect(switcher(page)).not.toHaveAttribute("open", "");

    // Home → home (the ?view= query is dropped).
    await page.goto(`/app/weddings/${mine}?view=plan`);
    await switchTo(page, "Boda de Ana");
    await expect(page).toHaveURL(URL_OF(second));
    await expect(page.getByRole("heading", { level: 1, name: "Boda de Ana" })).toBeVisible();
    // Navigation closed the panel; the new current wedding is marked.
    await expect(switcher(page)).not.toHaveAttribute("open", "");
    await expect(summary(page)).toHaveAttribute("aria-label", "Cambiar de boda (actual: Boda de Ana)");

    // Vendor detail → the target's vendor list.
    await page.goto(`/app/weddings/${mine}/vendors`);
    await page.getByRole("link", { name: "Proveedor CRC" }).first().click();
    await expect(page).toHaveURL(/\/vendors\/[0-9a-f-]{36}$/);
    await switchTo(page, "Boda de Ana");
    await expect(page).toHaveURL(URL_OF(second, "/vendors"));
    await expect(page.getByRole("heading", { level: 1, name: es.vendors.title })).toBeVisible();

    // Budget → budget, guests → guests, seating → seating (also into a collaborator wedding).
    await page.goto(`/app/weddings/${mine}/budget`);
    await switchTo(page, "Boda donde colaboro");
    await expect(page).toHaveURL(URL_OF(shared, "/budget"));
    await expect(page.getByRole("heading", { level: 1, name: es.budget.title })).toBeVisible();
    await switchTo(page, "Boda de Ana");
    await expect(page).toHaveURL(URL_OF(second, "/budget"));
    await page.goto(`/app/weddings/${mine}/seating?view=plan`);
    await switchTo(page, "Boda donde colaboro");
    await expect(page).toHaveURL(URL_OF(shared, "/seating"));

    // Settings: kept for an owner target, home for a collaborator target.
    await page.goto(`/app/weddings/${mine}/settings`);
    await switchTo(page, "Boda de Ana");
    await expect(page).toHaveURL(URL_OF(second, "/settings"));
    await expect(page.getByRole("heading", { level: 1, name: es.weddingSettings.title })).toBeVisible();
    await switchTo(page, "Boda donde colaboro");
    await expect(page).toHaveURL(URL_OF(shared));
    await expect(page.getByRole("heading", { level: 1, name: "Boda donde colaboro" })).toBeVisible();

    // Footer links.
    await open(page);
    await switcher(page).getByRole("link", { name: copy.viewAll }).click();
    await expect(page).toHaveURL(/\/app\?all=1$/);
    await page.goto(`/app/weddings/${mine}`);
    await open(page);
    await switcher(page).getByRole("link", { name: copy.create }).click();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);

    // No hidden "active wedding" anywhere after all that switching.
    await page.goto(`/app/weddings/${mine}`);
    const after = await snapshot(page, context);
    expect(after).toEqual(before);
    expect([...after.cookies, ...after.local, ...after.session].filter((name) => /wedding|boda/i.test(name))).toEqual([]);
    // /app still decides from memberships only: the list, not the last wedding.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app$/);

    // A foreign wedding by URL: still 404 (rendered outside the wedding frame, so no
    // switcher), and its name appears nowhere.
    const response = await page.goto(`/app/weddings/${foreign}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Boda ajena")).toHaveCount(0);
    await expect(switcher(page)).toHaveCount(0);
  });

  test("renaming in settings updates the switcher", async ({ page }) => {
    const me = await createAccountWithId("lb24c-sw-rename");
    const id = await seedWedding({ name: "Boda vieja", members: [{ userId: me.id, role: "owner" }] });
    await seedWedding({ name: "Otra boda", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await page.goto(`/app/weddings/${id}/settings`);
    await page.getByLabel(es.weddingSettings.nameLabel).fill("Boda renombrada");
    await page.getByRole("button", { name: es.weddingSettings.submit }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${id}\\?saved=settings$`));
    await expect(summary(page)).toHaveAttribute("aria-label", "Cambiar de boda (actual: Boda renombrada)");
    await expect(summary(page)).toContainText("Boda renombrada");
  });

  test("persona metadata changes nothing", async ({ page }) => {
    const planner = await createAccountWithId("lb24c-sw-planner", { planner: true, persona: "planner", account_type: "planner" });
    const other = await createAccountWithId("lb24c-sw-planner-other");
    const a = await seedWedding({ name: "Boda cliente 1", members: [{ userId: planner.id, role: "collaborator" }] });
    await seedWedding({ name: "Boda cliente 2", members: [{ userId: planner.id, role: "owner" }] });
    await seedWedding({ name: "Boda no asignada", members: [{ userId: other.id, role: "owner" }] });
    await logIn(page, planner.email);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByTestId("wedding-card")).toHaveCount(2);
    await page.goto(`/app/weddings/${a}`);
    await open(page);
    await expect(options(page)).toHaveCount(2);
    await expect(switcher(page)).not.toContainText("Boda no asignada");
  });

  test("8+ weddings: local search by name or city, accent-insensitive, with a polite result count", async ({ page }) => {
    const me = await createAccountWithId("lb24c-sw-search");
    await seedManyWeddings(me.id, 7, "Boda lista");
    const first = await seedWedding({
      name: "Boda de Sofía",
      city: "Cartago",
      date: "2026-12-01",
      members: [{ userId: me.id, role: "owner" }],
    });
    await logIn(page, me.email);
    await page.goto(`/app/weddings/${first}`);
    await open(page);
    const search = switcher(page).getByLabel(copy.searchLabel);
    await expect(search).toBeVisible();
    await expect(options(page)).toHaveCount(8);
    const status = switcher(page).getByRole("status");
    await expect(status).toHaveText("8 bodas");

    await search.fill("SOFIA");
    await expect(options(page)).toHaveCount(1);
    await expect(status).toHaveText("1 boda");
    await search.fill("cartago");
    await expect(options(page)).toHaveText([/Boda de Sofía/]);
    await search.fill("Ciudad 3");
    await expect(options(page)).toHaveText([/Boda lista 003/]);
    await search.fill("Lima");
    await expect(options(page)).toHaveCount(0);
    await expect(status).toHaveText(copy.noResults);

    // Escape from the search field closes and refocuses the summary; reopening starts clean.
    await page.keyboard.press("Escape");
    await expect(summary(page)).toBeFocused();
    await open(page);
    await expect(switcher(page).getByLabel(copy.searchLabel)).toHaveValue("");
    await expect(options(page)).toHaveCount(8);
  });
});

test.describe("wedding switcher on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("full width, 44 px targets, no overflow, long names wrap", async ({ page }) => {
    const me = await createAccountWithId("lb24c-sw-mobile");
    const id = await seedWedding({
      name: "Boda de Alejandra Montenegro Villalobos y Sebastián Rodríguez Quesada",
      city: "San Rafael de Escazú, San José",
      members: [{ userId: me.id, role: "owner" }],
    });
    await seedWedding({ name: "Boda corta", members: [{ userId: me.id, role: "owner" }] });
    await logIn(page, me.email);
    await page.goto(`/app/weddings/${id}`);
    const box = await summary(page).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(340);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await summary(page).tap();
    await expect(options(page)).toHaveCount(2);
    for (const option of await options(page).all()) {
      expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await options(page).filter({ hasText: "Boda corta" }).tap();
    await expect(page.getByRole("heading", { level: 1, name: "Boda corta" })).toBeVisible();
  });
});
