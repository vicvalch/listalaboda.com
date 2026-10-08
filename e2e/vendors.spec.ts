import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { formatMoney } from "../src/lib/vendors/money";
import { createAccount, createWedding, es, formAlert, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-21 (ADR-014): "Proveedores" — the wedding's vendor engagements. Plain
// forms, local search, URL-backed category/status filters, money per currency
// (never mixed), and privacy: vendor data never leaves the organizers'
// private pages. Names and contacts are fake fixtures. No email is ever sent
// to a vendor.

const vendors = es.vendors;
const fields = vendors.fields;
const site = es.site;
const guests = es.guests;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;
const VENDOR_PATH = /\/app\/weddings\/[0-9a-f-]{36}\/vendors\/([0-9a-f-]{36})$/;

type VendorFields = {
  name: string;
  category: keyof typeof vendors.categories;
  customCategory?: string;
  status?: keyof typeof vendors.statuses;
  contactName?: string;
  email?: string;
  phone?: string;
  instagram?: string;
  currency?: "CRC" | "USD" | "";
  quoted?: string;
  contracted?: string;
  notes?: string;
};

async function openVendors(page: Page, weddingId: string, query = "") {
  await page.goto(`/app/weddings/${weddingId}/vendors${query}`);
  await expect(page.getByRole("heading", { level: 1, name: vendors.title })).toBeVisible();
}

function createRegion(page: Page): Locator {
  return page.getByRole("region", { name: vendors.create.title });
}

function editRegion(page: Page): Locator {
  return page.getByRole("region", { name: vendors.edit.title });
}

function filters(page: Page): Locator {
  return page.getByRole("form", { name: vendors.filters.label });
}

function card(page: Page, name: string): Locator {
  return page
    .getByTestId("vendor-card")
    .filter({ has: page.getByRole("link", { name: `Ver ${name}`, exact: true }) });
}

async function fillVendorForm(scope: Locator, vendor: Partial<VendorFields>) {
  if (vendor.name !== undefined) await scope.getByLabel(fields.name, { exact: true }).fill(vendor.name);
  if (vendor.category !== undefined) await scope.getByLabel(fields.category, { exact: true }).selectOption(vendor.category);
  if (vendor.customCategory !== undefined) await scope.getByLabel(fields.customCategory).fill(vendor.customCategory);
  if (vendor.status !== undefined) await scope.getByLabel(fields.status, { exact: true }).selectOption(vendor.status);
  if (vendor.contactName !== undefined) await scope.getByLabel(fields.contactName).fill(vendor.contactName);
  if (vendor.email !== undefined) await scope.getByLabel(fields.email, { exact: true }).fill(vendor.email);
  if (vendor.phone !== undefined) await scope.getByLabel(fields.phone).fill(vendor.phone);
  if (vendor.instagram !== undefined) await scope.getByLabel(fields.instagram).fill(vendor.instagram);
  if (vendor.currency !== undefined) await scope.getByLabel(fields.currency, { exact: true }).selectOption(vendor.currency);
  if (vendor.quoted !== undefined) await scope.getByLabel(fields.quotedAmount).fill(vendor.quoted);
  if (vendor.contracted !== undefined) await scope.getByLabel(fields.contractedAmount).fill(vendor.contracted);
  if (vendor.notes !== undefined) await scope.getByLabel(fields.notes).fill(vendor.notes);
}

async function addVendor(page: Page, vendor: VendorFields) {
  const region = createRegion(page);
  if (!(await region.isVisible())) await page.getByText(vendors.create.open, { exact: true }).first().click();
  await expect(region).toBeVisible();
  await fillVendorForm(region, vendor);
  await region.getByRole("button", { name: vendors.create.submit }).click();
  await expect(region.getByRole("status")).toHaveText(vendors.create.created);
  await expect(card(page, vendor.name)).toBeVisible();
}

/** Opens a vendor from the list and returns its id (from the URL). */
async function openVendor(page: Page, name: string): Promise<string> {
  await card(page, name).getByRole("link", { name: `Ver ${name}`, exact: true }).click();
  await expect(page).toHaveURL(VENDOR_PATH);
  await expect(page.getByTestId("vendor-name")).toHaveText(name);
  return VENDOR_PATH.exec(page.url())![1]!;
}

async function saveEdit(page: Page, change: Partial<VendorFields>) {
  const region = editRegion(page);
  await fillVendorForm(region, change);
  await region.getByRole("button", { name: vendors.edit.submit }).click();
  await expect(region.getByRole("status")).toHaveText(vendors.edit.saved);
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
}

async function db<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** "2.400.000 ₡" with Intl's no-break space, as Playwright normalizes it. */
function money(minor: number, currency: "CRC" | "USD"): string {
  return formatMoney(minor, currency).replace(/\s/g, " ");
}

// ---------------------------------------------------------------- journey

test.describe("vendors", () => {
  test("the planner journey: add, filter, search, edit, book, discard, delete", async ({ page }) => {
    const email = await createAccount("vendors");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda con proveedores");

    // Navigation: "Proveedores" sits after "Mesas" and before "Sitio web".
    const nav = page.getByRole("link", { name: vendors.navLink, exact: true });
    await expect(nav).toBeVisible();
    const order = await page
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
    const at = (label: string) => order.indexOf(label);
    expect(at(es.seating.navLink)).toBeLessThan(at(vendors.navLink));
    expect(at(vendors.navLink)).toBeLessThan(at(site.navLink));
    await nav.click();
    await expect(page.getByRole("heading", { level: 1, name: vendors.title })).toBeVisible();

    // Empty state.
    await expect(page.getByTestId("vendors-empty")).toContainText(vendors.empty.title);
    await expect(page.getByTestId("vendors-empty")).toContainText(vendors.empty.body);

    // A florist with a CRC quote and a photographer with a USD contract.
    await addVendor(page, {
      name: "Floristería Las Gardenias",
      category: "flowers_decor",
      status: "quoted",
      contactName: "María José Núñez",
      email: "ventas@gardenias.example",
      phone: "+506 8888-1234",
      instagram: "@gardenias.cr",
      currency: "CRC",
      quoted: "1.200.000",
      notes: "Pedir muestras.\nLlamar el lunes.",
    });
    await addVendor(page, {
      name: "Estudio Luz",
      category: "photography",
      status: "booked",
      contactName: "Andrés",
      currency: "USD",
      contracted: "3.500",
    });

    // Summary: counts per status, and only the booked contract in the total.
    await expect(page.getByTestId("vendor-summary-total")).toHaveText("2 proveedores");
    await expect(page.getByTestId("vendor-summary-quoted")).toHaveText("1 cotizado");
    await expect(page.getByTestId("vendor-summary-booked")).toHaveText("1 contratado");
    await expect(page.getByTestId("vendor-contracted-USD")).toHaveText(money(350_000, "USD"));
    // The CRC quote is shown on its card but never summed as contracted.
    await expect(page.getByTestId("vendor-contracted-CRC")).toHaveCount(0);
    await expect(card(page, "Floristería Las Gardenias").getByTestId("vendor-amount")).toHaveText(
      `Cotización: ${money(120_000_000, "CRC")}`,
    );
    await expect(card(page, "Estudio Luz").getByTestId("vendor-amount")).toHaveText(
      `Contratado: ${money(350_000, "USD")}`,
    );
    // Cards: status as text, contact lines, no notes.
    const florist = card(page, "Floristería Las Gardenias");
    await expect(florist.getByTestId("vendor-status")).toHaveText(vendors.statuses.quoted);
    await expect(florist).toContainText("María José Núñez");
    await expect(florist.getByRole("link", { name: "ventas@gardenias.example" })).toHaveAttribute(
      "href",
      "mailto:ventas@gardenias.example",
    );
    await expect(florist.getByRole("link", { name: "+506 8888-1234" })).toHaveAttribute("href", "tel:+50688881234");
    await expect(page.getByText("Pedir muestras.")).toHaveCount(0);
    // Grouped by category, in display order.
    await expect(page.getByTestId("vendor-group").getByRole("heading", { level: 3 })).toHaveText([
      vendors.categories.photography,
      vendors.categories.flowers_decor,
    ]);

    // Filters: category and status in the URL; the search text never.
    await filters(page).getByLabel(vendors.filters.category).selectOption("flowers_decor");
    await expect(page).toHaveURL(/\?category=flowers_decor$/);
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    await expect(card(page, "Floristería Las Gardenias")).toBeVisible();
    await filters(page).getByLabel(vendors.filters.category).selectOption("");
    await filters(page).getByLabel(vendors.filters.status).selectOption("booked");
    await expect(page).toHaveURL(/\?status=booked$/);
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    await expect(card(page, "Estudio Luz")).toBeVisible();
    // A reload keeps the URL filters.
    await page.reload();
    await expect(filters(page).getByLabel(vendors.filters.status)).toHaveValue("booked");
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    await page.getByRole("button", { name: vendors.filters.clear }).click();
    await expect(page).toHaveURL(/\/vendors$/);
    await expect(page.getByTestId("vendor-card")).toHaveCount(2);

    // Search by contact name, accent- and case-insensitive, never in the URL.
    await filters(page).getByLabel(vendors.filters.search).fill("MARIA JOSE");
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    await expect(card(page, "Floristería Las Gardenias")).toBeVisible();
    expect(page.url()).not.toMatch(/maria|MARIA|jose/i);
    await filters(page).getByLabel(vendors.filters.search).press("Enter");
    expect(page.url()).not.toMatch(/maria|jose|search|q=/i);
    await filters(page).getByLabel(vendors.filters.search).fill("andres");
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    await expect(card(page, "Estudio Luz")).toBeVisible();
    await filters(page).getByLabel(vendors.filters.search).fill("nadie");
    await expect(page.getByText(vendors.filters.noResults)).toBeVisible();
    await filters(page).getByLabel(vendors.filters.search).fill("");

    // Detail: everything, notes included, as plain text.
    await openVendor(page, "Floristería Las Gardenias");
    await expect(page.getByTestId("vendor-detail-category")).toContainText(vendors.categories.flowers_decor);
    await expect(page.getByTestId("vendor-detail-status")).toContainText(vendors.statuses.quoted);
    await expect(page.getByTestId("vendor-detail-quote")).toContainText(money(120_000_000, "CRC"));
    await expect(page.getByTestId("vendor-detail-notes")).toContainText("Pedir muestras.");
    const instagram = page.getByRole("link", { name: "@gardenias.cr" });
    await expect(instagram).toHaveAttribute("href", "https://www.instagram.com/gardenias.cr/");
    await expect(instagram).toHaveAttribute("rel", "noopener noreferrer");

    // Book the florist: status, contracted amount and email in one save.
    await saveEdit(page, { status: "booked", contracted: "1.100.000", email: "Contratos@Gardenias.EXAMPLE" });
    await expect(page.getByTestId("vendor-detail-status")).toContainText(vendors.statuses.booked);
    await expect(page.getByTestId("vendor-detail-contracted")).toContainText(money(110_000_000, "CRC"));
    // Only the domain is lowercased.
    await expect(page.getByTestId("vendor-detail-email")).toContainText("Contratos@gardenias.example");

    await page.getByRole("link", { name: vendors.backToList }).click();
    await expect(page.getByRole("heading", { level: 1, name: vendors.title })).toBeVisible();

    // CRC and USD stay separate: never one combined total.
    await expect(page.getByTestId("vendor-summary-booked")).toHaveText("2 contratados");
    await expect(page.getByTestId("vendor-contracted-CRC")).toHaveText(money(110_000_000, "CRC"));
    await expect(page.getByTestId("vendor-contracted-USD")).toHaveText(money(350_000, "USD"));
    const summaryText = (await page.getByTestId("vendor-summary").innerText()).replace(/\s/g, " ");
    for (const mixed of [money(110_350_000, "CRC"), money(110_350_000, "USD"), money(120_000_000 + 110_000_000, "CRC")]) {
      expect(summaryText).not.toContain(mixed);
    }

    // Discard the photographer: still listed, muted, last in its group.
    await openVendor(page, "Estudio Luz");
    await saveEdit(page, { status: "discarded" });
    await page.getByRole("link", { name: vendors.backToList }).click();
    const discarded = card(page, "Estudio Luz");
    await expect(discarded).toHaveAttribute("data-status", "discarded");
    await expect(discarded.getByTestId("vendor-status")).toHaveText(vendors.statuses.discarded);
    await expect(discarded).toHaveClass(/opacity-70/);
    await expect(page.getByTestId("vendor-summary-discarded")).toHaveText("1 descartado");
    // A discarded contract no longer counts.
    await expect(page.getByTestId("vendor-contracted-USD")).toHaveCount(0);
    await expect(page.getByTestId("vendor-contracted-CRC")).toHaveText(money(110_000_000, "CRC"));

    // Delete one, explicitly, with confirmation.
    await openVendor(page, "Estudio Luz");
    await page.getByRole("button", { name: vendors.delete.open }).click();
    await expect(page.getByText(vendors.delete.confirmBody)).toBeVisible();
    await page.getByRole("button", { name: vendors.delete.cancel }).click();
    await expect(page.getByTestId("vendor-name")).toHaveText("Estudio Luz");
    await page.getByRole("button", { name: vendors.delete.open }).click();
    await page.getByRole("button", { name: vendors.delete.confirm }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/vendors$`));
    await expect(page.getByTestId("vendor-summary-total")).toHaveText("1 proveedor");
    await expect(card(page, "Estudio Luz")).toHaveCount(0);
  });

  test("field errors are shown per field and keep the typed values", async ({ page }) => {
    const email = await createAccount("vendor-errors");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda con errores de proveedor");
    await openVendors(page, weddingId);
    await page.getByText(vendors.create.open, { exact: true }).first().click();
    const region = createRegion(page);

    // "Otro" asks for the type; an amount needs a currency; malformed money is refused.
    await fillVendorForm(region, {
      name: "Seguridad Total",
      category: "other",
      status: "selected",
      currency: "",
      quoted: "1.2.3",
    });
    await region.getByRole("button", { name: vendors.create.submit }).click();
    await expect(region.getByText(vendors.validation.customCategoryRequired)).toBeVisible();
    await expect(region.getByText(vendors.validation.currencyRequired)).toBeVisible();
    await expect(region.getByText(vendors.validation.amountInvalid)).toBeVisible();
    const quoted = region.getByLabel(fields.quotedAmount);
    await expect(quoted).toHaveValue("1.2.3");
    await expect(quoted).toHaveAttribute("aria-invalid", "true");
    await expect(quoted).toHaveAttribute("aria-describedby", /new-vendor-quotedAmount-error/);
    // Every choice survives the error, selects included.
    await expect(region.getByLabel(fields.name, { exact: true })).toHaveValue("Seguridad Total");
    await expect(region.getByLabel(fields.category, { exact: true })).toHaveValue("other");
    await expect(region.getByLabel(fields.status, { exact: true })).toHaveValue("selected");

    await fillVendorForm(region, { customCategory: "Seguridad", currency: "CRC", quoted: "250000,50" });
    await region.getByRole("button", { name: vendors.create.submit }).click();
    await expect(region.getByRole("status")).toHaveText(vendors.create.created);
    const created = card(page, "Seguridad Total");
    await expect(created).toContainText("Seguridad");
    await expect(created.getByTestId("vendor-status")).toHaveText(vendors.statuses.selected);
    await expect(created.getByTestId("vendor-amount")).toHaveText(`Cotización: ${money(25_000_050, "CRC")}`);

    // The currency suggestion is a preselection only: no amount → no currency stored.
    await expect(region.getByLabel(fields.currency, { exact: true })).toHaveValue("CRC");
    await fillVendorForm(region, { name: "Sin monto", category: "music" });
    await region.getByRole("button", { name: vendors.create.submit }).click();
    await expect(region.getByRole("status")).toHaveText(vendors.create.created);
    const id = await openVendor(page, "Sin monto");
    const [row] = await db((client) =>
      client.query<{ currency: string | null }>("select currency from public.wedding_vendors where id = $1", [id]),
    ).then((r) => r.rows);
    expect(row).toEqual({ currency: null });
  });

  test("keyboard only: add, edit and delete a vendor", async ({ page }) => {
    const email = await createAccount("vendor-keyboard");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda con teclado");
    await openVendors(page, weddingId);

    const summary = page.locator("summary", { hasText: vendors.create.open });
    await summary.focus();
    await page.keyboard.press("Enter");
    const region = createRegion(page);
    await expect(region).toBeVisible();
    await region.getByLabel(fields.name, { exact: true }).focus();
    await page.keyboard.type("Banda Sonora");
    await page.keyboard.press("Tab");
    await expect(region.getByLabel(fields.category, { exact: true })).toBeFocused();
    await region.getByLabel(fields.category, { exact: true }).selectOption("music");
    await region.getByRole("button", { name: vendors.create.submit }).focus();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("status")).toHaveText(vendors.create.created);

    const link = page.getByRole("link", { name: "Ver Banda Sonora", exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("vendor-name")).toHaveText("Banda Sonora");

    await editRegion(page).getByLabel(fields.status, { exact: true }).selectOption("selected");
    await editRegion(page).getByRole("button", { name: vendors.edit.submit }).focus();
    await page.keyboard.press("Enter");
    await expect(editRegion(page).getByRole("status")).toHaveText(vendors.edit.saved);
    await expect(page.getByTestId("vendor-detail-status")).toContainText(vendors.statuses.selected);

    await page.getByRole("button", { name: vendors.delete.open }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: vendors.delete.confirm })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/vendors$`));
    await expect(page.getByTestId("vendors-empty")).toBeVisible();
  });
});

