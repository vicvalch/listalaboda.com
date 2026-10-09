import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-23 (ADR-016): "Cronograma" — the wedding day's run of show. Wedding-
// relative wall-clock entries (the wedding day and its continuation after
// midnight), plain forms, one optional vendor per entry, derived
// "Ahora / Siguiente", basic print styles and privacy: none of it ever leaves
// the organizers' private pages. Names and contacts are fake fixtures.

const timeline = es.timeline;
const fields = timeline.fields;
const vendors = es.vendors;
const site = es.site;
const guests = es.guests;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;

type EntryFields = {
  title?: string;
  day?: "0" | "1";
  start?: string;
  hours?: string;
  minutes?: string;
  phase?: keyof typeof timeline.phases | "";
  location?: string;
  responsible?: string;
  vendor?: string;
  notes?: string;
};

async function openTimeline(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/timeline`);
  await expect(page.getByRole("heading", { level: 1, name: timeline.title })).toBeVisible();
}

function createRegion(page: Page): Locator {
  return page.getByRole("region", { name: timeline.create.title });
}

function row(page: Page, title: string): Locator {
  return page
    .getByTestId("timeline-entry")
    .filter({ has: page.getByTestId("timeline-entry-title").getByText(title, { exact: true }) });
}

function titlesIn(scope: Locator) {
  return scope.getByTestId("timeline-entry-title");
}

async function fillEntryForm(scope: Locator, entry: EntryFields) {
  if (entry.title !== undefined) await scope.getByLabel(fields.title, { exact: true }).fill(entry.title);
  if (entry.day !== undefined) await scope.getByLabel(fields.day, { exact: true }).selectOption(entry.day);
  if (entry.start !== undefined) await scope.getByLabel(fields.startTime, { exact: true }).fill(entry.start);
  if (entry.hours !== undefined) await scope.getByLabel(fields.durationHours, { exact: true }).fill(entry.hours);
  if (entry.minutes !== undefined) await scope.getByLabel(fields.durationMinutes, { exact: true }).fill(entry.minutes);
  if (entry.phase !== undefined) await scope.getByLabel(fields.phase, { exact: true }).selectOption(entry.phase);
  if (entry.location !== undefined) await scope.getByLabel(fields.location, { exact: true }).fill(entry.location);
  if (entry.responsible !== undefined) await scope.getByLabel(fields.responsible, { exact: true }).fill(entry.responsible);
  if (entry.vendor !== undefined) await scope.getByLabel(fields.vendor, { exact: true }).selectOption({ label: entry.vendor });
  if (entry.notes !== undefined) await scope.getByLabel(fields.notes, { exact: true }).fill(entry.notes);
}

async function openCreate(page: Page): Promise<Locator> {
  const region = createRegion(page);
  if (!(await region.isVisible())) await page.getByText(timeline.create.open, { exact: true }).first().click();
  await expect(region).toBeVisible();
  return region;
}

/**
 * Creates one entry and waits until the save has fully settled: the row is
 * shown and the form has remounted blank. The success message alone isn't
 * enough — it stays the same from one creation to the next.
 */
async function addEntry(page: Page, entry: EntryFields & { title: string }) {
  const region = await openCreate(page);
  const title = region.getByLabel(fields.title, { exact: true });
  const submit = region.getByRole("button", { name: timeline.create.submit });
  await expect(title).toHaveValue("");
  await expect(submit).toBeEnabled();
  await fillEntryForm(region, entry);
  await submit.click();
  await expect(row(page, entry.title)).toBeVisible();
  await expect(region.getByRole("status")).toHaveText(timeline.create.created);
  await expect(title).toHaveValue("");
  await expect(submit).toBeEnabled();
}

/** Edits an entry through its own "Editar" form; the row is tracked by id, so a new title or time is fine. */
async function editEntry(page: Page, title: string, change: EntryFields) {
  const id = await row(page, title).getAttribute("id");
  const target = page.locator(`[id="${id}"]`);
  const submit = target.getByRole("button", { name: timeline.edit.submit });
  // The disclosure stays open after a previous edit; clicking it again would close it.
  if (!(await submit.isVisible())) await target.getByText(timeline.row.edit, { exact: true }).click();
  const form = submit.locator("xpath=ancestor::form");
  await fillEntryForm(form, change);
  await form.getByRole("button", { name: timeline.edit.submit }).click();
  await expect(target.getByRole("status")).toHaveText(timeline.edit.saved);
}

async function addVendor(page: Page, weddingId: string, vendor: { name: string; category: string; contact?: string; phone?: string }) {
  await page.goto(`/app/weddings/${weddingId}/vendors`);
  const region = page.getByRole("region", { name: vendors.create.title });
  if (!(await region.isVisible())) await page.getByText(vendors.create.open, { exact: true }).first().click();
  await region.getByLabel(vendors.fields.name, { exact: true }).fill(vendor.name);
  await region.getByLabel(vendors.fields.category, { exact: true }).selectOption(vendor.category);
  if (vendor.contact) await region.getByLabel(vendors.fields.contactName).fill(vendor.contact);
  if (vendor.phone) await region.getByLabel(vendors.fields.phone).fill(vendor.phone);
  await region.getByRole("button", { name: vendors.create.submit }).click();
  await expect(region.getByRole("status")).toHaveText(vendors.create.created);
}

async function vendorIdByName(weddingId: string, name: string): Promise<string> {
  const rows = await db((c) =>
    c.query<{ id: string }>("select id from public.wedding_vendors where wedding_id = $1 and name = $2", [weddingId, name]),
  );
  return rows.rows[0]!.id;
}

async function setWeddingDateAndZone(page: Page, weddingId: string, date: string, zone: string | null) {
  await page.goto(`/app/weddings/${weddingId}/settings`);
  await page.getByLabel(es.weddingSettings.dateLabel).fill(date);
  await page.getByLabel(es.weddingNew.timeZoneLabel).selectOption(zone ?? "");
  await page.getByRole("button", { name: es.weddingSettings.submit }).click();
  await expect(page.getByText(es.wedding.settingsSaved)).toBeVisible();
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

async function entryRows(weddingId: string) {
  return db((c) =>
    c.query<{ title: string; day_offset: number; start_time: string | null; updated_at: Date }>(
      "select title, day_offset, start_time::text, updated_at from public.wedding_timeline_entries where wedding_id = $1 order by id",
      [weddingId],
    ),
  ).then((r) => r.rows);
}

// ---------------------------------------------------------------- journey

test.describe("cronograma", () => {
  test("build a run of show: days, midnight, ties, Sin hora, vendor, edits, date change, delete", async ({ page }) => {
    // 1–5. Account, wedding, date and time zone, open Cronograma.
    await logIn(page, await createAccount("timeline-owner"));
    const weddingId = await createWedding(page, "Boda del cronograma", "2027-08-14");
    await addVendor(page, weddingId, {
      name: "Studio Luz",
      category: "photography",
      contact: "Laura Fotos",
      phone: "+506 8888-1234",
    });
    await setWeddingDateAndZone(page, weddingId, "2027-08-14", "America/Costa_Rica");
    await page.getByRole("link", { name: timeline.navLink }).click();
    await expect(page.getByRole("heading", { level: 1, name: timeline.title })).toBeVisible();

    // The nav order: Presupuesto, Cronograma, Sitio web.
    await page.goto(`/app/weddings/${weddingId}`);
    const nav = await page.getByRole("link").allTextContents();
    expect(nav.indexOf(timeline.navLink)).toBe(nav.indexOf(es.budget.navLink) + 1);
    expect(nav.indexOf(es.site.navLink)).toBe(nav.indexOf(timeline.navLink) + 1);

    // 6. Empty state, create form open, print affordance present.
    await openTimeline(page, weddingId);
    await expect(page.getByTestId("timeline-empty")).toContainText(timeline.empty.title);
    await expect(page.getByTestId("timeline-empty")).toContainText(timeline.empty.body);
    await expect(page.getByRole("button", { name: timeline.print })).toBeVisible();
    await openCreate(page);
    await expect(page.getByLabel(fields.day, { exact: true })).toHaveAccessibleDescription(fields.dayHint);

    // 7–12. The day, out of order on purpose.
    await addEntry(page, {
      title: "Peinado y maquillaje",
      day: "0",
      start: "07:00",
      hours: "2",
      minutes: "0",
      phase: "getting_ready",
      location: "Hotel · Suite 405",
      responsible: "Mariana",
    });
    await addEntry(page, { title: "Desmontaje", day: "1", start: "00:30", phase: "closing" });
    await addEntry(page, { title: "Ceremonia", start: "15:30", minutes: "45", phase: "ceremony", location: "Jardín" });
    await addEntry(page, { title: "Llega fotógrafo", start: "09:30" });
    await addEntry(page, { title: "Fotos familiares", start: "16:15", minutes: "45", phase: "photos" });
    await addEntry(page, { title: "Última ronda", start: "23:45", hours: "1", phase: "reception" });

    // 13. Headers from the wedding date; day 1 says "después de medianoche".
    // (The first letter is capitalized by CSS only.)
    await expect(page.getByTestId("timeline-wedding-date")).toHaveText("sábado, 14 de agosto de 2027");
    const day0 = page.getByTestId("timeline-day-0");
    const day1 = page.getByTestId("timeline-day-1");
    await expect(day0.getByRole("heading", { level: 2 })).toHaveText("sábado, 14 de agosto de 2027");
    await expect(day1.getByRole("heading", { level: 2 })).toHaveText(`domingo, 15 de agosto de 2027 · ${timeline.days.afterMidnight}`);

    // 14–15. Chronological, and the after-midnight continuation comes last.
    await expect(titlesIn(day0)).toHaveText([
      "Peinado y maquillaje",
      "Llega fotógrafo",
      "Ceremonia",
      "Fotos familiares",
      "Última ronda",
    ]);
    await expect(titlesIn(day1)).toHaveText(["Desmontaje"]);
    await expect(row(page, "Ceremonia").getByTestId("timeline-entry-time")).toHaveText("15:30–16:15");
    await expect(row(page, "Ceremonia").getByTestId("timeline-entry-duration")).toHaveText("45 min");
    await expect(row(page, "Última ronda").getByTestId("timeline-entry-time")).toHaveText("23:45–00:45");
    await expect(row(page, "Última ronda").getByTestId("timeline-entry-duration")).toHaveText(
      `1 h · ${timeline.row.nextDayEnd}`,
    );
    await expect(row(page, "Llega fotógrafo").getByTestId("timeline-entry-time")).toHaveText("09:30");
    await expect(row(page, "Peinado y maquillaje").getByTestId("timeline-entry-phase")).toHaveText("Preparación");
    await expect(page.getByTestId("timeline-overview")).toHaveText(
      `6 actividades · de 07:00 a 00:30 (${timeline.days.afterMidnight})`,
    );

    // 16–17. Three simultaneous entries (overlaps are fine) keep the database's creation order,
    // (created_at, id), and keep it across reloads. The tie order is read from the database rather
    // than assumed from the loop: the local Docker clock can step backwards (WSL time sync), so
    // created_at isn't guaranteed to follow submission order here.
    const ties = ["Llega la floristería", "Prueba de sonido del DJ", "Fotos de detalles"];
    for (const title of ties) await addEntry(page, { title, start: "14:00", hours: "1" });
    const tieOrder = await db((c) =>
      c.query<{ title: string }>(
        "select title from public.wedding_timeline_entries where wedding_id = $1 and start_time = '14:00' order by created_at, id",
        [weddingId],
      ),
    ).then((r) => r.rows.map((x) => x.title));
    expect([...tieOrder].sort()).toEqual([...ties].sort());
    const expectedDay0 = [
      "Peinado y maquillaje",
      "Llega fotógrafo",
      ...tieOrder,
      "Ceremonia",
      "Fotos familiares",
      "Última ronda",
    ];
    await expect(titlesIn(day0)).toHaveText(expectedDay0);
    await page.reload();
    await expect(titlesIn(page.getByTestId("timeline-day-0"))).toHaveText(expectedDay0);

    // 18–19. No time yet: "Sin hora", after the timed days, never mixed in.
    await addEntry(page, { title: "Llega el pastel", minutes: "30" });
    const untimed = page.getByTestId("timeline-untimed");
    await expect(titlesIn(untimed)).toHaveText(["Llega el pastel"]);
    await expect(row(page, "Llega el pastel").getByTestId("timeline-entry-duration")).toHaveText(
      `30 min · ${timeline.row.timeTbd}`,
    );
    await expect(titlesIn(day0)).not.toContainText(["Llega el pastel"]);
    const order = await page.locator('[data-testid^="timeline-day-"], [data-testid="timeline-untimed"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid")),
    );
    expect(order).toEqual(["timeline-day-0", "timeline-day-1", "timeline-untimed"]);

    // 20–21. Link a vendor: name, contact and a tel: link (no email, no money).
    await editEntry(page, "Llega fotógrafo", { vendor: "Studio Luz · Fotografía" });
    const vendorLine = row(page, "Llega fotógrafo").getByTestId("timeline-entry-vendor");
    await expect(vendorLine).toContainText("Studio Luz");
    await expect(vendorLine).toContainText("Laura Fotos");
    await expect(vendorLine.getByRole("link", { name: "Llamar a Laura Fotos" })).toHaveAttribute("href", "tel:+50688881234");

    // 22–24. Edit location, responsible and notes (multiline, plain text).
    await editEntry(page, "Ceremonia", {
      location: "Jardín principal",
      responsible: "Coordinadora del lugar",
      notes: "Entrada por proveedores.\nLlevar los anillos.",
    });
    const ceremony = row(page, "Ceremonia");
    await expect(ceremony.getByTestId("timeline-entry-location")).toHaveText("Jardín principal");
    await expect(ceremony.getByTestId("timeline-entry-responsible")).toHaveText("Coordinadora del lugar");
    await ceremony.locator("summary", { hasText: timeline.row.notes }).click();
    await expect(ceremony.getByTestId("timeline-entry-notes")).toHaveText("Entrada por proveedores.\nLlevar los anillos.");

    // 25. Edit a time: the row re-sorts.
    await editEntry(page, "Llega fotógrafo", { start: "06:30" });
    await expect(titlesIn(page.getByTestId("timeline-day-0")).first()).toHaveText("Llega fotógrafo");

    // 26–27. Move the wedding: headers follow, no row is written.
    const before = await entryRows(weddingId);
    await setWeddingDateAndZone(page, weddingId, "2027-09-04", "America/Costa_Rica");
    await openTimeline(page, weddingId);
    await expect(page.getByTestId("timeline-day-0").getByRole("heading", { level: 2 })).toHaveText(
      "sábado, 4 de septiembre de 2027",
    );
    await expect(page.getByTestId("timeline-day-1").getByRole("heading", { level: 2 })).toHaveText(
      `domingo, 5 de septiembre de 2027 · ${timeline.days.afterMidnight}`,
    );
    expect(await entryRows(weddingId)).toEqual(before);

    // 28–29. Delete one entry; the vendor isn't touched.
    const photographer = row(page, "Llega fotógrafo");
    await photographer.getByRole("button", { name: `Eliminar actividad «Llega fotógrafo»` }).click();
    await expect(photographer.getByText(timeline.delete.confirmBody)).toBeVisible();
    await photographer.getByRole("button", { name: timeline.delete.confirm }).click();
    await expect(row(page, "Llega fotógrafo")).toHaveCount(0);
    expect(await db((c) => c.query("select 1 from public.wedding_vendors where wedding_id = $1", [weddingId])).then((r) => r.rowCount)).toBe(1);

    // 30. Print: chrome, forms and controls hidden; content and notes stay.
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("button", { name: timeline.print })).toBeHidden();
    await expect(page.getByRole("banner")).toBeHidden();
    await expect(page.getByText(timeline.create.open, { exact: true }).first()).toBeHidden();
    await expect(row(page, "Ceremonia").getByText(timeline.row.edit, { exact: true })).toBeHidden();
    await expect(page.getByText("Boda del cronograma")).toBeVisible();
    await expect(page.getByTestId("timeline-wedding-date")).toBeVisible();
    await expect(row(page, "Ceremonia").getByTestId("timeline-entry-notes-print")).toBeVisible();
    await expect(row(page, "Ceremonia").getByTestId("timeline-entry-notes-print")).toContainText("Llevar los anillos.");
    await expect(page.getByTestId("timeline-day-1").getByRole("heading", { level: 2 })).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });

  test("deleting a linked vendor unlinks the entry; a vendor with payments stays protected", async ({ page }) => {
    await logIn(page, await createAccount("timeline-vendor-delete"));
    const weddingId = await createWedding(page, "Boda sin proveedor", "2027-08-14");
    await addVendor(page, weddingId, { name: "DJ Temporal", category: "music", contact: "Pablo", phone: "8777-6655" });
    await openTimeline(page, weddingId);
    await addEntry(page, { title: "Llega el DJ", start: "14:00", location: "Salón principal", vendor: "DJ Temporal · Música" });
    await expect(row(page, "Llega el DJ").getByTestId("timeline-entry-vendor")).toContainText("DJ Temporal");

    // Delete the vendor (no financial records): the entry survives, unlinked.
    const vendorId = await vendorIdByName(weddingId, "DJ Temporal");
    await page.goto(`/app/weddings/${weddingId}/vendors/${vendorId}`);
    await page.getByRole("button", { name: vendors.delete.open }).click();
    await page.getByRole("button", { name: vendors.delete.confirm }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/vendors$`));

    const response = await page.goto(`/app/weddings/${weddingId}/timeline`);
    expect(response?.status()).toBe(200);
    const entry = row(page, "Llega el DJ");
    await expect(entry.getByTestId("timeline-entry-time")).toHaveText("14:00");
    await expect(entry.getByTestId("timeline-entry-location")).toHaveText("Salón principal");
    await expect(entry.getByTestId("timeline-entry-vendor")).toHaveCount(0);
    await expect(page.getByText("DJ Temporal")).toHaveCount(0);

    // A vendor with a payment can't be deleted (LB-22), timeline link or not.
    await addVendor(page, weddingId, { name: "Banda Pagada", category: "music" });
    const paidId = await vendorIdByName(weddingId, "Banda Pagada");
    await db(async (c) => {
      await c.query(
        "update public.wedding_vendors set status = 'booked', currency = 'USD', contracted_amount_minor = 100000 where id = $1",
        [paidId],
      );
      await c.query(
        "insert into public.vendor_payments (wedding_id, wedding_vendor_id, amount_minor, paid_on) values ($1, $2, 1000, '2026-10-01')",
        [weddingId, paidId],
      );
    });
    await openTimeline(page, weddingId);
    await editEntry(page, "Llega el DJ", { vendor: "Banda Pagada · Música" });
    await page.goto(`/app/weddings/${weddingId}/vendors/${paidId}`);
    await expect(page.getByText(vendors.deleteBlocked)).toBeVisible();
    expect(await db((c) => c.query("select 1 from public.wedding_vendors where id = $1", [paidId])).then((r) => r.rowCount)).toBe(1);
  });

  test("a vendor of another wedding can't be linked, even through a forged form", async ({ page, browser }) => {
    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("timeline-owner-b"));
    const weddingB = await createWedding(other.page, "Boda ajena del cronograma");
    await addVendor(other.page, weddingB, { name: "Proveedor Ajeno", category: "venue" });
    const vendorB = await vendorIdByName(weddingB, "Proveedor Ajeno");
    await other.context.close();

    await logIn(page, await createAccount("timeline-owner-a"));
    const weddingA = await createWedding(page, "Boda propia del cronograma");
    await openTimeline(page, weddingA);
    await addEntry(page, { title: "Llega la banda", start: "18:00" });

    // Forged create: A's form, B's vendor id injected as an option.
    const region = await openCreate(page);
    await fillEntryForm(region, { title: "Robo de proveedor", start: "19:00" });
    await region.getByLabel(fields.vendor, { exact: true }).evaluate((select, id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = "Ajeno";
      (select as HTMLSelectElement).append(option);
      (select as HTMLSelectElement).value = id;
    }, vendorB);
    await region.getByRole("button", { name: timeline.create.submit }).click();
    await expect(region.getByText(timeline.errors.invalidVendor)).toBeVisible();

    // Forged update of an existing entry.
    const target = row(page, "Llega la banda");
    await target.getByText(timeline.row.edit, { exact: true }).click();
    const form = target.getByRole("button", { name: timeline.edit.submit }).locator("xpath=ancestor::form");
    await form.getByLabel(fields.vendor, { exact: true }).evaluate((select, id) => {
      const option = document.createElement("option");
      option.value = id;
      (select as HTMLSelectElement).append(option);
      (select as HTMLSelectElement).value = id;
    }, vendorB);
    await form.getByLabel(fields.title, { exact: true }).fill("Cambiado");
    await form.getByRole("button", { name: timeline.edit.submit }).click();
    await expect(form.getByText(timeline.errors.invalidVendor)).toBeVisible();

    const rows = await db((c) =>
      c.query<{ title: string; wedding_vendor_id: string | null }>(
        "select title, wedding_vendor_id from public.wedding_timeline_entries where wedding_id = $1",
        [weddingA],
      ),
    ).then((r) => r.rows);
    expect(rows).toEqual([{ title: "Llega la banda", wedding_vendor_id: null }]);

    // Another wedding's timeline is a 404.
    for (const path of [`/app/weddings/${weddingB}/timeline`, `/app/weddings/not-a-uuid/timeline`]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });

  test("the window: nothing may end after midnight following the next day", async ({ page }) => {
    await logIn(page, await createAccount("timeline-window"));
    const weddingId = await createWedding(page, "Boda de la ventana", "2027-08-14");
    await openTimeline(page, weddingId);

    const region = await openCreate(page);
    await fillEntryForm(region, { title: "Fiesta eterna", day: "1", start: "23:30", hours: "2", minutes: "0" });
    await region.getByRole("button", { name: timeline.create.submit }).click();
    const durationHours = region.getByLabel(fields.durationHours, { exact: true });
    await expect(durationHours).toHaveAttribute("aria-invalid", "true");
    await expect(region.getByText(timeline.validation.endOutsideWindow)).toBeVisible();
    // Typed values are kept; nothing was written or clipped.
    await expect(region.getByLabel(fields.title, { exact: true })).toHaveValue("Fiesta eterna");
    expect(await entryRows(weddingId)).toEqual([]);

    await fillEntryForm(region, { hours: "0", minutes: "30" });
    await region.getByRole("button", { name: timeline.create.submit }).click();
    await expect(region.getByRole("status")).toHaveText(timeline.create.created);
    await expect(row(page, "Fiesta eterna").getByTestId("timeline-entry-time")).toHaveText("23:30–24:00");

    // Invalid inputs are refused with field messages.
    await fillEntryForm(region, { title: "Mala hora", day: "0", start: "", hours: "0", minutes: "0" });
    await region.getByRole("button", { name: timeline.create.submit }).click();
    await expect(region.getByText(timeline.validation.durationZero)).toBeVisible();
  });

  test("without a time zone everything works but there is no Ahora / Siguiente", async ({ page }) => {
    await logIn(page, await createAccount("timeline-no-zone"));
    const today = new Date().toISOString().slice(0, 10);
    const weddingId = await createWedding(page, "Boda sin zona", today);
    await openTimeline(page, weddingId);
    await addEntry(page, { title: "Todo el día", start: "00:00", hours: "24" });
    await expect(row(page, "Todo el día").getByTestId("timeline-entry-time")).toHaveText("00:00–24:00");
    await expect(page.getByTestId("timeline-now")).toHaveCount(0);
    await expect(page.getByTestId("timeline-no-time-zone")).toHaveText(timeline.noTimeZoneHint);
    await editEntry(page, "Todo el día", { title: "Todo el día editado" });
    await expect(row(page, "Todo el día editado")).toBeVisible();
  });

  test("on the wedding day, Ahora uses the wedding's time zone (day 0 or its continuation)", async ({ page }) => {
    // Real clock, made deterministic: the wedding is "today" in UTC and two
    // entries cover the whole of day 0 and day 1, so whichever of those days
    // the page loads on, something is current. Exact current/next logic is
    // covered with fixed instants in src/test/timeline-summary.test.ts.
    await logIn(page, await createAccount("timeline-now"));
    const today = new Date().toISOString().slice(0, 10);
    const weddingId = await createWedding(page, "Boda de hoy", today);
    await db((c) => c.query("update public.weddings set time_zone = 'UTC' where id = $1", [weddingId]));
    await openTimeline(page, weddingId);
    await addEntry(page, { title: "Todo el día de la boda", day: "0", start: "00:00", hours: "24" });
    await addEntry(page, { title: "Todo el día siguiente", day: "1", start: "00:00", hours: "24" });
    await addEntry(page, { title: "También todo el día", day: "0", start: "00:00", hours: "24" });
    await page.reload();
    const now = page.getByTestId("timeline-now");
    await expect(now).toBeVisible();
    const current = await now.getByTestId("timeline-now-current").getByRole("link").allTextContents();
    expect(
      current.join("|") === "Todo el día de la boda|También todo el día" || current.join("|") === "Todo el día siguiente",
      current.join("|"),
    ).toBe(true);
    await expect(page.locator('[data-testid="timeline-entry"][data-current="true"]')).toHaveCount(current.length);
    await expect(now).toContainText(timeline.now.asOf.split("(")[0]!.trim());

    // Months away: no panel at all.
    await db((c) => c.query("update public.weddings set wedding_date = wedding_date + 90 where id = $1", [weddingId]));
    await page.reload();
    await expect(page.getByTestId("timeline-now")).toHaveCount(0);
  });

  test("the published site and the RSVP page carry no timeline data", async ({ page, browser }) => {
    await logIn(page, await createAccount("timeline-privacy"));
    const weddingId = await createWedding(page, "Boda privada del cronograma", "2090-06-01");
    await addVendor(page, weddingId, { name: "Proveedor del Cronograma", category: "music", phone: "8111-2233" });
    await openTimeline(page, weddingId);
    await addEntry(page, {
      title: "Actividad Secreta del Cronograma",
      start: "15:00",
      location: "Bodega secreta",
      notes: "Nota secreta del cronograma",
      vendor: "Proveedor del Cronograma · Música",
    });

    await page.goto(`/app/weddings/${weddingId}/site`);
    const schedule = page.locator('[data-testid="site-section"][data-kind="schedule"]');
    await schedule.getByLabel(site.sections.titleLabel).fill("Programa");
    await schedule.getByLabel(site.sections.bodyLabel).fill("Ceremonia a las 3 p. m.");
    await schedule.getByLabel(site.sections.visibleLabel).setChecked(true);
    await schedule.getByRole("button", { name: site.sections.submit }).click();
    await expect(schedule.getByRole("status")).toHaveText(site.sections.saved);
    const slug = `cronograma-${Date.now().toString(36)}`;
    await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.saved)).toBeVisible();
    await page.getByRole("button", { name: site.publish.submit }).click();
    await expect(page.getByText(site.publish.done)).toBeVisible();

    await page.goto(`/app/weddings/${weddingId}/guests`);
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
      const secrets = ["Actividad Secreta", "Bodega secreta", "Nota secreta", "8111-2233", "Proveedor del Cronograma"];
      const publicPage = await visitor.page.goto(`/boda/${slug}`);
      expect(publicPage?.status()).toBe(200);
      await expect(visitor.page.getByText("Ceremonia a las 3 p. m.")).toBeVisible();
      const publicHtml = await visitor.page.content();
      for (const secret of secrets) expect(publicHtml).not.toContain(secret);
      expect(publicHtml).not.toContain(timeline.title);

      await visitor.page.goto(rsvpLink);
      await expect(visitor.page.getByText("Ana Prueba")).toBeVisible();
      const rsvpHtml = await visitor.page.content();
      for (const secret of secrets) expect(rsvpHtml).not.toContain(secret);

      // A signed-out visitor never reaches the private page.
      await visitor.page.goto(`/app/weddings/${weddingId}/timeline`);
      await expect(visitor.page).toHaveURL(/\/login/);

      // anon can't read the table through the Data API.
      const { apiUrl, publishableKey } = readLocalSupabase();
      const response = await fetch(`${apiUrl}/rest/v1/wedding_timeline_entries?select=*`, {
        headers: { apikey: publishableKey },
      });
      expect(response.ok).toBe(false);
      expect(((await response.json()) as { code?: string }).code).toBe("42501");
    } finally {
      await visitor.context.close();
    }
  });
});

