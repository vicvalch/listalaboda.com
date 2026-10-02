import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  addChecklistItem,
  checklistItem,
  createAccount,
  createInvite,
  createWedding,
  es,
  formAlert,
  logIn,
} from "./support/flows";

// LB-08: wedding city and time zone, "Atrasado", and owner-only member
// removal. Dates are absolute and far from "today" (2020 / 2090), so no
// journey depends on the machine's time zone or the time of day. The exact
// due-today boundary is covered by unit tests with fixed instants.

const PAST = "2020-01-15"; // overdue in any time zone
const FUTURE = "2090-06-01";

const settingsCopy = es.weddingSettings;
const newCopy = es.weddingNew;
const overdueCopy = es.checklist.overdue;
const removeCopy = es.members.remove;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function timeZoneSelect(page: Page) {
  return page.getByLabel(newCopy.timeZoneLabel);
}

async function openSettings(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/settings`);
  await expect(page.getByRole("heading", { level: 1, name: settingsCopy.title })).toBeVisible();
}

async function saveSettings(page: Page) {
  await page.getByRole("button", { name: settingsCopy.submit }).click();
}

/** Owner + collaborator in one wedding; the collaborator joined through a real invite. */
async function sharedWedding(browser: Browser, label: string) {
  const owner = await freshPage(browser);
  await logIn(owner.page, await createAccount(`${label}-owner`));
  const weddingId = await createWedding(owner.page, `Boda ${label}`, "2027-08-14");
  const inviteUrl = await createInvite(owner.page, "collaborator");

  const collab = await freshPage(browser);
  await logIn(collab.page, await createAccount(`${label}-collab`));
  await collab.page.goto(inviteUrl);
  await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
  await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
  return { owner, collab, weddingId, base: `/app/weddings/${weddingId}` };
}

test.describe("wedding city and time zone", () => {
  test("LA: create a wedding with date, city and time zone; everything persists", async ({ page }) => {
    await logIn(page, await createAccount("lb8-create"));
    await page.goto("/app/weddings/new");
    await page.getByLabel(newCopy.nameLabel).fill("Boda de Ana y Luis");
    await page.getByLabel(newCopy.dateLabel).fill("2027-08-14");
    await page.getByLabel(newCopy.cityLabel).fill("  San José ");
    // Optional and empty by default: nothing is chosen silently.
    await expect(timeZoneSelect(page)).toHaveValue("");
    await expect(timeZoneSelect(page)).toHaveAccessibleDescription(newCopy.timeZoneHint);
    await timeZoneSelect(page).selectOption("America/Costa_Rica");
    await page.getByRole("button", { name: newCopy.submit }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Boda de Ana y Luis" })).toBeVisible();
    await expect(page.getByTestId("wedding-city")).toHaveText("San José");
    const weddingId = /\/app\/weddings\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    expect(weddingId).toBeTruthy();

    await page.reload();
    await expect(page.getByTestId("wedding-city")).toHaveText("San José");
    await openSettings(page, weddingId!);
    await expect(page.getByLabel(settingsCopy.cityLabel)).toHaveValue("San José");
    await expect(timeZoneSelect(page)).toHaveValue("America/Costa_Rica");
  });

  test("LB: a wedding without city or time zone shows no city clutter", async ({ page }) => {
    await logIn(page, await createAccount("lb8-plain"));
    const weddingId = await createWedding(page, "Boda sin ciudad");
    await expect(page.getByTestId("wedding-city")).toHaveCount(0);
    await openSettings(page, weddingId);
    await expect(page.getByLabel(settingsCopy.cityLabel)).toHaveValue("");
    await expect(timeZoneSelect(page)).toHaveValue("");
  });

  test("LC: the owner changes and clears the city; the collaborator can't change it", async ({
    browser,
  }) => {
    const { owner, collab, weddingId, base } = await sharedWedding(browser, "lb8-city");

    await openSettings(owner.page, weddingId);
    await owner.page.getByLabel(settingsCopy.cityLabel).fill("Lima");
    await saveSettings(owner.page);
    await expect(owner.page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await expect(owner.page.getByTestId("wedding-city")).toHaveText("Lima");

    await openSettings(owner.page, weddingId);
    await owner.page.getByLabel(settingsCopy.cityLabel).fill("Madrid");
    await saveSettings(owner.page);
    await expect(owner.page.getByTestId("wedding-city")).toHaveText("Madrid");

    // The collaborator sees it but gets no form.
    await collab.page.goto(base);
    await expect(collab.page.getByTestId("wedding-city")).toHaveText("Madrid");
    await collab.page.goto(`${base}/settings`);
    await expect(collab.page.getByText(settingsCopy.ownerOnly)).toBeVisible();
    await expect(collab.page.getByLabel(settingsCopy.cityLabel)).toHaveCount(0);

    await openSettings(owner.page, weddingId);
    await owner.page.getByLabel(settingsCopy.cityLabel).fill("   ");
    await saveSettings(owner.page);
    await expect(owner.page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await expect(owner.page.getByTestId("wedding-city")).toHaveCount(0);
    await openSettings(owner.page, weddingId);
    await expect(owner.page.getByLabel(settingsCopy.cityLabel)).toHaveValue("");

    await owner.context.close();
    await collab.context.close();
  });

  test("LD: the owner sets and changes the time zone; a forged invalid zone is refused", async ({
    page,
  }) => {
    await logIn(page, await createAccount("lb8-tz"));
    const weddingId = await createWedding(page, "Boda con zona horaria");

    await openSettings(page, weddingId);
    await timeZoneSelect(page).selectOption("Europe/Madrid");
    await saveSettings(page);
    await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await openSettings(page, weddingId);
    await expect(timeZoneSelect(page)).toHaveValue("Europe/Madrid");

    await timeZoneSelect(page).selectOption("Asia/Tokyo");
    await saveSettings(page);
    await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await openSettings(page, weddingId);
    await expect(timeZoneSelect(page)).toHaveValue("Asia/Tokyo");

    // A tampered form (an option the list never offers) gets a safe Spanish
    // error; the stored zone stays.
    await timeZoneSelect(page).evaluate((select: HTMLSelectElement) => {
      const option = document.createElement("option");
      option.value = "Mars/Olympus";
      option.textContent = "Mars/Olympus";
      select.append(option);
      select.value = "Mars/Olympus";
    });
    await saveSettings(page);
    await expect(page.getByText(newCopy.validation.timeZoneInvalid)).toBeVisible();
    await expect(timeZoneSelect(page)).toHaveAttribute("aria-invalid", "true");
    await openSettings(page, weddingId);
    await expect(timeZoneSelect(page)).toHaveValue("Asia/Tokyo");

    // Clearing it is allowed (optional).
    await timeZoneSelect(page).selectOption("");
    await saveSettings(page);
    await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
    await openSettings(page, weddingId);
    await expect(timeZoneSelect(page)).toHaveValue("");
  });

  test("LE: the device time zone is only a visible, editable suggestion", async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: "America/Lima" });
    const page = await context.newPage();
    await logIn(page, await createAccount("lb8-device"));
    await page.goto("/app/weddings/new");
    await expect(timeZoneSelect(page)).toHaveValue("");
    await page.getByRole("button", { name: newCopy.timeZoneUseDevice }).click();
    await expect(timeZoneSelect(page)).toHaveValue("America/Lima");
    await expect(page.getByText("America/Lima, la zona horaria de este dispositivo")).toBeVisible();
    await timeZoneSelect(page).selectOption("Europe/Madrid");
    await expect(timeZoneSelect(page)).toHaveValue("Europe/Madrid");
    await context.close();
  });
});

test.describe("overdue (atrasado)", () => {
  test("LF: a past pending item is Pendiente · Atrasado once the wedding has a time zone", async ({
    page,
  }) => {
    await logIn(page, await createAccount("lb8-overdue"));
    const weddingId = await createWedding(page, "Boda con atrasos", "2091-01-01");
    const base = `/app/weddings/${weddingId}`;
    await addChecklistItem(page, { title: "Confirmar fotógrafo", timing: { mode: "absolute", date: PAST } });
    await addChecklistItem(page, { title: "Reservar transporte", timing: { mode: "absolute", date: FUTURE } });
    await addChecklistItem(page, { title: "Entregar documentos", timing: { mode: "absolute", date: PAST } });

    // No time zone yet: nothing is overdue, and the owner is told once why.
    await expect(page.getByTestId("checklist-item-overdue")).toHaveCount(0);
    await expect(page.getByTestId("overdue-summary")).toHaveCount(0);
    await expect(page.getByTestId("checklist-no-time-zone")).toHaveCount(1);
    await expect(page.getByTestId("checklist-no-time-zone")).toContainText(
      es.checklist.noTimeZone.owner,
    );
    await page.getByRole("link", { name: es.checklist.noTimeZone.ownerCta }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/settings$`));
    await timeZoneSelect(page).selectOption("America/Costa_Rica");
    await saveSettings(page);
    await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();

    // Marked with text, still "Pendiente"; the future item is not.
    const photographer = checklistItem(page, "Confirmar fotógrafo");
    await expect(photographer.getByTestId("checklist-item-status")).toHaveText(es.checklist.status.pending);
    await expect(photographer.getByTestId("checklist-item-overdue")).toHaveText(overdueCopy.badge);
    await expect(
      checklistItem(page, "Reservar transporte").getByTestId("checklist-item-overdue"),
    ).toHaveCount(0);
    await expect(page.getByTestId("checklist-no-time-zone")).toHaveCount(0);

    // Summary: count and the overdue items; Lo próximo doesn't repeat them.
    const summary = page.getByRole("region", { name: new RegExp(`^${overdueCopy.title}`) });
    await expect(summary.getByTestId("overdue-count")).toHaveText("2");
    await expect(summary.getByTestId("overdue-items").getByRole("link")).toHaveText([
      "Confirmar fotógrafo",
      "Entregar documentos",
    ]);
    const nextUp = page.getByTestId("next-up-items").getByRole("link");
    await expect(nextUp).toHaveText(["Reservar transporte"]);

    // List keeps persisted order (marker only).
    await expect(page.getByTestId("checklist-item").locator("p[id$='-title']")).toHaveText([
      "Confirmar fotógrafo",
      "Reservar transporte",
      "Entregar documentos",
    ]);

    // Plan: Atrasados first, then what's next.
    await page.goto(`${base}?view=plan`);
    await expect(page.getByTestId("plan-overdue").getByTestId("checklist-item")).toHaveCount(2);
    await expect(page.getByTestId("plan-upcoming").getByTestId("checklist-item")).toHaveCount(1);

    // Done is never overdue.
    await page.goto(base);
    await photographer.getByRole("checkbox").click();
    await expect(photographer).toHaveAttribute("data-status", "done");
    await expect(photographer.getByTestId("checklist-item-overdue")).toHaveCount(0);
    await expect(summary.getByTestId("overdue-count")).toHaveText("1");
  });

  test("LG: the collaborator sees the same markers and neutral copy without a time zone", async ({
    browser,
  }) => {
    const { owner, collab, weddingId, base } = await sharedWedding(browser, "lb8-overdue-collab");
    await addChecklistItem(owner.page, { title: "Pagar el anticipo", timing: { mode: "absolute", date: PAST } });

    await collab.page.goto(base);
    await expect(collab.page.getByTestId("checklist-no-time-zone")).toHaveText(
      es.checklist.noTimeZone.collaborator,
    );
    await expect(collab.page.getByRole("link", { name: es.checklist.noTimeZone.ownerCta })).toHaveCount(0);

    await openSettings(owner.page, weddingId);
    await timeZoneSelect(owner.page).selectOption("Europe/Madrid");
    await saveSettings(owner.page);
    await expect(owner.page.getByText(es.wedding.settingsSaved)).toBeVisible();

    await collab.page.reload();
    await expect(
      checklistItem(collab.page, "Pagar el anticipo").getByTestId("checklist-item-overdue"),
    ).toHaveText(overdueCopy.badge);

    await owner.context.close();
    await collab.context.close();
  });
});

