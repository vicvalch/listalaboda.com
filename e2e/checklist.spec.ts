import { expect, test, type Browser } from "@playwright/test";

import {
  addChecklistItem,
  checklistItem,
  createAccount,
  createInvite,
  createWedding,
  es,
  fillItemForm,
  initializeChecklist,
  logIn,
  progressSummary,
} from "./support/flows";

// LB-05: the checklist is the wedding's home. Every journey starts from a
// fresh account and wedding; the checklist comes only from the migrations'
// template, through the real UI.

const BUDGET = "Definir el presupuesto aproximado"; // template: 365 days before
const STYLE = "Elegir el estilo de la boda"; // template: 350 days before

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe("wedding checklist", () => {
  test("I: an owner creates the suggested checklist explicitly; it starts at 0", async ({ page }) => {
    await logIn(page, await createAccount("cl-init"));
    await createWedding(page, "Boda con lista nueva", "2027-08-14");

    // Nothing is seeded on GET: the owner sees the explicit onboarding step.
    await expect(page.getByRole("heading", { name: es.checklist.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: es.checklist.init.ownerTitle })).toBeVisible();
    await expect(page.getByTestId("checklist-item")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("checklist-item")).toHaveCount(0);

    await initializeChecklist(page);
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
    await expect(page.getByTestId("checklist-progress-percent")).toHaveText(/^0\s?%$/);
    await expect(
      page.getByRole("progressbar", { name: es.checklist.progress.label }),
    ).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByRole("button", { name: es.checklist.init.cta })).toHaveCount(0);
    // The People section (and invites) is still there, below the list.
    await expect(page.getByRole("heading", { name: es.invites.title })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
    await expect(progressSummary(page)).toHaveText("0 de 38 completados");
  });

  test("J+K: completing an item raises progress; reopening lowers it; both persist", async ({
    page,
  }) => {
    await logIn(page, await createAccount("cl-complete"));
    await createWedding(page, "Boda que avanza", "2027-08-14");
    await initializeChecklist(page);

    const row = checklistItem(page, BUDGET);
    const checkbox = row.getByRole("checkbox", { name: BUDGET });
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(row.getByTestId("checklist-item-status")).toHaveText(es.checklist.status.done);
    await expect(row.getByRole("status")).toHaveText(es.checklist.announcements.done);
    await expect(progressSummary(page)).toHaveText("1 de 38 completados");
    await expect(page.getByTestId("checklist-progress-percent")).toHaveText(/^2\s?%$/);

    await page.reload();
    await expect(checklistItem(page, BUDGET).getByRole("checkbox", { name: BUDGET })).toBeChecked();
    await expect(progressSummary(page)).toHaveText("1 de 38 completados");

    // Reopen.
    await checklistItem(page, BUDGET).getByRole("checkbox", { name: BUDGET }).click();
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-status")).toHaveText(
      es.checklist.status.pending,
    );
    await expect(progressSummary(page)).toHaveText("0 de 38 completados");
    await page.reload();
    await expect(
      checklistItem(page, BUDGET).getByRole("checkbox", { name: BUDGET }),
    ).not.toBeChecked();
    await expect(progressSummary(page)).toHaveText("0 de 38 completados");
  });

  test("L: 'No aplica' leaves the denominator, shows in its filter, and can be undone", async ({
    page,
  }) => {
    await logIn(page, await createAccount("cl-na"));
    const weddingId = await createWedding(page, "Boda sin estilo", "2027-08-14");
    await initializeChecklist(page);

    const row = checklistItem(page, STYLE);
    await row.getByRole("button", { name: `${es.checklist.actions.markNotApplicable}: ${STYLE}` }).click();
    await expect(row.getByTestId("checklist-item-status")).toHaveText(
      es.checklist.status.not_applicable,
    );
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    await expect(progressSummary(page)).toHaveText("0 de 37 completados");
    await expect(page.getByText(es.checklist.progress.notApplicableOne)).toBeVisible();

    await page.reload();
    await expect(checklistItem(page, STYLE).getByTestId("checklist-item-status")).toHaveText(
      es.checklist.status.not_applicable,
    );

    // The "No aplica" filter is a shareable URL showing only that item.
    const filters = page.getByRole("navigation", { name: es.checklist.filters.label });
    await filters.getByRole("link", { name: new RegExp(`^${es.checklist.filters.not_applicable}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?status=not_applicable$`));
    await expect(page.getByTestId("checklist-item")).toHaveCount(1);
    await expect(checklistItem(page, STYLE)).toHaveCount(1);
    await expect(
      filters.getByRole("link", { name: new RegExp(`^${es.checklist.filters.not_applicable}`) }),
    ).toHaveAttribute("aria-current", "page");

    // Back to pending from the filtered view.
    await checklistItem(page, STYLE)
      .getByRole("button", { name: `${es.checklist.actions.reopen}: ${STYLE}` })
      .click();
    await expect(page.getByText(es.checklist.empty.filtered)).toBeVisible();
    await expect(progressSummary(page)).toHaveText("0 de 38 completados");

    // An unknown filter value safely shows everything.
    await page.goto(`/app/weddings/${weddingId}?status=bogus`);
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
    await expect(
      filters.getByRole("link", { name: new RegExp(`^${es.checklist.filters.all}`) }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("M: a custom item can be added, edited, completed, and it persists", async ({ page }) => {
    await logIn(page, await createAccount("cl-custom"));
    await createWedding(page, "Boda con pendiente propio", "2027-08-14");
    await initializeChecklist(page);

    await addChecklistItem(page, {
      title: "Probar el pastel",
      category: "vendors",
      timing: { mode: "relative", days: 10, direction: "before" },
    });
    const row = checklistItem(page, "Probar el pastel");
    await expect(row.getByTestId("checklist-item-timing")).toHaveText(
      "4 de agosto de 2027 · 10 días antes de la boda",
    );
    await expect(row).toContainText(es.checklist.categories.vendors);
    await expect(progressSummary(page)).toHaveText("0 de 39 completados");
    // The add form is cleared for the next item.
    const addForm = page.getByRole("region", { name: es.checklist.form.addTitle });
    await expect(addForm.getByLabel(es.checklist.form.titleLabel, { exact: true })).toHaveValue("");

    // Edit title and switch to a specific date.
    await row.getByText(es.checklist.actions.edit, { exact: true }).click();
    await fillItemForm(row, {
      title: "Probar y elegir el pastel",
      timing: { mode: "absolute", date: "2027-05-30" },
    });
    await row.getByRole("button", { name: es.checklist.form.submitEdit }).click();
    const edited = checklistItem(page, "Probar y elegir el pastel");
    await expect(edited.getByTestId("checklist-item-timing")).toHaveText("30 de mayo de 2027");
    await expect(checklistItem(page, "Probar el pastel")).toHaveCount(0);

    await edited.getByRole("checkbox", { name: "Probar y elegir el pastel" }).click();
    await expect(progressSummary(page)).toHaveText("1 de 39 completados");

    await page.reload();
    const persisted = checklistItem(page, "Probar y elegir el pastel");
    await expect(persisted.getByRole("checkbox")).toBeChecked();
    await expect(persisted.getByTestId("checklist-item-timing")).toHaveText("30 de mayo de 2027");
  });

  test("the add form explains errors next to the field", async ({ page }) => {
    await logIn(page, await createAccount("cl-invalid"));
    await createWedding(page, "Boda con errores", "2027-08-14");
    const section = page.getByRole("region", { name: es.checklist.form.addTitle });
    await section.getByRole("radio", { name: es.checklist.form.timingRelative }).check();
    await section.getByLabel(es.checklist.form.daysLabel).fill("0");
    await section.getByRole("button", { name: es.checklist.form.submitAdd }).click();

    const title = section.getByLabel(es.checklist.form.titleLabel, { exact: true });
    await expect(title).toHaveAttribute("aria-invalid", "true");
    // Described by its hint and the error.
    await expect(title).toHaveAccessibleDescription(
      new RegExp(`${escapeRegExp(es.checklist.validation.titleRequired)}$`),
    );
    await expect(section.getByLabel(es.checklist.form.daysLabel)).toHaveAccessibleDescription(
      es.checklist.validation.daysInvalid,
    );
    await expect(page.getByTestId("checklist-item")).toHaveCount(0);
  });

  test("N: deleting an item needs a confirmation and is permanent", async ({ page }) => {
    await logIn(page, await createAccount("cl-delete"));
    await createWedding(page, "Boda que borra", "2027-08-14");
    await initializeChecklist(page);
    await addChecklistItem(page, { title: "Pendiente para borrar" });

    const row = checklistItem(page, "Pendiente para borrar");
    await row.getByText(es.checklist.actions.edit, { exact: true }).click();
    await row.getByRole("button", { name: `${es.checklist.delete.open}: Pendiente para borrar` }).click();
    // Changing one's mind keeps it.
    await row.getByRole("button", { name: es.checklist.delete.cancel }).click();
    await row.getByRole("button", { name: `${es.checklist.delete.open}: Pendiente para borrar` }).click();
    await expect(row.getByText(es.checklist.delete.confirm)).toBeVisible();
    await row.getByRole("button", { name: es.checklist.delete.confirmButton }).click();

    await expect(checklistItem(page, "Pendiente para borrar")).toHaveCount(0);
    await expect(progressSummary(page)).toHaveText("0 de 38 completados");
    await page.reload();
    await expect(checklistItem(page, "Pendiente para borrar")).toHaveCount(0);
    await expect(page.getByTestId("checklist-item")).toHaveCount(38);
  });

  test("O: a collaborator shares the checklist but not invite administration", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("cl-owner"));
    const weddingId = await createWedding(owner.page, "Boda compartida", "2027-08-14");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    // The collaborator joins before the list exists: a safe waiting state.
    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("cl-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}`));
    await expect(collab.page.getByText(es.checklist.init.collaboratorTitle)).toBeVisible();
    await expect(collab.page.getByRole("button", { name: es.checklist.init.cta })).toHaveCount(0);

    await initializeChecklist(owner.page);

    await collab.page.reload();
    await expect(collab.page.getByTestId("checklist-item")).toHaveCount(38);
    await checklistItem(collab.page, BUDGET).getByRole("checkbox", { name: BUDGET }).click();
    await expect(progressSummary(collab.page)).toHaveText("1 de 38 completados");
    await addChecklistItem(collab.page, { title: "Buscar el regalo para los padrinos" });
    await expect(progressSummary(collab.page)).toHaveText("1 de 39 completados");

    // Shared planning yes; membership administration no.
    await expect(collab.page.getByRole("heading", { name: es.invites.title })).toHaveCount(0);
    await expect(collab.page.getByText(es.invites.collaboratorNote)).toBeVisible();

    // The owner sees the collaborator's work.
    await owner.page.reload();
    await expect(
      checklistItem(owner.page, BUDGET).getByRole("checkbox", { name: BUDGET }),
    ).toBeChecked();
    await expect(checklistItem(owner.page, "Buscar el regalo para los padrinos")).toHaveCount(1);
    await expect(progressSummary(owner.page)).toHaveText("1 de 39 completados");

    await owner.context.close();
    await collab.context.close();
  });

  test("P: an outsider gets a 404 and no checklist content", async ({ browser }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("cl-private"));
    const weddingId = await createWedding(owner.page, "Boda con lista privada", "2027-08-14");
    await initializeChecklist(owner.page);
    await addChecklistItem(owner.page, { title: "Secreto de la boda privada" });

    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("cl-outsider"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByRole("heading", { name: es.notFound.title })).toBeVisible();
    await expect(outsider.page.getByText("Secreto de la boda privada")).toHaveCount(0);
    await expect(outsider.page.getByText(BUDGET)).toHaveCount(0);
    await expect(outsider.page.getByTestId("checklist-item")).toHaveCount(0);

    // A filter parameter doesn't change that.
    const filtered = await outsider.page.goto(`/app/weddings/${weddingId}?status=done`);
    expect(filtered?.status()).toBe(404);

    await owner.context.close();
    await outsider.context.close();
  });

  test("Q: relative items show the date computed from the wedding date", async ({ page }) => {
    await logIn(page, await createAccount("cl-dates"));
    await createWedding(page, "Boda con fechas", "2027-08-14");
    await initializeChecklist(page);

    // 2027-08-14 − 365 days = 2026-08-14; − 350 days = 2026-08-29.
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-timing")).toHaveText(
      "14 de agosto de 2026 · 365 días antes de la boda",
    );
    await expect(checklistItem(page, STYLE).getByTestId("checklist-item-timing")).toHaveText(
      "29 de agosto de 2026 · 350 días antes de la boda",
    );
    // "Lo próximo" lists the soonest pending dated items.
    const nextUp = page.getByRole("region", { name: es.checklist.nextUp.title });
    await expect(nextUp.getByRole("listitem").first()).toContainText(BUDGET);
    await expect(nextUp.getByRole("listitem").first()).toContainText("14 de agosto de 2026");
  });

  test("Q: without a wedding date, relative items keep their rule and wait for the date", async ({
    page,
  }) => {
    await logIn(page, await createAccount("cl-nodate"));
    await createWedding(page, "Boda sin fecha todavía");
    await initializeChecklist(page);
    await expect(checklistItem(page, BUDGET).getByTestId("checklist-item-timing")).toHaveText(
      `365 días antes de la boda · ${es.checklist.timing.pendingDate}`,
    );
    await expect(page.getByRole("region", { name: es.checklist.nextUp.title })).toHaveCount(0);
  });
});
