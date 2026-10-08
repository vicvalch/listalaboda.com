import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createWedding, es, formAlert, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-19 (ADR-012): the seating plan ("Mesas"): tables, seat, move, unseat,
// capacity refusals, pending and declined guests, and a guest who declines
// after being seated. Plain forms only (no drag and drop). Names are fake
// fixtures; guest links are bearer credentials and are never printed.

const seating = es.seating;
const guests = es.guests;
const rsvp = es.rsvp;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function createParty(page: Page, label: string, names: string[]): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  const field = section.getByTestId("guest-link");
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

/** The party answers through its link in a separate, signed-out browser. */
async function answerAs(browser: Browser, link: string, answers: Readonly<Record<string, boolean>>, change = false) {
  const guest = await freshPage(browser);
  try {
    await guest.page.goto(link);
    for (const [name, attending] of Object.entries(answers)) {
      await guest.page
        .getByRole("group", { name, exact: true })
        .getByRole("radio", { name: attending ? rsvp.yes : rsvp.no })
        .check();
    }
    await guest.page.getByRole("button", { name: change ? rsvp.submitChanges : rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
  } finally {
    await guest.context.close();
  }
}

async function openSeating(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/seating`);
  await expect(page.getByRole("heading", { level: 1, name: seating.title })).toBeVisible();
}

function table(page: Page, name: string): Locator {
  return page
    .getByTestId("seating-table")
    .filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });
}

function seatedGuest(page: Page, tableName: string, name: string): Locator {
  return table(page, tableName)
    .getByTestId("seated-guest")
    .filter({ has: page.getByTestId("seating-guest-name").getByText(name, { exact: true }) });
}

function unassigned(page: Page): Locator {
  return page.getByTestId("seating-unassigned");
}

function unseatedGuest(page: Page, name: string): Locator {
  return unassigned(page)
    .getByTestId("unseated-guest")
    .filter({ has: page.getByTestId("seating-guest-name").getByText(name, { exact: true }) });
}

async function createTable(page: Page, name: string, capacity: number) {
  const section = page.getByRole("region", { name: seating.newTable.title });
  await section.getByLabel(seating.newTable.nameLabel).fill(name);
  await section.getByLabel(seating.newTable.capacityLabel).fill(String(capacity));
  await section.getByRole("button", { name: seating.newTable.submit }).click();
  await expect(section.getByRole("status")).toHaveText(seating.newTable.created);
  await expect(table(page, name)).toHaveCount(1);
}

async function seat(page: Page, guest: string, tableName: string) {
  await page.getByLabel(`Mesa para ${guest}`, { exact: true }).selectOption({ label: tableName });
  await page.getByRole("button", { name: `Asignar a ${guest}`, exact: true }).click();
}

async function expectOccupancy(page: Page, tableName: string, text: string) {
  await expect(table(page, tableName).getByTestId("seating-table-occupancy")).toHaveText(text);
}

async function expectSummary(
  page: Page,
  values: Readonly<{ confirmed: number; seated: number; unseated: number; capacity: number }>,
) {
  for (const [key, value] of Object.entries(values)) {
    await expect(page.getByTestId(`seating-summary-${key}`).locator("dd")).toHaveText(String(value));
  }
}

async function guestCount(weddingId: string): Promise<number> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.guests where wedding_id = $1", [
      weddingId,
    ]);
    return rows[0]?.n ?? 0;
  } finally {
    await db.end();
  }
}

test.describe("seating plan", () => {
  test("tables, seat, refuse a full table, move, unseat, decline after seating, delete a table", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb19-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Mesas", "2090-06-01");

    // Guests: one party answers (two yes, one no), another doesn't answer.
    await page.getByRole("link", { name: guests.navLink }).click();
    await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
    const perez = await createParty(page, "Familia Pérez", ["Ana Pérez", "Carlos Pérez", "Lucía Pérez"]);
    await createParty(page, "Familia Gómez", ["Marta Gómez"]);
    await answerAs(browser, perez, { "Ana Pérez": true, "Carlos Pérez": true, "Lucía Pérez": false });

    // "Mesas" is in the wedding's navigation.
    await page.goto(`/app/weddings/${weddingId}`);
    await page.getByRole("link", { name: seating.navLink, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/seating$`));
    await expect(page.getByRole("heading", { level: 1, name: seating.title })).toBeVisible();
    await expect(page.getByText(seating.tables.empty)).toBeVisible();
    await expectSummary(page, { confirmed: 2, seated: 0, unseated: 2, capacity: 0 });

    // Grouped by party: confirmed first, then pending; declined only informational.
    await expect(unseatedGuest(page, "Ana Pérez")).toContainText(interpolateParty("Familia Pérez"));
    await expect(unseatedGuest(page, "Marta Gómez").getByTestId("seating-guest-status")).toHaveText(
      seating.status.pending,
    );

    await createTable(page, "Mesa 1", 2);
    await createTable(page, "Mesa 2", 4);
    await expectOccupancy(page, "Mesa 1", "0 / 2");
    await expectSummary(page, { confirmed: 2, seated: 0, unseated: 2, capacity: 6 });

    // A second tab that will go stale before Mesa 1 fills up.
    const stale = await page.context().newPage();
    await openSeating(stale, weddingId);

    await seat(page, "Ana Pérez", "Mesa 1");
    await expect(seatedGuest(page, "Mesa 1", "Ana Pérez")).toBeVisible();
    await seat(page, "Carlos Pérez", "Mesa 1");
    await expect(seatedGuest(page, "Mesa 1", "Carlos Pérez")).toBeVisible();
    await expectOccupancy(page, "Mesa 1", "2 / 2");
    await expect(table(page, "Mesa 1").getByTestId("seating-table-full")).toHaveText(seating.tables.full);
    // The page knows Mesa 1 is full: the option is disabled.
    await expect(
      page.getByLabel("Mesa para Marta Gómez", { exact: true }).locator("option", { hasText: "Mesa 1" }),
    ).toBeDisabled();

    // The stale tab still offers Mesa 1: the database refuses.
    await seat(stale, "Marta Gómez", "Mesa 1");
    await expect(unseatedGuest(stale, "Marta Gómez").getByRole("alert")).toHaveText(seating.errors.tableFull);
    await stale.close();
    await page.reload();
    await expectOccupancy(page, "Mesa 1", "2 / 2");

    // A pending guest can be seated.
    await seat(page, "Marta Gómez", "Mesa 2");
    await expect(seatedGuest(page, "Mesa 2", "Marta Gómez").getByTestId("seating-guest-status")).toHaveText(
      seating.status.pending,
    );
    await expectOccupancy(page, "Mesa 2", "1 / 4");

    // Move Carlos from Mesa 1 to Mesa 2.
    await page.getByLabel("Mover a Carlos Pérez a", { exact: true }).selectOption({ label: "Mesa 2" });
    await page.getByRole("button", { name: "Mover a Carlos Pérez", exact: true }).click();
    await expect(seatedGuest(page, "Mesa 2", "Carlos Pérez")).toBeVisible();
    await expect(seatedGuest(page, "Mesa 1", "Carlos Pérez")).toHaveCount(0);
    await expectOccupancy(page, "Mesa 1", "1 / 2");
    await expectOccupancy(page, "Mesa 2", "2 / 4");

    // Unseat Ana: she's back in "Sin mesa".
    await page.getByRole("button", { name: "Quitar de mesa a Ana Pérez", exact: true }).click();
    await expect(unseatedGuest(page, "Ana Pérez")).toBeVisible();
    await expectOccupancy(page, "Mesa 1", "0 / 2");
    await expectSummary(page, { confirmed: 2, seated: 2, unseated: 1, capacity: 6 });

    // A declined guest is never offered a table.
    const declined = page.getByTestId("seating-declined-group");
    await declined.locator("summary").click();
    await expect(declined.getByText("Lucía Pérez", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Asignar a Lucía Pérez" })).toHaveCount(0);

    // Carlos later declines: the RSVP saves, and he stays seated with a warning.
    await answerAs(browser, perez, { "Ana Pérez": true, "Carlos Pérez": false, "Lucía Pérez": false }, true);
    await page.reload();
    const carlos = seatedGuest(page, "Mesa 2", "Carlos Pérez");
    await expect(carlos.getByTestId("seating-guest-status")).toHaveText(seating.status.declined);
    await expect(carlos.getByTestId("seating-declined-note")).toHaveText(seating.declinedNote);
    await expect(page.getByTestId("seating-declined-warning")).toHaveText(seating.summary.declinedSeatedOne);
    // He can't be moved, only unseated by hand.
    await expect(page.getByRole("button", { name: "Mover a Carlos Pérez" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Quitar de mesa a Carlos Pérez" })).toBeVisible();
    await expectOccupancy(page, "Mesa 2", "2 / 4");
    await expectSummary(page, { confirmed: 1, seated: 2, unseated: 1, capacity: 6 });

    // Lowering Mesa 2 below its two seated people is refused, nobody unseated.
    const mesa2 = table(page, "Mesa 2");
    await mesa2.locator("summary", { hasText: seating.editTable.open }).click();
    await mesa2.getByLabel(seating.newTable.capacityLabel).fill("1");
    await mesa2.getByRole("button", { name: seating.editTable.submit }).click();
    await expect(mesa2.getByText(seating.errors.capacityBelowAssigned)).toBeVisible();
    await page.reload();
    await expectOccupancy(page, "Mesa 2", "2 / 4");

    // Delete Mesa 2: its people become unassigned; no guest is deleted.
    await table(page, "Mesa 2").getByRole("button", { name: "Eliminar Mesa 2" }).click();
    await table(page, "Mesa 2").getByRole("button", { name: seating.deleteTable.confirm }).click();
    await expect(table(page, "Mesa 2")).toHaveCount(0);
    await expect(unseatedGuest(page, "Marta Gómez")).toBeVisible();
    await page.getByTestId("seating-declined-group").locator("summary").click();
    await expect(page.getByTestId("seating-declined-group").getByText("Carlos Pérez", { exact: true })).toBeVisible();
    await expect(page.getByTestId("seating-declined-warning")).toHaveCount(0);
    await expectSummary(page, { confirmed: 1, seated: 0, unseated: 1, capacity: 2 });
    expect(await guestCount(weddingId)).toBe(4);
    await expect(formAlert(page)).toHaveCount(0);
  });

  test("a non-member gets the same 404 as a missing wedding", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb19-owner-404"));
    const weddingId = await createWedding(page, "Boda privada Mesas");

    const other = await freshPage(browser);
    try {
      await logIn(other.page, await createAccount("lb19-outsider"));
      const response = await other.page.goto(`/app/weddings/${weddingId}/seating`);
      expect(response?.status()).toBe(404);
      await expect(other.page.getByRole("heading", { level: 1, name: seating.title })).toHaveCount(0);
      await expect(other.page.getByTestId("seating-table")).toHaveCount(0);
    } finally {
      await other.context.close();
    }
  });
});

function interpolateParty(label: string): string {
  return seating.party.replace("{party}", label);
}
