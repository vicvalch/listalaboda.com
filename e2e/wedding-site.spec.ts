import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createInvite, es, formAlert, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-10: the wedding website. Private editor ("Sitio web"), explicit
// owner-only publication at /boda/<slug>, the public page's privacy, and
// the RSVP page's published context. Names are generic fake fixtures.

const site = es.site;
const publicCopy = es.publicSite;
const rsvp = es.rsvp;
const WEDDING_PATH = /\/app\/weddings\/([0-9a-f-]{36})(?:\?.*)?$/;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;

function uniqueSlug(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Creates a wedding with date, city and time zone through the real form. */
async function createFullWedding(page: Page, name: string): Promise<string> {
  await page.goto("/app/weddings/new");
  await page.getByLabel(es.weddingNew.nameLabel).fill(name);
  await page.getByLabel(es.weddingNew.dateLabel).fill("2090-06-01");
  await page.getByLabel(es.weddingNew.cityLabel).fill("Ciudad de Prueba");
  await page.getByLabel(es.weddingNew.timeZoneLabel).selectOption("America/Costa_Rica");
  await page.getByRole("button", { name: es.weddingNew.submit }).click();
  await expect(page).toHaveURL(WEDDING_PATH);
  const match = WEDDING_PATH.exec(page.url());
  if (!match) throw new Error("wedding id not found in URL");
  return match[1];
}

async function openSite(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/site`);
  await expect(page.getByRole("heading", { level: 1, name: site.title })).toBeVisible();
}

function sectionCard(page: Page, kind: keyof typeof site.kinds): Locator {
  return page.locator(`[data-testid="site-section"][data-kind="${kind}"]`);
}

async function saveSection(
  page: Page,
  kind: keyof typeof site.kinds,
  fields: { title?: string; body?: string; visible?: boolean },
) {
  const card = sectionCard(page, kind);
  if (fields.title !== undefined) await card.getByLabel(site.sections.titleLabel).fill(fields.title);
  if (fields.body !== undefined) await card.getByLabel(site.sections.bodyLabel).fill(fields.body);
  if (fields.visible !== undefined) await card.getByLabel(site.sections.visibleLabel).setChecked(fields.visible);
  await card.getByRole("button", { name: site.sections.submit }).click();
  await expect(card.getByRole("status")).toHaveText(site.sections.saved);
  if (fields.visible !== undefined) {
    await expect(card.getByTestId("site-section-visibility")).toHaveText(
      fields.visible ? site.sections.shown : site.sections.hidden,
    );
  }
}

async function saveSlug(page: Page, slug: string, { confirm = false } = {}) {
  await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
  await page.getByRole("button", { name: site.slug.submit }).click();
  if (confirm) {
    await expect(page.getByText(site.slug.changeBody)).toBeVisible();
    await page.getByRole("button", { name: site.slug.changeConfirm }).click();
  }
  await expect(page.getByText(site.slug.saved)).toBeVisible();
  // The saved address is what the page shows once the change is stored.
  await expect(page.getByTestId("site-public-url")).toHaveText(new RegExp(`/boda/${slug}$`));
}

async function publishSite(page: Page) {
  await page.getByRole("button", { name: site.publish.submit }).click();
  await expect(page.getByText(site.publish.done)).toBeVisible();
  await expect(page.getByTestId("site-status")).toContainText(site.status.published);
}

async function unpublishSite(page: Page) {
  await page.getByRole("button", { name: site.unpublish.open }).click();
  await expect(page.getByText(site.unpublish.confirmBody)).toBeVisible();
  await page.getByRole("button", { name: site.unpublish.confirmButton }).click();
  await expect(page.getByText(site.unpublish.done)).toBeVisible();
  await expect(page.getByTestId("site-status")).toContainText(site.status.unpublished);
}

async function expectPublicNotFound(page: Page, slug: string) {
  const response = await page.goto(`/boda/${slug}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: es.notFound.title })).toBeVisible();
  await expect(page.getByTestId("public-site")).toHaveCount(0);
}

function publicSections(page: Page) {
  return page.getByTestId("public-site-section");
}

