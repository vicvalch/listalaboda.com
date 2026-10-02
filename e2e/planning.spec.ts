import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  addChecklistItem,
  checklistItem,
  createAccount,
  createInvite,
  createWedding,
  es,
  initializeChecklist,
  logIn,
  progressSummary,
} from "./support/flows";

// LB-06: planning views, wedding settings and date recalculation. Every
// journey starts from a fresh account and wedding; assertions use a small
// known subset of the template (default-wedding-es v1), not all 38 items.

const BUDGET = "Definir el presupuesto aproximado"; // −365 days, sort 10
const ESTIMATE = "Estimar cuántas personas invitar"; // −360 days, sort 20
const STYLE = "Elegir el estilo de la boda"; // −350 days, sort 30
const RESEARCH = "Buscar y visitar lugares"; // −330 days, sort 50
const CEREMONY = "Reservar el lugar de la ceremonia"; // −300 days, sort 60

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function timing(page: Page, title: string) {
  return checklistItem(page, title).getByTestId("checklist-item-timing");
}

function nextUpTitles(page: Page) {
  return page
    .getByRole("region", { name: es.checklist.nextUp.title })
    .getByTestId("next-up-items")
    .getByRole("link");
}

function viewNav(page: Page) {
  return page.getByRole("navigation", { name: es.checklist.views.label });
}

function filterNav(page: Page) {
  return page.getByRole("navigation", { name: es.checklist.filters.label });
}

function filterLink(page: Page, label: string) {
  return filterNav(page).getByRole("link", { name: new RegExp(`^${label}`) });
}

async function openSettings(page: Page, weddingId: string) {
  await page.getByRole("link", { name: es.wedding.settingsLink }).click();
  await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/settings$`));
  await expect(page.getByRole("heading", { level: 1, name: es.weddingSettings.title })).toBeVisible();
}

async function saveSettings(page: Page, weddingId: string) {
  await page.getByRole("button", { name: es.weddingSettings.submit }).click();
  await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?saved=settings$`));
  await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
}