test.describe("member removal", () => {
  test("LH: the owner removes a collaborator; items stay unassigned; the collaborator loses access", async ({
    browser,
  }) => {
    const { owner, collab, base } = await sharedWedding(browser, "lb8-remove");
    const ITEM = "Contratar música";
    await addChecklistItem(owner.page, { title: ITEM, timing: { mode: "absolute", date: FUTURE } });

    // The collaborator names themselves and takes the item.
    await collab.page.goto(base);
    const section = collab.page.getByRole("region", { name: es.members.displayName.title });
    await section.getByLabel(es.members.displayName.label).fill("Sofía");
    await section.getByRole("button", { name: es.members.displayName.submit }).click();
    await expect(section.getByRole("status")).toHaveText(es.members.displayName.saved);

    await owner.page.goto(base);
    const row = checklistItem(owner.page, ITEM);
    await row.getByText(es.checklist.assignment.open, { exact: true }).click();
    await row.getByLabel(es.checklist.assignment.selectLabel).selectOption({ label: "Sofía" });
    await row.getByRole("button", { name: es.checklist.assignment.submit }).click();
    await expect(row.getByTestId("checklist-item-assignee")).toHaveText(
      `${es.checklist.assignment.label}: Sofía`,
    );

    // The collaborator has access now.
    await collab.page.reload();
    await expect(checklistItem(collab.page, ITEM)).toHaveCount(1);
    // ...and no removal controls of their own.
    await expect(collab.page.getByRole("button", { name: new RegExp(`^${removeCopy.open}`) })).toHaveCount(0);

    // The owner sees the member, never a remove control for themselves.
    const members = owner.page.getByTestId("wedding-members");
    await expect(members.getByTestId("wedding-member")).toHaveText([
      `${es.members.you} · ${es.roles.owner.label}`,
      `Sofía · ${es.roles.collaborator.label}`,
    ]);
    await expect(members.getByRole("button", { name: removeCopy.open })).toHaveCount(1);

    await members.getByRole("button", { name: `${removeCopy.open}: Sofía` }).click();
    // Deliberate confirmation that explains the effects; focus moves to it.
    const confirm = owner.page.getByRole("button", { name: removeCopy.confirmButton, exact: true });
    await expect(confirm).toBeFocused();
    await expect(owner.page.getByText(removeCopy.confirmTitle.replace("{name}", "Sofía"))).toBeVisible();
    await expect(confirm).toHaveAccessibleDescription(new RegExp(escapeRegExp(removeCopy.confirmBody)));
    // Cancel changes nothing.
    await members.getByRole("button", { name: removeCopy.cancel }).click();
    await expect(members.getByTestId("wedding-member")).toHaveCount(2);

    await members.getByRole("button", { name: `${removeCopy.open}: Sofía` }).click();
    await owner.page.getByRole("button", { name: removeCopy.confirmButton, exact: true }).click();
    await expect(owner.page.getByText(es.wedding.memberRemoved)).toBeVisible();
    await expect(members.getByTestId("wedding-member")).toHaveText([
      `${es.members.you} · ${es.roles.owner.label}`,
    ]);

    // The item is still there, now "Sin asignar".
    await expect(checklistItem(owner.page, ITEM)).toHaveCount(1);
    await expect(checklistItem(owner.page, ITEM).getByTestId("checklist-item-assignee")).toHaveText(
      `${es.checklist.assignment.label}: ${es.checklist.assignment.unassigned}`,
    );

    // The removed collaborator: still signed in, but this wedding is gone.
    const response = await collab.page.goto(base);
    expect(response?.status()).toBe(404);
    await expect(collab.page.getByText(ITEM)).toHaveCount(0);
    await collab.page.goto("/app");
    await expect(collab.page.getByRole("button", { name: es.app.nav.logout })).toBeVisible();
    await expect(collab.page.getByText("Boda lb8-remove")).toHaveCount(0);

    await owner.context.close();
    await collab.context.close();
  });

  test("LI: removing a co-owner says they also organize; the remaining owner stays", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("lb8-coowner-a"));
    const weddingId = await createWedding(owner.page, "Boda con dos organizadores");
    const inviteUrl = await createInvite(owner.page, "owner");
    const partner = await freshPage(browser);
    await logIn(partner.page, await createAccount("lb8-coowner-b"));
    await partner.page.goto(inviteUrl);
    await partner.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(partner.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));

    await owner.page.reload();
    const members = owner.page.getByTestId("wedding-members");
    const label = es.members.fallback.owner;
    await members.getByRole("button", { name: `${removeCopy.open}: ${label}` }).click();
    await expect(owner.page.getByText(removeCopy.confirmOwner)).toBeVisible();
    await owner.page.getByRole("button", { name: removeCopy.confirmButton, exact: true }).click();
    await expect(owner.page.getByText(es.wedding.memberRemoved)).toBeVisible();
    await expect(members.getByTestId("wedding-member")).toHaveText([
      `${es.members.you} · ${es.roles.owner.label}`,
    ]);
    await expect(owner.page.getByTestId("wedding-role")).toHaveText(es.roles.owner.label);
    await expect(formAlert(owner.page)).toHaveCount(0);

    const response = await partner.page.goto(`/app/weddings/${weddingId}`);
    expect(response?.status()).toBe(404);

    await owner.context.close();
    await partner.context.close();
  });
});