// ---------------------------------------------------------------- security

test.describe("vendor privacy", () => {
  test("another wedding's vendor is a 404; forged writes fail; public and RSVP pages carry no vendor data", async ({
    page,
    browser,
  }) => {
    // Wedding B and its vendor.
    const other = await freshPage(browser);
    const emailB = await createAccount("vendor-owner-b");
    await logIn(other.page, emailB);
    const weddingB = await createWedding(other.page, "Boda ajena");
    await openVendors(other.page, weddingB);
    await addVendor(other.page, { name: "Proveedor Ajeno", category: "venue", contactName: "Contacto Ajeno" });
    const vendorB = await openVendor(other.page, "Proveedor Ajeno");
    await other.context.close();

    // Wedding A.
    const emailA = await createAccount("vendor-owner-a");
    await logIn(page, emailA);
    const weddingA = await createWedding(page, "Boda propia", "2090-06-01");
    await openVendors(page, weddingA);
    await addVendor(page, {
      name: "Proveedor Secreto",
      category: "catering",
      contactName: "Contacto Secreto",
      email: "secreto@proveedor.example",
      phone: "8888-0000",
      notes: "Nota secreta",
      currency: "USD",
      contracted: "999",
      status: "booked",
    });
    const vendorA = await openVendor(page, "Proveedor Secreto");

    // Known foreign ids and malformed ids: the same 404.
    for (const path of [
      `/app/weddings/${weddingB}/vendors/${vendorB}`,
      `/app/weddings/${weddingB}/vendors`,
      `/app/weddings/${weddingA}/vendors/${vendorB}`,
      `/app/weddings/${weddingA}/vendors/not-a-uuid`,
      `/app/weddings/${weddingA}/vendors/00000000-0000-4000-8000-000000000000`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { level: 1, name: es.notFound.title })).toBeVisible();
      await expect(page.getByText("Proveedor Ajeno")).toHaveCount(0);
    }

    // Forged update: A's own form, B's vendor id.
    await page.goto(`/app/weddings/${weddingA}/vendors/${vendorA}`);
    const edit = editRegion(page);
    await edit.locator('input[name="vendorId"]').evaluate((input, id) => {
      (input as HTMLInputElement).value = id;
    }, vendorB);
    await edit.getByLabel(fields.name, { exact: true }).fill("Robado");
    await edit.getByRole("button", { name: vendors.edit.submit }).click();
    await expect(formAlert(page)).toHaveText(vendors.errors.notFound);

    // Forged delete: A's own confirmation, B's vendor id.
    await page.reload();
    await page.getByRole("button", { name: vendors.delete.open }).click();
    await page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: vendors.delete.confirm }) })
      .locator('input[name="vendorId"]')
      .evaluate((input, id) => {
        (input as HTMLInputElement).value = id;
      }, vendorB);
    await page.getByRole("button", { name: vendors.delete.confirm }).click();
    await expect(formAlert(page)).toHaveText(vendors.errors.notFound);

    // Forged wedding: B's wedding id with B's vendor → the 404 page.
    await page.reload();
    const forged = editRegion(page);
    await forged.locator('input[name="weddingId"]').evaluate((input, id) => {
      (input as HTMLInputElement).value = id;
    }, weddingB);
    await forged.locator('input[name="vendorId"]').evaluate((input, id) => {
      (input as HTMLInputElement).value = id;
    }, vendorB);
    await forged.getByRole("button", { name: vendors.edit.submit }).click();
    await expect(page.getByRole("heading", { level: 1, name: es.notFound.title })).toBeVisible();

    const rows = await db((client) =>
      client.query<{ name: string; wedding_id: string }>("select name, wedding_id from public.wedding_vendors where id = $1", [
        vendorB,
      ]),
    ).then((r) => r.rows);
    expect(rows).toEqual([{ name: "Proveedor Ajeno", wedding_id: weddingB }]);

    // Publish A's site and create a party, then look as a visitor and as a guest.
    await page.goto(`/app/weddings/${weddingA}/site`);
    const intro = page.locator('[data-testid="site-section"][data-kind="intro"]');
    await intro.getByLabel(site.sections.titleLabel).fill("Bienvenidos");
    await intro.getByLabel(site.sections.bodyLabel).fill("Nos casamos.");
    await intro.getByLabel(site.sections.visibleLabel).setChecked(true);
    await intro.getByRole("button", { name: site.sections.submit }).click();
    await expect(intro.getByRole("status")).toHaveText(site.sections.saved);
    const slug = `sitio-${Date.now().toString(36)}`;
    await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.saved)).toBeVisible();
    await page.getByRole("button", { name: site.publish.submit }).click();
    await expect(page.getByText(site.publish.done)).toBeVisible();

    await page.goto(`/app/weddings/${weddingA}/guests`);
    const newParty = page.getByRole("region", { name: guests.newParty.title });
    await newParty.getByLabel(guests.newParty.labelLabel).fill("Familia Prueba");
    await newParty.getByLabel(guests.newParty.namesLabel).fill("Ana Prueba");
    await newParty.getByRole("button", { name: guests.newParty.submit }).click();
    const linkField = newParty.getByTestId("guest-link");
    await expect(linkField).toBeVisible();
    const rsvpLink = await linkField.inputValue();
    expect(GUEST_LINK.test(rsvpLink), "guest link has the expected shape (value redacted)").toBe(true);

    const visitor = await freshPage(browser);
    try {
      const secrets = ["Proveedor Secreto", "Contacto Secreto", "secreto@proveedor", "8888-0000", "Nota secreta", vendorA];
      const publicPage = await visitor.page.goto(`/boda/${slug}`);
      expect(publicPage?.status()).toBe(200);
      await expect(visitor.page.getByText("Nos casamos.")).toBeVisible();
      const publicHtml = await visitor.page.content();
      for (const secret of secrets) expect(publicHtml).not.toContain(secret);
      expect(publicHtml.toLowerCase()).not.toContain("proveedor");

      await visitor.page.goto(rsvpLink);
      await expect(visitor.page.getByText("Ana Prueba")).toBeVisible();
      const rsvpHtml = await visitor.page.content();
      for (const secret of secrets) expect(rsvpHtml).not.toContain(secret);

      // anon can't enumerate vendors through the Data API.
      const { apiUrl, publishableKey } = readLocalSupabase();
      const response = await fetch(`${apiUrl}/rest/v1/wedding_vendors?select=*`, {
        headers: { apikey: publishableKey },
      });
      expect(response.ok).toBe(false);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("42501");
    } finally {
      await visitor.context.close();
    }
  });
});

