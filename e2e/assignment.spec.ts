import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  checklistItem,
  createAccount,
  createInvite,
  createWedding,
  es,
  initializeChecklist,
  logIn,
} from "./support/flows";

// LB-07: who is responsible for each item, and "Mis pendientes". Every
// journey starts from fresh accounts and a fresh wedding, and uses a few
// known items of the template (default-wedding-es v1).

const BUDGET = "Definir el presupuesto aproximado"; // −365 days, sort 10
const ESTIMATE = "Estimar cuántas personas invitar"; // −360 days, sort 20
const STYLE = "Elegir el estilo de la boda"; // −350 days, sort 30

const assignmentCopy = es.checklist.assignment;

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function assignee(page: Page, title: string) {
  return checklistItem(page, title).getByTestId("checklist-item-assignee");
}

/** Opens "Asignar" on a row, picks `option` (its visible label) and saves. */
async function assignTo(page: Page, title: string, option: string) {
  const row = checklistItem(page, title);
  const summary = row.getByText(assignmentCopy.open, { exact: true });
  if (!(await row.getByLabel(assignmentCopy.selectLabel).isVisible())) await summary.click();
  await row.getByLabel(assignmentCopy.selectLabel).selectOption({ label: option });
  await row.getByRole("button", { name: assignmentCopy.submit }).click();
  await expect(row.getByRole("status").filter({ hasText: assignmentCopy.saved })).toBeVisible();
}

function viewLink(page: Page, label: string) {
  return page
    .getByRole("navigation", { name: es.checklist.views.label })
    .getByRole("link", { name: new RegExp(`^${label}`) });
}

function rowTitles(page: Page) {
  return page.getByTestId("checklist-item").locator("p[id$='-title']");
}

/** Owner + collaborator in one wedding; the collaborator joined through a real invite. */
async function sharedWedding(browser: Browser, label: string) {
  const owner = await freshPage(browser);
  await logIn(owner.page, await createAccount(`${label}-owner`));
  const weddingId = await createWedding(owner.page, `Boda ${label}`, "2027-08-14");
  await initializeChecklist(owner.page);
  const inviteUrl = await createInvite(owner.page, "collaborator");

  const collab = await freshPage(browser);
  await logIn(collab.page, await createAccount(`${label}-collab`));
  await collab.page.goto(inviteUrl);
  await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
  await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
  return { owner, collab, weddingId, base: `/app/weddings/${weddingId}` };
}

async function setDisplayName(page: Page, name: string) {
  const section = page.getByRole("region", { name: es.members.displayName.title });
  await section.getByLabel(es.members.displayName.label).fill(name);
  await section.getByRole("button", { name: es.members.displayName.submit }).click();
  await expect(section.getByRole("status")).toHaveText(es.members.displayName.saved);
}

