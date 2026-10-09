import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { addDaysToIsoDate } from "../src/lib/checklist/timing";
import { formatMoney } from "../src/lib/vendors/money";
import { formatWeddingDate } from "../src/lib/weddings/format";
import { weddingLocalToday } from "../src/lib/weddings/timezone";
import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-22 (ADR-015): "Presupuesto" and the vendor's "Pagos". Estimates per
// currency and category, committed = booked contracts, schedule items
// (cuotas) and payments with every state derived, CRC and USD never mixed.
// Vendor names are fake fixtures. No email is involved anywhere.

const budget = es.budget;
const payments = es.payments;
const vendors = es.vendors;
const VENDOR_PATH = /\/app\/weddings\/[0-9a-f-]{36}\/vendors\/([0-9a-f-]{36})$/;

async function db<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** "2.400.000 ₡" with Intl's no-break space, as Playwright normalizes it. */
function money(minor: number, currency: "CRC" | "USD" = "CRC"): string {
  return formatMoney(minor, currency).replace(/\s/g, " ");
}

/** "today" in the wedding's zone (UTC here, set as a fixture), as the server derives it. */
function today(): string {
  return weddingLocalToday("UTC", new Date())!;
}

function daysFromToday(days: number): string {
  return addDaysToIsoDate(today(), days)!;
}

async function setTimeZone(weddingId: string, zone: string | null) {
  await db((client) => client.query("update public.weddings set time_zone = $2 where id = $1", [weddingId, zone]));
}

async function addVendor(
  page: Page,
  weddingId: string,
  vendor: { name: string; category: string; status: string; currency: "CRC" | "USD"; contracted: string },
): Promise<string> {
  await page.goto(`/app/weddings/${weddingId}/vendors`);
  await page.getByText(vendors.create.open, { exact: true }).first().click();
  const region = page.getByRole("region", { name: vendors.create.title });
  await region.getByLabel(vendors.fields.name, { exact: true }).fill(vendor.name);
  await region.getByLabel(vendors.fields.category, { exact: true }).selectOption(vendor.category);
  await region.getByLabel(vendors.fields.status, { exact: true }).selectOption(vendor.status);
  await region.getByLabel(vendors.fields.currency, { exact: true }).selectOption(vendor.currency);
  await region.getByLabel(vendors.fields.contractedAmount).fill(vendor.contracted);
  await region.getByRole("button", { name: vendors.create.submit }).click();
  await expect(region.getByRole("status")).toHaveText(vendors.create.created);
  await page.getByRole("link", { name: `Ver ${vendor.name}`, exact: true }).click();
  await expect(page).toHaveURL(VENDOR_PATH);
  return VENDOR_PATH.exec(page.url())![1]!;
}

function paymentsRegion(page: Page): Locator {
  return page.getByRole("region", { name: payments.title, exact: true });
}

async function openDisclosure(scope: Locator, text: string) {
  const summary = scope.locator("summary", { hasText: text }).first();
  const details = summary.locator("xpath=..");
  if ((await details.getAttribute("open")) === null) await summary.click();
}

async function scheduleItem(page: Page, label: string, amount: string, dueOn: string) {
  const region = paymentsRegion(page);
  await openDisclosure(region, payments.schedule.create);
  await page.locator("#new-schedule-item-label").fill(label);
  await page.locator("#new-schedule-item-amount").fill(amount);
  await page.locator("#new-schedule-item-dueOn").fill(dueOn);
  await region.getByRole("button", { name: payments.schedule.create, exact: true }).click();
  await expect(region.getByRole("status").filter({ hasText: payments.schedule.created })).toBeVisible();
  await expect(item(page, label)).toBeVisible();
}