async function publication(weddingId: string) {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ slug: string; published: boolean }>(
      "select slug, published_at is not null as published from public.wedding_publications where wedding_id = $1",
      [weddingId],
    );
    return rows[0] ?? null;
  } finally {
    await db.end();
  }
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

type CapturedAction = { url: string; headers: Record<string, string>; body: Buffer };

/**
 * Captures the Server Action request a UI step sends, WITHOUT letting it
 * reach the server (the request is aborted). Used to forge an owner-only
 * action: the exact same request, replayed with another user's session.
 */
async function captureAction(page: Page, trigger: () => Promise<void>): Promise<CapturedAction> {
  let captured: CapturedAction | null = null;
  await page.route("**/app/weddings/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      captured = { url: request.url(), headers: request.headers(), body: request.postDataBuffer() ?? Buffer.from("") };
      await route.abort();
      return;
    }
    await route.continue();
  });
  await trigger();
  await expect.poll(() => captured !== null).toBe(true);
  await page.unroute("**/app/weddings/**");
  if (!captured) throw new Error("no action captured");
  return captured;
}

/** Replays a captured action as the user signed in on `page`. */
async function replayAction(page: Page, action: CapturedAction): Promise<string> {
  const response = await page.request.post(action.url, {
    headers: {
      "next-action": action.headers["next-action"],
      "content-type": action.headers["content-type"],
      accept: "text/x-component",
      origin: new URL(action.url).origin,
    },
    data: action.body,
  });
  return response.text();
}