// ------------------------------------------------------------------ mobile

test.describe("vendors on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("list, create, detail, edit and delete fit 390 px; 50 vendors filter instantly", async ({ page }) => {
    const email = await createAccount("vendor-mobile");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda en el teléfono");
    await openVendors(page, weddingId);
    await expectNoHorizontalOverflow(page);

    await addVendor(page, {
      name: "Hacienda Los Robles con un nombre bastante largo para un teléfono",
      category: "venue",
      status: "booked",
      contactName: "Coordinadora de eventos con nombre largo",
      email: "coordinacion.eventos.hacienda@los-robles-largo.example",
      phone: "+506 2222-3333",
      currency: "CRC",
      quoted: "12.500.000",
      contracted: "11.900.000",
    });
    await expectNoHorizontalOverflow(page);

    // Representative data: 50 vendors, seeded directly (fixtures only).
    await db(async (client) => {
      const owner = await client.query<{ created_by: string }>(
        "select user_id as created_by from public.wedding_memberships where wedding_id = $1 limit 1",
        [weddingId],
      );
      for (let i = 0; i < 49; i += 1) {
        await client.query(
          `insert into public.wedding_vendors (wedding_id, name, category, status, contact_name, currency, quoted_amount_minor, created_by)
           values ($1, $2, $3, $4, $5, 'USD', $6, $7)`,
          [
            weddingId,
            `Proveedor ${String(i).padStart(2, "0")}`,
            ["catering", "music", "photography", "rentals", "transport"][i % 5],
            ["considering", "quoted", "selected", "discarded"][i % 4],
            i === 7 ? "Íñigo Ramírez" : `Contacto ${i}`,
            (i + 1) * 10_000,
            owner.rows[0]!.created_by,
          ],
        );
      }
    });
    await page.reload();
    await expect(page.getByTestId("vendor-summary-total")).toHaveText("50 proveedores");
    await expect(page.getByTestId("vendor-card")).toHaveCount(50);
    await expectNoHorizontalOverflow(page);

    const search = filters(page).getByLabel(vendors.filters.search);
    const started = Date.now();
    await search.fill("inigo ramirez");
    await expect(page.getByTestId("vendor-card")).toHaveCount(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    await search.fill("");
    await filters(page).getByLabel(vendors.filters.status).selectOption("discarded");
    await expect(page.getByTestId("vendor-card")).toHaveCount(12);
    await filters(page).getByLabel(vendors.filters.status).selectOption("");

    const longName = "Hacienda Los Robles con un nombre bastante largo para un teléfono";
    await openVendor(page, longName);
    await expectNoHorizontalOverflow(page);
    await saveEdit(page, { phone: "+506 2222-4444" });
    await expect(page.getByTestId("vendor-detail-phone")).toContainText("+506 2222-4444");
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: vendors.delete.open }).click();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: vendors.delete.confirm }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/vendors$`));
    await expect(page.getByTestId("vendor-summary-total")).toHaveText("49 proveedores");
  });
});