async function recordPayment(page: Page, amount: string, paidOn: string, itemLabel?: string, note?: string) {
  const region = paymentsRegion(page);
  await openDisclosure(region, payments.list.record);
  await page.locator("#new-payment-amount").fill(amount);
  await page.locator("#new-payment-paidOn").fill(paidOn);
  if (itemLabel) {
    const option = page.locator("#new-payment-scheduleItemId option", { hasText: itemLabel });
    await page.locator("#new-payment-scheduleItemId").selectOption((await option.getAttribute("value"))!);
  } else {
    await page.locator("#new-payment-scheduleItemId").selectOption("");
  }
  if (note) await page.locator("#new-payment-note").fill(note);
  await region.getByRole("button", { name: payments.list.record, exact: true }).click();
}

function item(page: Page, label: string): Locator {
  return page
    .getByTestId("schedule-items")
    .locator(":scope > li")
    .filter({ has: page.getByTestId("schedule-item-label").getByText(label, { exact: true }) });
}

async function expectFigure(page: Page, key: string, minor: number, currency: "CRC" | "USD" = "CRC") {
  await expect(page.getByTestId(`payments-${key}`)).toContainText(money(minor, currency));
}

async function setVendorContract(page: Page, vendorId: string, contracted: string) {
  const region = page.getByRole("region", { name: vendors.edit.title });
  await page.locator(`#edit-${vendorId}-contractedAmount`).fill(contracted);
  await region.getByRole("button", { name: vendors.edit.submit }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
}

async function openBudget(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/budget`);
  await expect(page.getByRole("heading", { level: 1, name: budget.title })).toBeVisible();
}

const M = 100; // minor units per major unit

// ================================================================= journey

test.describe("budget and payments", () => {
  test("estimate, commit, schedule, pay, guard and decompose", async ({ page }) => {
    const email = await createAccount("budget");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda con presupuesto");
    await setTimeZone(weddingId, "UTC");

    // Navigation: "Presupuesto" after "Proveedores", before "Sitio web".
    await page.goto(`/app/weddings/${weddingId}`);
    const order = await page.getByRole("link").evaluateAll((links) => links.map((l) => l.textContent?.trim() ?? ""));
    expect(order.indexOf(vendors.navLink)).toBeLessThan(order.indexOf(budget.navLink));
    expect(order.indexOf(budget.navLink)).toBeLessThan(order.indexOf(es.site.navLink));
    await page.getByRole("link", { name: budget.navLink, exact: true }).click();
    await expect(page.getByTestId("budget-empty")).toContainText(budget.empty.title);
    await expect(page.getByTestId("budget-empty").getByRole("link", { name: budget.empty.vendorsLink })).toBeVisible();

    // 2–3. A booked photographer with a CRC contract.
    const photoId = await addVendor(page, weddingId, {
      name: "Estudio Luz",
      category: "photography",
      status: "booked",
      currency: "CRC",
      contracted: "6.000.000",
    });

    // 4–7. Budget: CRC total and a photography estimate; committed comes from the contract.
    await openBudget(page, weddingId);
    const crc = page.getByTestId("budget-currency-CRC");
    await expect(crc.getByTestId("budget-CRC-total")).toContainText(budget.figures.undefined);
    await expect(crc.getByTestId("budget-CRC-committed")).toContainText(money(6_000_000 * M));
    await openDisclosure(crc, budget.totalForm.open);
    await page.locator("#budget-total-CRC-amount").fill("12.000.000");
    await crc.getByRole("button", { name: budget.totalForm.save, exact: true }).click();
    await expect(crc.getByTestId("budget-CRC-total")).toContainText(money(12_000_000 * M));
    await expect(crc.getByTestId("budget-CRC-variance")).toContainText(budget.figures.available);
    await expect(crc.getByTestId("budget-CRC-variance")).toContainText(money(6_000_000 * M));

    const categories = page.getByTestId("budget-categories");
    await openDisclosure(categories, budget.categories.add);
    await page.locator("#budget-category-new-CRC-category").selectOption("photography");
    await page.locator("#budget-category-new-CRC-amount").fill("5.000.000");
    await page.locator("#budget-category-new-CRC-amount").press("Enter");
    const photoRow = page.getByTestId("budget-category-CRC-photography");
    await expect(photoRow).toContainText(money(5_000_000 * M));
    await expect(photoRow).toContainText(
      budget.categories.over.replace("{amount}", money(1_000_000 * M)),
    );
    await expect(crc.getByTestId("budget-CRC-allocation")).toContainText(
      budget.allocation.unallocated.replace("{amount}", money(7_000_000 * M)),
    );

    // 8–10. Vendor detail: Pagos, two schedule items.
    await page.goto(`/app/weddings/${weddingId}/vendors/${photoId}`);
    await expect(paymentsRegion(page)).toBeVisible();
    await expectFigure(page, "unscheduled", 6_000_000 * M);
    await scheduleItem(page, "Depósito", "2.000.000", daysFromToday(30));
    await scheduleItem(page, "Pago final", "3.000.000", daysFromToday(60));
    await expectFigure(page, "unscheduled", 1_000_000 * M);
    await expect(item(page, "Depósito").getByTestId("schedule-item-state")).toHaveText(payments.states.pending);

    // Over-scheduling is refused by the database, next to the amount.
    await scheduleItemExpectingError(page, "Extra", "1.000.001", daysFromToday(90), payments.errors.scheduleExceedsContract);

    // 11–12. A partial payment on the deposit.
    await recordPayment(page, "1.000.000", today(), "Depósito", "SINPE #8842");
    await expect(paymentsRegion(page).getByText(payments.list.recorded)).toBeVisible();
    await expectFigure(page, "paid", 1_000_000 * M);
    await expectFigure(page, "remaining", 5_000_000 * M);
    const deposit = item(page, "Depósito");
    await expect(deposit.getByTestId("schedule-item-state")).toHaveText(payments.states.partial);
    await expect(deposit.getByTestId("schedule-item-progress")).toContainText(
      `Pagado ${money(1_000_000 * M)} de ${money(2_000_000 * M)}`,
    );
    await expect(deposit.getByTestId("schedule-item-progress")).toContainText(`Pendiente ${money(1_000_000 * M)}`);
    await expect(page.getByTestId("payments-list")).toContainText("SINPE #8842");
    // An item with payments explains why it can't be deleted.
    await expect(deposit.getByTestId("schedule-item-delete-blocked")).toHaveText(payments.schedule.deleteBlocked);

    // A payment beyond what the deposit still owes is refused.
    await recordPayment(page, "1.000.001", today(), "Depósito");
    await expect(page.locator("#new-payment-amount-error")).toHaveText(payments.errors.paymentExceedsScheduleItem);

    // 13–14. The remainder.
    await recordPayment(page, "1.000.000", today(), "Depósito");
    await expect(item(page, "Depósito").getByTestId("schedule-item-state")).toHaveText(payments.states.paid);
    await expectFigure(page, "paid", 2_000_000 * M);
    await expectFigure(page, "scheduled-remaining", 3_000_000 * M);

    // 15–16. Back to the budget.
    await openBudget(page, weddingId);
    await expect(page.getByTestId("budget-CRC-paid")).toContainText(money(2_000_000 * M));
    await expect(page.getByTestId("budget-CRC-remaining")).toContainText(money(4_000_000 * M));
    await expect(page.getByTestId("budget-CRC-unscheduled")).toContainText(money(1_000_000 * M));
    await expect(page.getByTestId(`budget-booked-${photoId}`)).toContainText(money(4_000_000 * M));

    // 17–18. A USD booked vendor: its own block, never added to CRC.
    await addVendor(page, weddingId, {
      name: "Música Viva",
      category: "music",
      status: "booked",
      currency: "USD",
      contracted: "2.500",
    });
    await openBudget(page, weddingId);
    await expect(page.getByTestId("budget-USD-committed")).toContainText(money(2_500 * M, "USD"));
    await expect(page.getByTestId("budget-CRC-committed")).toContainText(money(6_000_000 * M));
    await expect(page.getByTestId("budget-USD-total")).toContainText(budget.figures.undefined);

    // 19–20. A past-due, unpaid item: Vencido, on both pages.
    await page.goto(`/app/weddings/${weddingId}/vendors/${photoId}`);
    await scheduleItem(page, "Saldo atrasado", "500.000", daysFromToday(-10));
    await expect(item(page, "Saldo atrasado").getByTestId("schedule-item-state")).toHaveText(payments.states.overdue);
    await expectFigure(page, "unscheduled", 500_000 * M);
    await openBudget(page, weddingId);
    const overdue = page.getByTestId("budget-overdue");
    await expect(overdue).toContainText("Estudio Luz · Saldo atrasado");
    await expect(overdue).toContainText(payments.states.overdue);
    await expect(overdue).toContainText(formatWeddingDate(daysFromToday(-10)));

    // 21–22. A bigger contract: more "Sin programar".
    await page.goto(`/app/weddings/${weddingId}/vendors/${photoId}`);
    await setVendorContract(page, photoId, "7.000.000");
    await expect(page.getByRole("region", { name: vendors.edit.title }).getByRole("status")).toHaveText(vendors.edit.saved);
    await expectFigure(page, "unscheduled", 1_500_000 * M);

    // 23–24. Below the recorded floor (5 500 000): refused, naming it.
    await setVendorContract(page, photoId, "5.000.000");
    await expect(page.locator(`#edit-${photoId}-contractedAmount-error`)).toHaveText(
      vendors.errors.contractBelowRecorded.replace("{amount}", money(5_500_000 * M)),
    );
    expect(await contractOf(photoId)).toBe(7_000_000 * M);

    // 25–26. The currency is locked in the UI; a forged submit is still refused by the database.
    const locked = page.getByTestId("vendor-currency-locked");
    await expect(locked).toContainText(vendors.currencies.CRC);
    await expect(locked).toContainText(vendors.currencyLockedHint);
    await page.reload();
    await page
      .getByRole("region", { name: vendors.edit.title })
      .locator("input[type=hidden][name=currency]")
      .evaluate((input) => {
        (input as HTMLInputElement).value = "USD";
      });
    await page.getByRole("region", { name: vendors.edit.title }).getByRole("button", { name: vendors.edit.submit }).click();
    await expect(page.locator(`#edit-${photoId}-currency-error`)).toHaveText(vendors.errors.currencyLocked);
    expect(await currencyOf(photoId)).toBe("CRC");

    // 27–28. Deleting a vendor with financial history: no delete button, explained.
    await page.reload();
    await expect(page.getByTestId("vendor-delete-blocked")).toHaveText(vendors.deleteBlocked);
    await expect(page.getByRole("button", { name: vendors.delete.open })).toHaveCount(0);

    // 29–30. An unallocated payment consumes "Sin programar".
    await recordPayment(page, "1.000.000", today());
    await expect(paymentsRegion(page).getByText(payments.list.recorded)).toBeVisible();
    await expectFigure(page, "unscheduled", 500_000 * M);
    const unlinked = page
      .getByTestId("payments-list")
      .locator(":scope > li")
      .filter({ has: page.getByTestId("payment-allocation").getByText(payments.list.noItem, { exact: true }) });
    await expect(unlinked).toHaveCount(1);

    // 31–32. Applied later to "Pago final": the room returns to "Sin programar", the item becomes partial.
    const paymentId = (await unlinked.getAttribute("data-testid"))!.replace("payment-", "");
    await unlinked.locator("summary").click();
    const editItem = page.locator(`#edit-payment-${paymentId}-scheduleItemId`);
    const finalValue = await editItem.locator("option", { hasText: "Pago final" }).getAttribute("value");
    await editItem.selectOption(finalValue!);
    await unlinked.getByRole("button", { name: payments.list.save }).click();
    await expect(page.getByTestId(`payment-${paymentId}`).getByTestId("payment-allocation")).toHaveText(
      payments.list.appliedTo.replace("{label}", "Pago final"),
    );
    await expectFigure(page, "unscheduled", 1_500_000 * M);
    await expect(item(page, "Pago final").getByTestId("schedule-item-state")).toHaveText(payments.states.partial);
    // Contract remaining = scheduled remaining + unscheduled: 4 000 000 = 2 500 000 + 1 500 000.
    await expectFigure(page, "remaining", 4_000_000 * M);
    await expectFigure(page, "scheduled-remaining", 2_500_000 * M);

    // Removing the total estimate is explicit, and only removes the estimate.
    await openBudget(page, weddingId);
    const crcBlock = page.getByTestId("budget-currency-CRC");
    await openDisclosure(crcBlock, budget.totalForm.edit);
    await crcBlock.getByRole("button", { name: budget.totalForm.remove }).click();
    await expect(crcBlock.getByTestId("budget-CRC-total")).toContainText(budget.figures.undefined);
    await expect(crcBlock.getByTestId("budget-CRC-committed")).toContainText(money(7_000_000 * M));
  });

  test("payments to a vendor not marked Contratado count as paid, not committed, and need attention", async ({ page }) => {
    const email = await createAccount("budget-attention");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda atención");
    const vendorId = await addVendor(page, weddingId, {
      name: "Banda Elegida",
      category: "music",
      status: "selected",
      currency: "USD",
      contracted: "1.000",
    });
    await recordPayment(page, "200", today(), undefined, "Transferencia BAC");
    await expect(paymentsRegion(page).getByText(payments.list.recorded)).toBeVisible();

    await openBudget(page, weddingId);
    await expect(page.getByTestId("budget-USD-paid")).toContainText(money(200 * M, "USD"));
    await expect(page.getByTestId("budget-USD-committed")).toContainText(money(0, "USD"));
    await expect(page.getByTestId("budget-USD-remaining")).toContainText(money(0, "USD"));
    const attention = page.getByTestId("budget-attention");
    await expect(attention).toContainText(budget.attention.title);
    await expect(attention).toContainText("Banda Elegida (Elegido)");
    await expect(attention).toContainText(money(200 * M, "USD"));
    // Nothing changed the vendor's status.
    expect(await db((c) => c.query("select status::text from public.wedding_vendors where id = $1", [vendorId]))).toMatchObject({
      rows: [{ status: "selected" }],
    });
  });

  test("CRC and USD stay separate blocks: no combined total, no conversion", async ({ page }) => {
    const email = await createAccount("budget-mixed");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda dos monedas");
    await addVendor(page, weddingId, { name: "Salón", category: "venue", status: "booked", currency: "CRC", contracted: "3.000.000" });
    await addVendor(page, weddingId, { name: "Fotos", category: "photography", status: "booked", currency: "USD", contracted: "1.500" });
    await openBudget(page, weddingId);

    const crc = page.getByTestId("budget-currency-CRC");
    const usd = page.getByTestId("budget-currency-USD");
    await expect(crc.getByRole("heading", { name: budget.currencyTitle.CRC })).toBeVisible();
    await expect(usd.getByRole("heading", { name: budget.currencyTitle.USD })).toBeVisible();
    await expect(crc).toContainText(money(3_000_000 * M));
    await expect(crc).not.toContainText("US$");
    await expect(usd).toContainText(money(1_500 * M, "USD"));
    await expect(usd).not.toContainText("₡");
    const text = (await page.locator("main").innerText()).toLowerCase();
    for (const forbidden of ["tipo de cambio", "equivalente", "convertido", "total general", "≈"]) {
      expect(text).not.toContain(forbidden);
    }
    // The two amounts are never summed anywhere on the page.
    expect(text).not.toContain(money(3_000_000 * M + 1_500 * M).toLowerCase());
  });

  test("no time zone: dates show, nothing is labelled overdue, with a hint", async ({ page }) => {
    const email = await createAccount("budget-no-zone");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda sin zona");
    await addVendor(page, weddingId, { name: "Catering", category: "catering", status: "booked", currency: "CRC", contracted: "1.000" });
    await scheduleItem(page, "Atrasada", "500", "2020-01-01");
    await expect(item(page, "Atrasada").getByTestId("schedule-item-state")).toHaveText(payments.states.pending);
    await expect(item(page, "Atrasada")).toContainText(formatWeddingDate("2020-01-01"));
    await openBudget(page, weddingId);
    await expect(page.getByTestId("budget-overdue-no-timezone")).toHaveText(budget.timingUnavailable);
    await expect(page.getByTestId("budget-overdue")).not.toContainText("Atrasada");
  });
});