test.describe("phone width", () => {
  async function expectNoHorizontalScroll(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test("LJ: new wedding, settings, Atrasados and member removal fit a phone screen", async ({
    browser,
  }) => {
    const { owner, collab, weddingId, base } = await sharedWedding(browser, "lb8-phone");
    // A common small phone width.
    await owner.page.setViewportSize({ width: 360, height: 740 });

    await owner.page.goto("/app/weddings/new");
    await expect(timeZoneSelect(owner.page)).toBeVisible();
    await expectNoHorizontalScroll(owner.page);

    await openSettings(owner.page, weddingId);
    await owner.page.getByLabel(settingsCopy.cityLabel).fill("San José");
    await timeZoneSelect(owner.page).selectOption("America/Costa_Rica");
    await expectNoHorizontalScroll(owner.page);
    await saveSettings(owner.page);
    await expect(owner.page.getByText(es.wedding.settingsSaved)).toBeVisible();

    await addChecklistItem(owner.page, {
      title: "Entregar los documentos del registro civil con todas las copias",
      timing: { mode: "absolute", date: PAST },
    });
    await expect(owner.page.getByTestId("overdue-summary")).toBeVisible();
    await expect(owner.page.getByTestId("checklist-item-overdue")).toBeVisible();
    await expectNoHorizontalScroll(owner.page);

    await owner.page
      .getByTestId("wedding-members")
      .getByRole("button", { name: new RegExp(`^${removeCopy.open}`) })
      .click();
    await expect(owner.page.getByText(removeCopy.confirmBody)).toBeVisible();
    await expectNoHorizontalScroll(owner.page);

    await owner.page.goto(`${base}?view=plan`);
    await expectNoHorizontalScroll(owner.page);

    await owner.context.close();
    await collab.context.close();
  });
});