test.describe("checklist assignment", () => {
  test("AA: owner assigns an item to themselves; it persists and shows in Mis pendientes", async ({
    page,
  }) => {
    await logIn(page, await createAccount("as-self"));
    const weddingId = await createWedding(page, "Boda con responsable", "2027-08-14");
    await initializeChecklist(page);

    // Starter items are unassigned.
    await expect(assignee(page, BUDGET)).toHaveText(`${assignmentCopy.label}: ${assignmentCopy.unassigned}`);
    await expect(viewLink(page, es.checklist.views.mine)).toHaveText(`${es.checklist.views.mine}(0)`);

    await assignTo(page, STYLE, es.members.you);
    await expect(assignee(page, STYLE)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);

    await page.reload();
    await expect(assignee(page, STYLE)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);
    await expect(
      checklistItem(page, STYLE).getByLabel(assignmentCopy.selectLabel),
    ).toHaveValue(/[0-9a-f-]{36}/);
    await expect(viewLink(page, es.checklist.views.mine)).toHaveText(`${es.checklist.views.mine}(1)`);

    await viewLink(page, es.checklist.views.mine).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?view=mine$`));
    await expect(page.getByTestId("checklist-view-hint")).toHaveText(es.checklist.views.hint.mine);
    await expect(rowTitles(page)).toHaveText([STYLE]);
  });

  test("AB: status and assignment are independent (done, reopen, no aplica)", async ({ page }) => {
    await logIn(page, await createAccount("as-status"));
    const weddingId = await createWedding(page, "Boda independiente", "2027-08-14");
    await initializeChecklist(page);
    await assignTo(page, BUDGET, es.members.you);

    const row = checklistItem(page, BUDGET);
    await row.getByRole("checkbox", { name: BUDGET }).click();
    await expect(row).toHaveAttribute("data-status", "done");
    await expect(assignee(page, BUDGET)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);

    // Done items stay in Mis pendientes (under "Todos", in the resolved section)…
    await page.goto(`/app/weddings/${weddingId}?view=mine&status=done`);
    await expect(rowTitles(page)).toHaveText([BUDGET]);
    // …but not under "Pendientes", and the badge counts pending only.
    await page.goto(`/app/weddings/${weddingId}?view=mine&status=pending`);
    await expect(page.getByText(es.checklist.empty.filtered)).toBeVisible();
    await expect(viewLink(page, es.checklist.views.mine)).toHaveText(`${es.checklist.views.mine}(0)`);

    await page.goto(`/app/weddings/${weddingId}`);
    await checklistItem(page, BUDGET).getByRole("checkbox", { name: BUDGET }).click();
    await expect(checklistItem(page, BUDGET)).toHaveAttribute("data-status", "pending");
    await expect(assignee(page, BUDGET)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);

    await checklistItem(page, BUDGET)
      .getByRole("button", { name: `${es.checklist.actions.markNotApplicable}: ${BUDGET}` })
      .click();
    await expect(checklistItem(page, BUDGET)).toHaveAttribute("data-status", "not_applicable");
    await page.reload();
    await expect(assignee(page, BUDGET)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);
  });

  test("AC: a collaborator names themselves; the owner assigns to them; it lands in their Mis pendientes", async ({
    browser,
  }) => {
    const { owner, collab, base } = await sharedWedding(browser, "as-collab");

    // Before naming: the owner sees a neutral role label, never an email or id.
    await owner.page.reload();
    const members = owner.page.getByTestId("wedding-members");
    await expect(members.getByRole("listitem")).toHaveText([
      `${es.members.you} · ${es.roles.owner.label}`,
      `${es.members.fallback.collaborator} · ${es.roles.collaborator.label}`,
    ]);
    await expect(members).not.toContainText("@");

    await setDisplayName(collab.page, "Sofía");
    await collab.page.reload();
    await expect(collab.page.getByLabel(es.members.displayName.label)).toHaveValue("Sofía");
    await expect(collab.page.getByTestId("display-name-current")).toContainText("Sofía");

    await owner.page.reload();
    await expect(members.getByRole("listitem").nth(1)).toHaveText(
      `Sofía · ${es.roles.collaborator.label}`,
    );
    await assignTo(owner.page, ESTIMATE, "Sofía");
    await expect(assignee(owner.page, ESTIMATE)).toHaveText(`${assignmentCopy.label}: Sofía`);
    // The owner has nothing assigned.
    await owner.page.goto(`${base}?view=mine`);
    await expect(owner.page.getByTestId("mine-empty")).toContainText(es.checklist.mine.empty);

    // The collaborator sees it as theirs.
    await collab.page.goto(`${base}?view=mine&status=pending`);
    await expect(rowTitles(collab.page)).toHaveText([ESTIMATE]);
    await expect(assignee(collab.page, ESTIMATE)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);

    await owner.context.close();
    await collab.context.close();
  });

  test("AD: a collaborator reassigns and unassigns; Mis pendientes follows", async ({ browser }) => {
    const { owner, collab, base } = await sharedWedding(browser, "as-reassign");
    await setDisplayName(owner.page, "Victor");
    await assignTo(owner.page, BUDGET, `${es.members.you} (Victor)`);

    // The collaborator takes it over (owner → collaborator), from a shared item.
    await collab.page.goto(base);
    await expect(assignee(collab.page, BUDGET)).toHaveText(`${assignmentCopy.label}: Victor`);
    await assignTo(collab.page, BUDGET, es.members.you);
    // …and gives another one to the owner.
    await assignTo(collab.page, STYLE, "Victor");
    await collab.page.reload();
    await expect(assignee(collab.page, BUDGET)).toHaveText(`${assignmentCopy.label}: ${es.members.you}`);
    await expect(assignee(collab.page, STYLE)).toHaveText(`${assignmentCopy.label}: Victor`);

    // Each one's Mis pendientes shows only their own items.
    await collab.page.goto(`${base}?view=mine`);
    await expect(rowTitles(collab.page)).toHaveText([BUDGET]);
    await owner.page.goto(`${base}?view=mine`);
    await expect(rowTitles(owner.page)).toHaveText([STYLE]);

    // Unassign: back to "Sin asignar", out of the former assignee's list.
    await collab.page.goto(base);
    await assignTo(collab.page, STYLE, assignmentCopy.unassigned);
    await expect(assignee(collab.page, STYLE)).toHaveText(
      `${assignmentCopy.label}: ${assignmentCopy.unassigned}`,
    );
    await owner.page.reload();
    await expect(owner.page.getByTestId("mine-empty")).toBeVisible();
    await owner.page.goto(base);
    await expect(assignee(owner.page, STYLE)).toHaveText(
      `${assignmentCopy.label}: ${assignmentCopy.unassigned}`,
    );

    await owner.context.close();
    await collab.context.close();
  });

  test("AE: Mis pendientes URL state; ordering; nothing of someone else's; safe fallbacks", async ({
    browser,
  }) => {
    const { owner, collab, base, weddingId } = await sharedWedding(browser, "as-url");
    // Persisted order: BUDGET (10), ESTIMATE (20), STYLE (30). Assign in
    // reverse, then check the view uses planning order, not assignment order.
    await assignTo(owner.page, STYLE, es.members.you);
    await assignTo(owner.page, BUDGET, es.members.you);
    await assignTo(owner.page, ESTIMATE, es.members.fallback.collaborator);

    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await owner.page.goto(`${base}?view=mine&status=pending`);
    await expect(viewLink(owner.page, es.checklist.views.mine)).toHaveAttribute("aria-current", "page");
    await expect(rowTitles(owner.page)).toHaveText([BUDGET, STYLE]);

    // Switching status keeps "mine"; switching view keeps the status.
    await owner.page
      .getByRole("navigation", { name: es.checklist.filters.label })
      .getByRole("link", { name: new RegExp(`^${es.checklist.filters.all}`) })
      .click();
    await expect(owner.page).toHaveURL(new RegExp(`${escaped}\\?view=mine$`));
    await owner.page.goto(`${base}?view=mine&status=pending`);
    await viewLink(owner.page, es.checklist.views.plan).click();
    await expect(owner.page).toHaveURL(new RegExp(`${escaped}\\?view=plan&status=pending$`));

    // Lo próximo stays the whole wedding's, even inside Mis pendientes.
    await owner.page.goto(`${base}?view=mine`);
    await expect(
      owner.page.getByRole("region", { name: es.checklist.nextUp.title }).getByRole("link"),
    ).toContainText([BUDGET, ESTIMATE, STYLE]);

    // The collaborator sees only what is theirs.
    await collab.page.goto(`${base}?view=mine`);
    await expect(rowTitles(collab.page)).toHaveText([ESTIMATE]);

    // Unknown views fall back to the list.
    const response = await owner.page.goto(`/app/weddings/${weddingId}?view=mio&status=pending`);
    expect(response?.status()).toBe(200);
    await expect(viewLink(owner.page, es.checklist.views.list)).toHaveAttribute("aria-current", "page");
    await expect(owner.page.getByTestId("checklist-item")).toHaveCount(38);

    await owner.context.close();
    await collab.context.close();
  });

  test("AF: an outsider can't see the wedding, its members or its assignments", async ({
    browser,
  }) => {
    const { owner, base } = await sharedWedding(browser, "as-outsider");
    await assignTo(owner.page, BUDGET, es.members.you);

    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("as-outsider-x"));
    const response = await outsider.page.goto(`${base}?view=mine`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByText(BUDGET)).toHaveCount(0);
    await expect(outsider.page.getByTestId("wedding-members")).toHaveCount(0);

    await owner.context.close();
    await outsider.context.close();
  });
});