test.describe("wedding settings and date recalculation", () => {
  test("R: moving the wedding date moves relative items; specific dates stay", async ({ page }) => {
    await logIn(page, await createAccount("pl-move"));
    const weddingId = await createWedding(page, "Boda que cambia de fecha", "2027-08-14");
    await initializeChecklist(page);
    await addChecklistItem(page, {
      title: "Pagar el anticipo del salón",
      timing: { mode: "absolute", date: "2027-03-01" },
    });

    await expect(timing(page, BUDGET)).toHaveText("14 de agosto de 2026 · 365 días antes de la boda");
    await expect(timing(page, "Pagar el anticipo del salón")).toHaveText("1 de marzo de 2027");

    await openSettings(page, weddingId);
    const name = page.getByLabel(es.weddingSettings.nameLabel);
    const date = page.getByLabel(es.weddingSettings.dateLabel);
    await expect(name).toHaveValue("Boda que cambia de fecha");
    await expect(date).toHaveValue("2027-08-14");

    // Validation keeps the user on the form.
    await name.fill("   ");
    await page.getByRole("button", { name: es.weddingSettings.submit }).click();
    await expect(name).toHaveAccessibleDescription(es.weddingNew.validation.nameRequired);

    await name.fill("  Boda con nueva fecha  ");
    await date.fill("2027-10-02");
    await saveSettings(page, weddingId);

    await expect(page.getByRole("heading", { level: 1, name: "Boda con nueva fecha" })).toBeVisible();
    await expect(page.getByText("2 de octubre de 2027", { exact: true })).toBeVisible();
    // 2027-10-02 − 365 days = 2026-10-02: derived from the new date.
    await expect(timing(page, BUDGET)).toHaveText("2 de octubre de 2026 · 365 días antes de la boda");
    await expect(timing(page, "Pagar el anticipo del salón")).toHaveText("1 de marzo de 2027");

    await page.reload();
    await expect(timing(page, BUDGET)).toHaveText("2 de octubre de 2026 · 365 días antes de la boda");
    await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await expect(page.getByTestId("checklist-item")).toHaveCount(39);
  });

  test("S: clearing the wedding date keeps relative rules and drops only the exact date", async ({
    page,
  }) => {
    await logIn(page, await createAccount("pl-clear"));
    const weddingId = await createWedding(page, "Boda que pierde la fecha", "2027-08-14");
    await initializeChecklist(page);
    await expect(timing(page, BUDGET)).toHaveText("14 de agosto de 2026 · 365 días antes de la boda");
    await expect(page.getByTestId("checklist-no-date")).toHaveCount(0);

    await openSettings(page, weddingId);
    await page.getByLabel(es.weddingSettings.dateLabel).fill("");
    await saveSettings(page, weddingId);

    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
    await expect(timing(page, BUDGET)).toHaveText(
      `365 días antes de la boda · ${es.checklist.timing.pendingDate}`,
    );
    await expect(timing(page, BUDGET)).not.toContainText("2026");
    // The owner gets a non-blocking hint with a way to set the date.
    const callout = page.getByTestId("checklist-no-date");
    await expect(callout).toContainText(es.checklist.noDate.owner);
    await expect(callout.getByRole("link", { name: es.checklist.noDate.ownerCta })).toHaveAttribute(
      "href",
      `/app/weddings/${weddingId}/settings`,
    );
    // "Lo próximo" still orders by the rules.
    await expect(nextUpTitles(page).first()).toHaveText(BUDGET);

    await openSettings(page, weddingId);
    await expect(page.getByLabel(es.weddingSettings.dateLabel)).toHaveValue("");
  });

  test("T: a collaborator edits the checklist but can't change wedding settings, even directly", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("pl-owner"));
    const weddingId = await createWedding(owner.page, "Boda con ajustes protegidos", "2027-08-14");
    const settingsPath = `/app/weddings/${weddingId}/settings`;
    const inviteUrl = await createInvite(owner.page, "collaborator");
    await initializeChecklist(owner.page);

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("pl-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}`));

    // Shared checklist: yes.
    await addChecklistItem(collab.page, { title: "Comprar los recuerdos" });
    await checklistItem(collab.page, BUDGET).getByRole("checkbox", { name: BUDGET }).click();
    await expect(progressSummary(collab.page)).toHaveText("1 de 39 completados");

    // Settings: no link, and the page explains instead of showing a form.
    await expect(collab.page.getByRole("link", { name: es.wedding.settingsLink })).toHaveCount(0);
    await collab.page.goto(settingsPath);
    await expect(collab.page.getByText(es.weddingSettings.ownerOnly)).toBeVisible();
    await expect(collab.page.getByLabel(es.weddingSettings.nameLabel)).toHaveCount(0);

    // Server-side denial: replay the owner's real settings form submission
    // (the Server Action's own form fields) with the collaborator's session.
    await owner.page.goto(settingsPath);
    const fields = await owner.page
      .locator("form")
      .filter({ has: owner.page.getByLabel(es.weddingSettings.nameLabel) })
      .evaluate((form) =>
        Array.from(new FormData(form as HTMLFormElement).entries()).map(
          ([key, value]) => [key, String(value)] as const,
        ),
      );
    const submission = (name: string) =>
      Object.fromEntries(fields.map(([key, value]) => [key, key === "name" ? name : value]));
    const origin = new URL(owner.page.url()).origin;

    await collab.context.request.post(settingsPath, {
      multipart: submission("Boda tomada por colaborador"),
      headers: { Origin: origin },
    });
    await owner.page.goto(`/app/weddings/${weddingId}`);
    await expect(
      owner.page.getByRole("heading", { level: 1, name: "Boda con ajustes protegidos" }),
    ).toBeVisible();

    // Control: the same replay with the owner's session does save, so the
    // denial above came from the server's role check, not a broken request.
    await owner.context.request.post(settingsPath, {
      multipart: submission("Boda renombrada por quien organiza"),
      headers: { Origin: origin },
    });
    await owner.page.reload();
    await expect(
      owner.page.getByRole("heading", { level: 1, name: "Boda renombrada por quien organiza" }),
    ).toBeVisible();
    await collab.page.goto(`/app/weddings/${weddingId}`);
    await expect(
      collab.page.getByRole("heading", { level: 1, name: "Boda renombrada por quien organiza" }),
    ).toBeVisible();

    await owner.context.close();
    await collab.context.close();
  });

  test("an outsider gets a 404 for wedding settings", async ({ browser }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("pl-private"));
    const weddingId = await createWedding(owner.page, "Boda con ajustes privados", "2027-08-14");

    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("pl-outsider"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}/settings`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByText("Boda con ajustes privados")).toHaveCount(0);

    await owner.context.close();
    await outsider.context.close();
  });
});

test.describe("planning views", () => {
  test("U: Plan orders by date without touching the list's own order", async ({ page }) => {
    await logIn(page, await createAccount("pl-plan"));
    const weddingId = await createWedding(page, "Boda con plan", "2027-08-14");
    await initializeChecklist(page);
    const CUSTOM = "Reservar la prueba de menú";
    await addChecklistItem(page, { title: CUSTOM, timing: { mode: "absolute", date: "2026-06-01" } });

    // Lista: persisted order; the custom item stays last.
    const rows = page.getByTestId("checklist-item");
    await expect(rows.first()).toContainText(BUDGET);
    await expect(rows.last()).toContainText(CUSTOM);

    // "Lo próximo": the 5 earliest pending items, the custom one first.
    await expect(nextUpTitles(page)).toHaveText([CUSTOM, BUDGET, ESTIMATE, STYLE, RESEARCH]);

    await viewNav(page).getByRole("link", { name: es.checklist.views.plan }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?view=plan$`));
    await expect(viewNav(page).getByRole("link", { name: es.checklist.views.plan })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const planRows = page.getByTestId("checklist-item");
    await expect(planRows.nth(0)).toContainText(CUSTOM);
    await expect(planRows.nth(1)).toContainText(BUDGET);
    await expect(planRows.nth(2)).toContainText(ESTIMATE);
    await expect(planRows.nth(3)).toContainText(STYLE);

    // Done leaves "Lo próximo"; same-day items keep list order (−300: ceremony before reception).
    await checklistItem(page, CUSTOM).getByRole("checkbox", { name: CUSTOM }).click();
    await expect(nextUpTitles(page)).toHaveText([BUDGET, ESTIMATE, STYLE, RESEARCH, CEREMONY]);
    await expect(page.getByTestId("checklist-item").first()).toContainText(BUDGET);

    // Finished items sit in a secondary section of the plan; reopening brings it back.
    await page.getByText(es.checklist.plan.resolvedTitle.replace("{count}", "1")).click();
    await checklistItem(page, CUSTOM).getByRole("checkbox", { name: CUSTOM }).click();
    await expect(nextUpTitles(page)).toHaveText([CUSTOM, BUDGET, ESTIMATE, STYLE, RESEARCH]);

    // Viewing the plan wrote no order: the list is unchanged.
    await page.goto(`/app/weddings/${weddingId}`);
    await expect(page.getByTestId("checklist-item").first()).toContainText(BUDGET);
    await expect(page.getByTestId("checklist-item").last()).toContainText(CUSTOM);
  });

  test("V: Por categoría groups items and shows each category's progress", async ({ page }) => {
    await logIn(page, await createAccount("pl-category"));
    const weddingId = await createWedding(page, "Boda por categorías", "2027-08-14");
    await initializeChecklist(page);
    await addChecklistItem(page, { title: "Pendiente suelto" });

    await page.goto(`/app/weddings/${weddingId}?view=category`);
    const groups = page.getByTestId("category-group");
    await expect(groups).toHaveCount(10);
    await expect(groups.first()).toHaveAttribute("data-category", "first_steps");
    await expect(groups.nth(8)).toHaveAttribute("data-category", "after_wedding");
    await expect(groups.last()).toHaveAttribute("data-category", "none");
    await expect(
      groups.last().getByRole("heading", { name: es.checklist.form.categoryNone }),
    ).toBeVisible();

    const firstSteps = page.getByRole("region", { name: es.checklist.categories.first_steps });
    await expect(firstSteps.getByTestId("category-progress")).toHaveText("0 de 4 completados");

    await checklistItem(page, BUDGET).getByRole("checkbox", { name: BUDGET }).click();
    await expect(firstSteps.getByTestId("category-progress")).toHaveText("1 de 4 completados");
    await expect(progressSummary(page)).toHaveText("1 de 39 completados");

    // Not applicable leaves the category's denominator.
    await checklistItem(page, STYLE)
      .getByRole("button", { name: `${es.checklist.actions.markNotApplicable}: ${STYLE}` })
      .click();
    await expect(firstSteps.getByTestId("category-progress")).toHaveText("1 de 3 completados");

    // A category where nothing applies shows no misleading 100%.
    const after = page.getByRole("region", { name: es.checklist.categories.after_wedding });
    for (const title of ["Devolver lo alquilado", "Enviar agradecimientos"]) {
      await checklistItem(page, title)
        .getByRole("button", { name: `${es.checklist.actions.markNotApplicable}: ${title}` })
        .click();
      await expect(checklistItem(page, title).getByTestId("checklist-item-status")).toHaveText(
        es.checklist.status.not_applicable,
      );
    }
    await expect(after.getByTestId("category-progress")).toHaveText(
      es.checklist.categoryProgress.noneApplicable,
    );
    await expect(after.getByRole("progressbar")).toHaveCount(0);
  });

  test("W: view and status live in the URL, preserve each other and fall back safely", async ({
    page,
  }) => {
    await logIn(page, await createAccount("pl-url"));
    const weddingId = await createWedding(page, "Boda con filtros", "2027-08-14");
    await initializeChecklist(page);
    const base = `/app/weddings/${weddingId}`;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    await page.goto(`${base}?view=plan&status=pending`);
    await expect(filterLink(page, es.checklist.filters.pending)).toHaveAttribute("aria-current", "page");
    await expect(viewNav(page).getByRole("link", { name: es.checklist.views.plan })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);

    // Switching the view keeps the status…
    await viewNav(page).getByRole("link", { name: es.checklist.views.category }).click();
    await expect(page).toHaveURL(new RegExp(`${escaped}\\?view=category&status=pending$`));
    await viewNav(page).getByRole("link", { name: es.checklist.views.list }).click();
    await expect(page).toHaveURL(new RegExp(`${escaped}\\?status=pending$`));
    // …and switching the status keeps the view.
    await page.goto(`${base}?view=plan`);
    await filterLink(page, es.checklist.filters.done).click();
    await expect(page).toHaveURL(new RegExp(`${escaped}\\?view=plan&status=done$`));
    await expect(page.getByText(es.checklist.empty.filtered)).toBeVisible();
    await filterLink(page, es.checklist.filters.all).click();
    await expect(page).toHaveURL(new RegExp(`${escaped}\\?view=plan$`));

    // Unknown values fall back to the plain list.
    const response = await page.goto(`${base}?view=calendar&status=overdue`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
    await expect(viewNav(page).getByRole("link", { name: es.checklist.views.list })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(filterLink(page, es.checklist.filters.all)).toHaveAttribute("aria-current", "page");
  });

  test("X: all done and nothing applicable are calm, explicit states", async ({ page }) => {
    await logIn(page, await createAccount("pl-states"));
    await createWedding(page, "Boda pequeña", "2027-08-14");
    await addChecklistItem(page, { title: "Firmar en el registro civil" });
    const row = checklistItem(page, "Firmar en el registro civil");

    await row.getByRole("checkbox", { name: "Firmar en el registro civil" }).click();
    await expect(progressSummary(page)).toHaveText("1 de 1 completados");
    await expect(page.getByTestId("next-up-empty")).toHaveText(es.checklist.nextUp.allDone);
    // The finished item is still on the list.
    await expect(page.getByTestId("checklist-item")).toHaveCount(1);

    await row.getByRole("checkbox", { name: "Firmar en el registro civil" }).click();
    await expect(progressSummary(page)).toHaveText("0 de 1 completados");
    await row
      .getByRole("button", {
        name: `${es.checklist.actions.markNotApplicable}: Firmar en el registro civil`,
      })
      .click();
    await expect(progressSummary(page)).toHaveText(es.checklist.progress.noneApplicable);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByTestId("next-up-empty")).toHaveText(es.checklist.nextUp.noneApplicable);
  });
});