// ------------------------------------------------------------------ mobile

test.describe("cronograma on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("rows, create, edit, duration and tel: links fit 390 px", async ({ page }) => {
    await logIn(page, await createAccount("timeline-mobile"));
    const weddingId = await createWedding(page, "Boda en el teléfono", "2027-08-14");
    await addVendor(page, weddingId, {
      name: "Floristería con un nombre bastante largo para un teléfono",
      category: "flowers_decor",
      contact: "Coordinadora de flores con nombre largo",
      phone: "+506 8888-0000",
    });
    await openTimeline(page, weddingId);
    await expectNoHorizontalOverflow(page);

    await addEntry(page, {
      title: "Llega la floristería con todos los arreglos del salón principal y la iglesia",
      start: "11:00",
      hours: "1",
      minutes: "30",
      phase: "setup",
      location: "Entrada de proveedores por el estacionamiento trasero del hotel",
      responsible: "Coordinadora del lugar con un nombre también largo",
      vendor: "Floristería con un nombre bastante largo para un teléfono · Flores y decoración",
      notes: `Una nota muy larga sin espacios: ${"x".repeat(200)}\nY otra línea.`,
    });
    const target = row(page, "Llega la floristería con todos los arreglos del salón principal y la iglesia");
    await expect(target.getByTestId("timeline-entry-time")).toHaveText("11:00–12:30");
    await expect(target.getByTestId("timeline-entry-duration")).toHaveText("1 h 30 min");
    await expect(target.getByRole("link", { name: /Llamar a/ })).toHaveAttribute("href", "tel:+50688880000");
    await target.locator("summary", { hasText: timeline.row.notes }).click();
    await expect(target.getByTestId("timeline-entry-notes")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await editEntry(page, "Llega la floristería con todos los arreglos del salón principal y la iglesia", {
      hours: "2",
      minutes: "0",
    });
    await expect(target.getByTestId("timeline-entry-duration")).toHaveText("2 h");
    await expectNoHorizontalOverflow(page);
  });
});