test.describe("wedding website", () => {
  test("A, B, E, F, L, M: private by default, explicit publish, a public page with only safe content", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb10-owner"));
    const weddingId = await createFullWedding(page, "Boda de prueba Sitio");
    const slug = uniqueSlug("boda-prueba-sitio");
    const visitor = await freshPage(browser);

    // The checklist stays home; "Sitio web" is a secondary link.
    await expect(page.getByRole("heading", { name: es.checklist.title })).toBeVisible();
    await page.getByRole("link", { name: site.navLink }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/site$`));
    await expect(page.getByTestId("site-status")).toContainText(site.status.unpublished);
    await expect(page.getByTestId("site-section")).toHaveCount(7);
    // A suggestion is prefilled but not saved.
    await expect(page.getByLabel(site.slug.label, { exact: true })).toHaveValue("boda-de-prueba-sitio");
    expect(await publication(weddingId)).toBeNull();

    // B: content, including text that looks like HTML.
    await saveSection(page, "intro", { body: "Los esperamos con mucha alegría.\nGracias por acompañarnos.", visible: true });
    await saveSection(page, "ceremony", { title: "La ceremonia", body: "A las 16:00 en el jardín.", visible: true });
    await saveSection(page, "dress_code", { body: "Formal de día.", visible: true });
    await saveSection(page, "faq", {
      body: '¿Puedo llevar niños?\nSí.\n<script>window.__xss = 1</script><img src=x onerror="window.__xss=2"> <b>no negrita</b>',
      visible: true,
    });
    await saveSection(page, "schedule", { body: "Contenido oculto del programa", visible: false });
    await saveSection(page, "rsvp", { visible: true });
    // A visible section needs content.
    await saveSectionExpectingError(page, "reception", site.validation.visibleNeedsBody);

    // A: nothing is public before publishing, even with a slug and content.
    await expectPublicNotFound(visitor.page, slug);
    await page.getByRole("button", { name: site.publish.submit }).click();
    await expect(formAlert(page)).toHaveText(site.publish.needsSlug);
    await saveSlug(page, slug);
    await expect(page.getByTestId("site-public-url")).toHaveText(`http://localhost:3100/boda/${slug}`);
    await expectPublicNotFound(visitor.page, slug);
    expect(await publication(weddingId)).toEqual({ slug, published: false });

    // Slug validation, before any round-trip to the database.
    await page.getByLabel(site.slug.label, { exact: true }).fill("Ana y Luis");
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.validation.invalid)).toBeVisible();
    await page.getByLabel(site.slug.label, { exact: true }).fill("rsvp");
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.validation.reserved)).toBeVisible();
    await page.reload();

    // E: publish.
    await publishSite(page);
    await expect(page.getByTestId("site-live-edits")).toHaveText(site.status.publishedNote);
    await expect(page.getByRole("link", { name: site.status.open })).toHaveAttribute("href", `/boda/${slug}`);

    // F: the anonymous public page.
    let xssDialog = false;
    visitor.page.on("dialog", (dialog) => {
      xssDialog = true;
      void dialog.dismiss();
    });
    const response = await visitor.page.goto(`/boda/${slug}`);
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(visitor.page).toHaveTitle("Boda de prueba Sitio");
    await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText("Boda de prueba Sitio");
    await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(visitor.page.getByTestId("public-site-details")).toHaveText("1 de junio de 2090 · Ciudad de Prueba");
    await expect(visitor.page.getByRole("heading", { level: 2 })).toHaveText([
      "Bienvenidos",
      "La ceremonia",
      "Código de vestimenta",
      "Preguntas frecuentes",
      "Confirmación de asistencia",
    ]);
    await expect(visitor.page.getByRole("region", { name: "Bienvenidos" })).toContainText(
      "Los esperamos con mucha alegría.",
    );
    // L/XSS: user text is text — shown literally, never executed or parsed.
    const faq = visitor.page.getByRole("region", { name: "Preguntas frecuentes" });
    await expect(faq).toContainText("<script>window.__xss = 1</script>");
    await expect(faq).toContainText("<b>no negrita</b>");
    await expect(faq.locator("script, img, b")).toHaveCount(0);
    expect(await visitor.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(xssDialog).toBe(false);
    // Line breaks are kept.
    expect(await faq.locator("p").evaluate((p) => getComputedStyle(p).whiteSpace)).toBe("pre-line");

    // M: the RSVP section is guidance, not an RSVP: no form, no inputs, no guest data.
    await expect(
      visitor.page.getByRole("region", { name: "Confirmación de asistencia" }).locator("p"),
    ).toHaveText(publicCopy.rsvpDefault);
    await expect(visitor.page.locator("form, input, textarea, select, button")).toHaveCount(0);
    await expect(visitor.page.locator('a[href*="/rsvp"]')).toHaveCount(0);

    // L: no private data anywhere in the HTML.
    const html = await visitor.page.content();
    for (const secret of [
      weddingId,
      "America/Costa_Rica",
      "Contenido oculto del programa",
      "@example.test",
      "created_by",
      "time_zone",
      es.checklist.title,
      es.guests.title,
      es.wedding.peopleTitle,
    ]) {
      expect(html, "public page leaks private data (value redacted)").not.toContain(secret);
    }
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    await expect(visitor.page.locator('a[href^="/app"]')).toHaveCount(0);

    // The unpublished-vs-missing distinction can't be observed.
    await expectPublicNotFound(visitor.page, uniqueSlug("no-existe"));
    await expectPublicNotFound(visitor.page, "NO-VALIDA");

    await visitor.context.close();
  });

  test("C, D, G, H: a collaborator edits content but can't publish, unpublish or change the address — even forged", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("lb10-collab-owner"));
    const weddingId = await createFullWedding(owner.page, "Boda de prueba Colaboración");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb10-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));

    // C: the collaborator writes the sections.
    await collab.page.getByRole("link", { name: site.navLink }).click();
    await expect(collab.page.getByRole("heading", { level: 1, name: site.title })).toBeVisible();
    await saveSection(collab.page, "intro", { body: "Texto de la colaboradora", visible: true });
    await saveSection(collab.page, "dress_code", { body: "Elegante", visible: true });

    // D: no address or publication controls, a neutral explanation instead.
    await expect(collab.page.getByText(site.status.collaboratorNote)).toBeVisible();
    await expect(collab.page.getByLabel(site.slug.label, { exact: true })).toHaveCount(0);
    await expect(collab.page.getByRole("button", { name: site.publish.submit })).toHaveCount(0);
    await expect(collab.page.getByTestId("site-public-url")).toHaveCount(0);
    await expect(collab.page.getByRole("link", { name: site.header.ownerLink })).toHaveCount(0);

    // The owner sees the collaborator's work, chooses the address.
    await openSite(owner.page, weddingId);
    await expect(sectionCard(owner.page, "intro").getByLabel(site.sections.bodyLabel)).toHaveValue(
      "Texto de la colaboradora",
    );
    const slug = uniqueSlug("colaboracion");
    await saveSlug(owner.page, slug);

    // D: the owner's own "Publicar sitio" request, replayed from the
    // collaborator's session: refused by the server.
    const publishRequest = await captureAction(owner.page, () =>
      owner.page.getByRole("button", { name: site.publish.submit }).click(),
    );
    expect(await replayAction(collab.page, publishRequest)).toContain(site.errors.ownerOnly);
    expect(await publication(weddingId)).toEqual({ slug, published: false });
    const visitor = await freshPage(browser);
    await expectPublicNotFound(visitor.page, slug);

    // The owner publishes; the collaborator now sees the status and address.
    await owner.page.reload();
    await publishSite(owner.page);
    await collab.page.reload();
    await expect(collab.page.getByTestId("site-status")).toContainText(site.status.published);
    await expect(collab.page.getByTestId("site-public-url")).toContainText(`/boda/${slug}`);
    await expect(collab.page.getByRole("button", { name: site.unpublish.open })).toHaveCount(0);

    // D: an address change and an unpublish, replayed from the
    // collaborator's session: refused too.
    const slugRequest = await captureAction(owner.page, async () => {
      await owner.page.getByLabel(site.slug.label, { exact: true }).fill(uniqueSlug("secuestro"));
      await owner.page.getByRole("button", { name: site.slug.submit }).click();
      await owner.page.getByRole("button", { name: site.slug.changeConfirm }).click();
    });
    expect(await replayAction(collab.page, slugRequest)).toContain(site.errors.ownerOnly);
    await owner.page.reload();
    const unpublishRequest = await captureAction(owner.page, async () => {
      await owner.page.getByRole("button", { name: site.unpublish.open }).click();
      await owner.page.getByRole("button", { name: site.unpublish.confirmButton }).click();
    });
    expect(await replayAction(collab.page, unpublishRequest)).toContain(site.errors.ownerOnly);
    expect(await publication(weddingId)).toEqual({ slug, published: true });
    // The same requests from an outsider: the same 404 as a missing wedding.
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb10-forger"));
    await replayAction(outsider.page, unpublishRequest);
    expect(await publication(weddingId)).toEqual({ slug, published: true });
    await outsider.context.close();
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText("Boda de prueba Colaboración");

    // H: a collaborator's edit to a published section is public at once.
    await openSite(collab.page, weddingId);
    await saveSection(collab.page, "intro", { body: "Texto editado y publicado", visible: true });
    await visitor.page.reload();
    await expect(publicSections(visitor.page).first()).toContainText("Texto editado y publicado");

    // G: hiding a section removes it publicly; it stays in the editor.
    await expect(visitor.page.getByRole("heading", { level: 2, name: "Código de vestimenta" })).toBeVisible();
    await saveSection(collab.page, "dress_code", { visible: false });
    await visitor.page.reload();
    await expect(visitor.page.getByRole("heading", { level: 2, name: "Código de vestimenta" })).toHaveCount(0);
    await expect(visitor.page.getByText("Elegante")).toHaveCount(0);
    await collab.page.reload();
    await expect(sectionCard(collab.page, "dress_code").getByLabel(site.sections.bodyLabel)).toHaveValue("Elegante");

    for (const ctx of [owner, collab, visitor]) await ctx.context.close();
  });

  test("I, J, K: unpublish, republish at the same address, then move the address", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb10-lifecycle"));
    const weddingId = await createFullWedding(page, "Boda de prueba Ciclo");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenida del ciclo", visible: true });
    const slug = uniqueSlug("ciclo");
    await saveSlug(page, slug);
    await publishSite(page);

    const visitor = await freshPage(browser);
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.getByText("Bienvenida del ciclo")).toBeVisible();

    // I: unpublish — gone at once; the editor keeps everything.
    await unpublishSite(page);
    await expectPublicNotFound(visitor.page, slug);
    await expect(sectionCard(page, "intro").getByLabel(site.sections.bodyLabel)).toHaveValue("Bienvenida del ciclo");
    await expect(page.getByLabel(site.slug.label, { exact: true })).toHaveValue(slug);

    // J: republish — the same address, the same content.
    await publishSite(page);
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.getByText("Bienvenida del ciclo")).toBeVisible();

    // K: changing a published address asks first; cancel keeps it.
    const next = uniqueSlug("ciclo-nueva");
    await page.getByLabel(site.slug.label, { exact: true }).fill(next);
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.changeBody)).toBeVisible();
    await page.getByRole("button", { name: site.slug.cancel }).click();
    expect((await publication(weddingId))?.slug).toBe(slug);

    await saveSlug(page, next, { confirm: true });
    expect(await publication(weddingId)).toEqual({ slug: next, published: true });
    await expectPublicNotFound(visitor.page, slug);
    const moved = await visitor.page.goto(`/boda/${next}`);
    expect(moved?.status()).toBe(200);
    await expect(visitor.page.getByText("Bienvenida del ciclo")).toBeVisible();

    // A taken address is refused without saying whose it is.
    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("lb10-other"));
    const otherWedding = await createFullWedding(other.page, "Boda de prueba Otra");
    await openSite(other.page, otherWedding);
    await other.page.getByLabel(site.slug.label, { exact: true }).fill(next);
    await other.page.getByRole("button", { name: site.slug.submit }).click();
    await expect(other.page.getByText(site.slug.validation.taken)).toBeVisible();
    await expect(other.page.getByText("Boda de prueba Ciclo")).toHaveCount(0);

    for (const ctx of [visitor, other]) await ctx.context.close();
  });

  test("N, O: the RSVP page shows published context only while published; the guest link keeps working", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb10-rsvp"));
    const weddingId = await createFullWedding(page, "Boda de prueba RSVP Sitio");
    await page.goto(`/app/weddings/${weddingId}/guests`);
    const section = page.getByRole("region", { name: es.guests.newParty.title });
    await section.getByLabel(es.guests.newParty.labelLabel).fill("Familia Prueba");
    await section.getByLabel(es.guests.newParty.namesLabel).fill("Ana Prueba");
    await section.getByRole("button", { name: es.guests.newParty.submit }).click();
    const link = await section.getByTestId("guest-link").inputValue();
    expect(GUEST_LINK.test(link), "guest link has the expected shape (value redacted)").toBe(true);

    // N (unpublished): party only, no wedding fields.
    const guest = await freshPage(browser);
    await guest.page.goto(link);
    await expect(guest.page.getByRole("heading", { level: 1, name: "Familia Prueba" })).toBeVisible();
    await expect(guest.page.getByTestId("rsvp-wedding-context")).toHaveCount(0);
    await expect(guest.page.getByText("Boda de prueba RSVP Sitio")).toHaveCount(0);

    // O: published → the public name, date, city and a link to the site.
    await openSite(page, weddingId);
    await saveSection(page, "rsvp", { visible: true });
    const slug = uniqueSlug("rsvp-sitio");
    await saveSlug(page, slug);
    await publishSite(page);
    await guest.page.reload();
    const context = guest.page.getByTestId("rsvp-wedding-context");
    await expect(context).toContainText("Boda de prueba RSVP Sitio");
    await expect(context).toContainText("1 de junio de 2090 · Ciudad de Prueba");
    await expect(context).not.toContainText("America/Costa_Rica");
    await expect(context.getByRole("link", { name: rsvp.viewSite })).toHaveAttribute("href", `/boda/${slug}`);

    // Unpublish: the context disappears, the RSVP still works.
    await unpublishSite(page);
    await guest.page.goto(link);
    await expect(guest.page.getByTestId("rsvp-wedding-context")).toHaveCount(0);
    await expect(guest.page.getByText("Boda de prueba RSVP Sitio")).toHaveCount(0);
    await guest.page.getByRole("group", { name: "Ana Prueba" }).getByRole("radio", { name: rsvp.yes }).check();
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();

    // The public site never offers a way to RSVP without the personal link.
    await guest.context.clearCookies();
    await publishSite(await reopen(page, weddingId));
    const visitor = await freshPage(browser);
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.getByText(publicCopy.rsvpDefault)).toBeVisible();
    await expect(visitor.page.locator("form, input")).toHaveCount(0);

    // A custom RSVP text replaces the default — still only text, no form or guest lookup.
    await saveSection(page, "rsvp", { body: "Confirma antes del 1 de mayo con el enlace de tu invitación.", visible: true });
    await visitor.page.reload();
    const rsvpSection = visitor.page.getByRole("region", { name: "Confirmación de asistencia" });
    await expect(rsvpSection.locator("p")).toHaveText("Confirma antes del 1 de mayo con el enlace de tu invitación.");
    await expect(visitor.page.getByText(publicCopy.rsvpDefault)).toHaveCount(0);
    await expect(visitor.page.locator("form, input, textarea, select, button")).toHaveCount(0);
    await expect(visitor.page.locator('a[href*="/rsvp"]')).toHaveCount(0);
    await expect(visitor.page.getByText("Ana Prueba")).toHaveCount(0);
    await expect(visitor.page.getByText("Familia Prueba")).toHaveCount(0);
    await visitor.page.goto("/rsvp");
    await expect(visitor.page.getByRole("heading", { level: 1, name: rsvp.unavailable.title })).toBeVisible();

    for (const ctx of [guest, visitor]) await ctx.context.close();
  });

  test("an outsider gets a 404 for another wedding's editor", async ({ browser }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("lb10-outsider-owner"));
    const weddingId = await createFullWedding(owner.page, "Boda de prueba Ajena");
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb10-outsider"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}/site`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByText("Boda de prueba Ajena")).toHaveCount(0);
    for (const ctx of [owner, outsider]) await ctx.context.close();
  });

  test("P: the editor and the public site fit a phone screen (360 and 390 px)", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb10-phone"));
    const weddingId = await createFullWedding(
      page,
      "Boda de prueba de María Fernanda de los Ángeles y Juan Sebastián Rodríguez",
    );
    await openSite(page, weddingId);
    const longLine = "Recepción en el salón principal con cena, baile y brindis".repeat(4);
    await saveSection(page, "intro", { body: `Bienvenidos.\n${longLine}`, visible: true });
    await saveSection(page, "schedule", { body: "16:00 Ceremonia\n18:00 Cóctel\n20:00 Cena\n23:00 Baile", visible: true });
    const slug = uniqueSlug("telefono-con-una-direccion-bastante-larga");
    await saveSlug(page, slug);
    await publishSite(page);

    const visitor = await freshPage(browser);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 780 });
      await page.reload();
      await expectNoHorizontalScroll(page);
      await page.getByRole("button", { name: site.unpublish.open }).click();
      await expectNoHorizontalScroll(page);
      await page.getByRole("button", { name: site.unpublish.cancel }).click();

      await visitor.page.setViewportSize({ width, height: 740 });
      await visitor.page.goto(`/boda/${slug}`);
      await expect(visitor.page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(visitor.page);
    }
    await visitor.context.close();
  });
});

async function saveSectionExpectingError(page: Page, kind: keyof typeof site.kinds, error: string) {
  const card = sectionCard(page, kind);
  await card.getByLabel(site.sections.visibleLabel).check();
  await card.getByRole("button", { name: site.sections.submit }).click();
  await expect(card.getByText(error)).toBeVisible();
  await expect(card.getByLabel(site.sections.bodyLabel)).toHaveAccessibleDescription(
    `${site.sections.bodyHint} ${error}`,
  );
  await card.getByLabel(site.sections.visibleLabel).uncheck();
}

async function reopen(page: Page, weddingId: string): Promise<Page> {
  await openSite(page, weddingId);
  return page;
}
