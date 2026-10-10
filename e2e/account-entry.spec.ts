import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createAccount,
  createInvite,
  createWedding,
  es,
  logIn,
  logOut,
} from "./support/flows";

// LB-24A (ADR-017): /app adapts to the user's own memberships. 0 → empty
// state, 1 → straight into that wedding, 2+ → "Mis bodas". The header's
// "Mis bodas" (`/app?all=1`) always shows the list; the URL stays the only
// wedding selector.

const copy = es.app.weddings;
const WEDDING_URL = (id: string) => new RegExp(`/app/weddings/${id}$`);

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Creates a wedding with an optional city; returns its id. */
async function createWeddingWithCity(page: Page, name: string, date: string, city: string) {
  await page.goto("/app/weddings/new");
  await page.getByLabel(es.weddingNew.nameLabel).fill(name);
  await page.getByLabel(es.weddingNew.dateLabel).fill(date);
  await page.getByLabel(es.weddingNew.cityLabel).fill(city);
  await page.getByRole("button", { name: es.weddingNew.submit }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const id = /\/app\/weddings\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error("wedding id not found in URL");
  return id;
}

/** Joins the wedding behind `inviteUrl` as the signed-in user of `page`. */
async function acceptInvite(page: Page, inviteUrl: string, weddingId: string) {
  await page.goto(inviteUrl);
  await page.getByRole("button", { name: es.inviteAccept.submit }).click();
  await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
  await expect(page.getByText(es.wedding.joined)).toBeVisible();
}

function headerNav(page: Page) {
  return page.getByRole("navigation", { name: es.app.nav.label });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("account entry (/app)", () => {
  test("zero weddings: neutral empty state with create CTA and invitation hint, no redirect", async ({
    page,
  }) => {
    await logIn(page, await createAccount("entry-zero"));
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: copy.emptyTitle })).toBeVisible();
    await expect(page.getByText(copy.emptyBody)).toBeVisible();
    await expect(page.getByText(copy.emptyInviteHint)).toBeVisible();
    await expect(page.getByText(/tu pareja|mi boda/i)).toHaveCount(0);

    // "Mis bodas" shows the same empty state: nothing is invented.
    await headerNav(page).getByRole("link", { name: es.app.nav.myWeddings }).click();
    await expect(page).toHaveURL(/\/app\?all=1$/);
    await expect(page.getByRole("heading", { name: copy.emptyTitle })).toBeVisible();

    await page.getByRole("link", { name: copy.emptyCta }).click();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);
    await expect(page.getByRole("heading", { level: 1, name: es.weddingNew.title })).toBeVisible();
  });

  test("one wedding: /app opens it once; Mis bodas lists it; Crear boda stays available", async ({
    page,
  }) => {
    const email = await createAccount("entry-one");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda única", "2027-06-12");

    // A later login lands in the wedding, through a single redirect.
    await logOut(page);
    await logIn(page, email);
    await expect(page).toHaveURL(WEDDING_URL(weddingId));

    // Exactly one hop: /app → the wedding (no loop, no intermediate stop).
    const response = await page.goto("/app");
    expect(response?.status()).toBe(200);
    const first = response?.request().redirectedFrom();
    expect(first ? new URL(first.url()).pathname : null).toBe("/app");
    expect(first?.redirectedFrom()).toBeNull();
    await expect(page).toHaveURL(WEDDING_URL(weddingId));
    await expect(page.getByRole("heading", { level: 1, name: "Boda única" })).toBeVisible();

    // The header's "Mis bodas" is a real list, not a loop back into the wedding.
    await headerNav(page).getByRole("link", { name: es.app.nav.myWeddings }).click();
    await expect(page).toHaveURL(/\/app\?all=1$/);
    await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
    await expect(page.getByTestId("wedding-card")).toHaveCount(1);
    await expect(page.getByRole("link", { name: copy.createAnother })).toBeVisible();

    // Other query values are ignored: still the fast path.
    for (const query of ["?all=0", "?all=true", "?all=1&all=1", `?weddingId=${weddingId}`]) {
      await page.goto(`/app${query}`);
      await expect(page).toHaveURL(WEDDING_URL(weddingId));
    }

    // The wedding page's own "back" link also reaches the list.
    await page.getByRole("link", { name: es.wedding.backToWeddings }).click();
    await expect(page).toHaveURL(/\/app\?all=1$/);

    // Creating another wedding is one click away from inside the wedding.
    await page.goto(`/app/weddings/${weddingId}`);
    await headerNav(page).getByRole("link", { name: es.app.nav.createWedding }).click();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);
  });

  test("collaborator-only: /app opens the wedding they joined (membership, not created_by)", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("entry-collab-owner"));
    const weddingId = await createWedding(owner.page, "Boda de otra persona");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("entry-collab"));
    await expect(collab.page).toHaveURL(/\/app$/);
    // Invite acceptance lands on the wedding with its feedback, not via /app.
    await acceptInvite(collab.page, inviteUrl, weddingId);
    await expect(collab.page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);

    await collab.page.goto("/app");
    await expect(collab.page).toHaveURL(WEDDING_URL(weddingId));
    await expect(collab.page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);

    await owner.context.close();
    await collab.context.close();
  });

  test("several weddings with mixed roles: the list shows exactly those, with date, city and role", async ({
    browser,
  }) => {
    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("entry-multi-other"));
    const b = await createWedding(other.page, "Boda B de un cliente", "2027-03-02");
    const inviteB = await createInvite(other.page, "collaborator");
    const foreign = await createWeddingWithCity(other.page, "Boda ajena", "2027-01-01", "Cartago");

    const me = await freshPage(browser);
    await logIn(me.page, await createAccount("entry-multi"));
    const a = await createWeddingWithCity(me.page, "Boda A", "2027-08-14", "Escazú");
    const c = await createWedding(me.page, "Boda C sin fecha");
    await acceptInvite(me.page, inviteB, b);

    await me.page.goto("/app");
    await expect(me.page).toHaveURL(/\/app$/);
    await expect(me.page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
    const cards = me.page.getByTestId("wedding-card");
    // Soonest first, undated last.
    await expect(cards.locator("h2")).toHaveText(["Boda B de un cliente", "Boda A", "Boda C sin fecha"]);
    await expect(cards.nth(0)).toContainText("2 de marzo de 2027");
    await expect(cards.nth(0)).not.toContainText("·");
    await expect(cards.nth(0).getByTestId("wedding-card-role")).toHaveText(copy.roleCollaborator);
    await expect(cards.nth(1)).toContainText("14 de agosto de 2027 · Escazú");
    await expect(cards.nth(1).getByTestId("wedding-card-role")).toHaveText(copy.roleOwner);
    await expect(cards.nth(2)).toContainText(copy.noDate);
    await expect(cards.nth(2).getByTestId("wedding-card-role")).toHaveText(copy.roleOwner);
    await expect(me.page.getByText("Boda ajena")).toHaveCount(0);
    await expect(me.page.getByText("Cartago")).toHaveCount(0);

    for (const [index, id] of [b, a, c].entries()) {
      await expect(cards.nth(index)).toHaveAttribute("href", `/app/weddings/${id}`);
    }
    await cards.nth(1).click();
    await expect(me.page).toHaveURL(WEDDING_URL(a));

    // The foreign wedding is still a 404 by direct URL, whatever /app showed.
    const response = await me.page.goto(`/app/weddings/${foreign}`);
    expect(response?.status()).toBe(404);
    // ...and asking for the list never widens access.
    await me.page.goto("/app?all=1");
    await expect(me.page.getByTestId("wedding-card")).toHaveCount(3);
    await expect(me.page.getByText("Boda ajena")).toHaveCount(0);

    // No hidden "active wedding": a planted cookie naming the foreign wedding
    // changes neither /app nor which wedding a URL opens.
    await me.context.addCookies(
      ["active_wedding_id", "current_wedding_id", "lb_active_wedding"].map((name) => ({
        name,
        value: foreign,
        url: new URL(me.page.url()).origin,
      })),
    );
    await me.page.goto("/app");
    await expect(me.page).toHaveURL(/\/app$/);
    await expect(me.page.getByTestId("wedding-card")).toHaveCount(3);
    await me.page.goto(`/app/weddings/${a}`);
    await expect(me.page.getByRole("heading", { level: 1, name: "Boda A" })).toBeVisible();
    expect((await me.page.goto(`/app/weddings/${foreign}`))?.status()).toBe(404);

    await other.context.close();
    await me.context.close();
  });
});

test.describe("account entry on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("empty state and wedding cards fit 390 px; the header stays usable", async ({ page }) => {
    await logIn(page, await createAccount("entry-mobile"));
    await expect(page.getByRole("heading", { name: copy.emptyTitle })).toBeVisible();
    await expect(page.getByText(copy.emptyInviteHint)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await createWeddingWithCity(
      page,
      "Boda de Alejandra Montenegro y Sebastián Villalobos",
      "2027-11-20",
      "San Rafael de Escazú, San José",
    );
    await createWedding(page, "Boda de la familia Rodríguez Quesada en la playa");
    await page.goto("/app");
    await expect(page.getByTestId("wedding-card")).toHaveCount(2);
    await expect(page.getByText("20 de noviembre de 2027 · San Rafael de Escazú, San José")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const nav = headerNav(page);
    await expect(nav.getByRole("link", { name: es.app.nav.myWeddings })).toBeVisible();
    await expect(nav.getByRole("link", { name: es.app.nav.createWedding })).toBeVisible();
    await expect(page.getByRole("button", { name: es.app.nav.logout })).toBeVisible();
  });
});