async function scheduleItemExpectingError(page: Page, label: string, amount: string, dueOn: string, error: string) {
  const region = paymentsRegion(page);
  await openDisclosure(region, payments.schedule.create);
  await page.locator("#new-schedule-item-label").fill(label);
  await page.locator("#new-schedule-item-amount").fill(amount);
  await page.locator("#new-schedule-item-dueOn").fill(dueOn);
  await region.getByRole("button", { name: payments.schedule.create, exact: true }).click();
  await expect(page.locator("#new-schedule-item-amount-error")).toHaveText(error);
}

async function contractOf(vendorId: string): Promise<number> {
  const { rows } = await db((c) =>
    c.query<{ amount: string }>("select contracted_amount_minor::text as amount from public.wedding_vendors where id = $1", [vendorId]),
  );
  return Number(rows[0]!.amount);
}

async function currencyOf(vendorId: string): Promise<string> {
  const { rows } = await db((c) =>
    c.query<{ currency: string }>("select currency from public.wedding_vendors where id = $1", [vendorId]),
  );
  return rows[0]!.currency;
}

// ================================================================== mobile

test.describe("budget and payments on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("budget summaries, the category form and the vendor's Pagos forms fit 390 px", async ({ page }) => {
    const email = await createAccount("budget-mobile");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda en el teléfono con un nombre bastante largo");
    await setTimeZone(weddingId, "UTC");
    await addVendor(page, weddingId, {
      name: "Fotografía y video de bodas Estudio Luz con nombre largo",
      category: "photography",
      status: "booked",
      currency: "CRC",
      contracted: "99.999.999",
    });
    await scheduleItem(page, "Depósito de reserva para la fecha", "33.333.333", daysFromToday(5));
    await recordPayment(page, "11.111.111", today(), "Depósito de reserva", "SINPE #8842 desde la cuenta de la novia");
    await expect(paymentsRegion(page).getByText(payments.list.recorded)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    // The forms stay usable: open the edit of the item and the payment.
    await item(page, "Depósito de reserva para la fecha").locator("summary").click();
    await expect(page.locator('[id^="edit-item-"][id$="-amount"]')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await openBudget(page, weddingId);
    await expect(page.getByTestId("budget-currency-CRC")).toBeVisible();
    await openDisclosure(page.getByTestId("budget-categories"), budget.categories.add);
    await page.locator("#budget-category-new-CRC-category").selectOption("photography");
    await page.locator("#budget-category-new-CRC-amount").fill("90.000.000");
    await page.locator("#budget-category-new-CRC-amount").press("Enter");
    await expect(page.getByTestId("budget-category-CRC-photography")).toContainText(money(90_000_000 * M));
    await expect(page.getByTestId("budget-due-soon")).toContainText("Depósito de reserva para la fecha");
    await expectNoHorizontalOverflow(page);
  });
});
