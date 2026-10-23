import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import type { Database } from "../src/lib/supabase/database.types";
import { createAccount, createInvite, es, formAlert, logIn, siteSectionEditor } from "./support/flows";
import { E2E_PASSWORD } from "./support/identities";
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

async function freshPage(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
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

/** UX-01D: the section's row, with its editor ("Editar") open. */
function sectionCard(page: Page, kind: keyof typeof site.kinds): Promise<Locator> {
  return siteSectionEditor(page, kind);
}

async function saveSection(
  page: Page,
  kind: keyof typeof site.kinds,
  fields: { title?: string; body?: string; visible?: boolean },
) {
  const card = await sectionCard(page, kind);
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
    await logIn(page, await createAccount("lb10-owner", "couple"));
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
    await logIn(owner.page, await createAccount("lb10-collab-owner", "planner"));
    const weddingId = await createFullWedding(owner.page, "Boda de prueba Colaboración");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb10-collab", "planner"));
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
    await expect((await sectionCard(owner.page, "intro")).getByLabel(site.sections.bodyLabel)).toHaveValue(
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
    await logIn(outsider.page, await createAccount("lb10-forger", "couple"));
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
    await expect((await sectionCard(collab.page, "dress_code")).getByLabel(site.sections.bodyLabel)).toHaveValue("Elegante");

    for (const ctx of [owner, collab, visitor]) await ctx.context.close();
  });

  test("I, J, K: unpublish, republish at the same address, then move the address", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb10-lifecycle", "couple"));
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
    await expect((await sectionCard(page, "intro")).getByLabel(site.sections.bodyLabel)).toHaveValue("Bienvenida del ciclo");
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
    await logIn(other.page, await createAccount("lb10-other", "couple"));
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
    await logIn(page, await createAccount("lb10-rsvp", "couple"));
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
    await logIn(owner.page, await createAccount("lb10-outsider-owner", "couple"));
    const weddingId = await createFullWedding(owner.page, "Boda de prueba Ajena");
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb10-outsider", "couple"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}/site`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByText("Boda de prueba Ajena")).toHaveCount(0);
    for (const ctx of [owner, outsider]) await ctx.context.close();
  });

  test("P: the editor and the public site fit a phone screen (360 and 390 px)", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb10-phone", "couple"));
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

  // ADR-019 (Classic parity): the themed public page keeps today's look in
  // both color schemes at phone and desktop widths. Screenshots go to the
  // test output folder for before/after comparison.
  test("Q: the public site keeps the Classic look in light and dark (360, 390 and 1280 px)", async ({
    page,
    browser,
  }, testInfo) => {
    await logIn(page, await createAccount("lb-site-classic", "couple"));
    const weddingId = await createFullWedding(page, "Boda de prueba Clásica");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos.\nNos alegra compartir este día.", visible: true });
    await saveSection(page, "ceremony", { body: "Capilla de prueba, 4:00 p. m.", visible: true });
    await saveSection(page, "rsvp", { visible: true });
    const slug = uniqueSlug("clasica");
    await saveSlug(page, slug);
    await publishSite(page);

    // The global tokens (globals.css) the Classic page is drawn with.
    const tokens = {
      light: { background: "rgb(253, 250, 247)", foreground: "rgb(42, 34, 32)" },
      dark: { background: "rgb(23, 19, 18)", foreground: "rgb(241, 235, 232)" },
    } as const;
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const visitor = await context.newPage();
      for (const width of [360, 390, 1280]) {
        await visitor.setViewportSize({ width, height: 800 });
        await visitor.goto(`/boda/${slug}`);
        await expect(visitor.getByRole("heading", { level: 1, name: "Boda de prueba Clásica" })).toBeVisible();
        await expect(visitor.locator('[data-testid="public-site-section"]')).toHaveCount(3);
        await expectNoHorizontalScroll(visitor);
        const colors = await visitor.evaluate(() => ({
          background: getComputedStyle(document.body).backgroundColor,
          foreground: getComputedStyle(document.querySelector("h1") as Element).color,
        }));
        expect(colors).toEqual(tokens[colorScheme]);
        await visitor.screenshot({ path: testInfo.outputPath(`classic-${colorScheme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  });

  test("R: the public site renders the theme a member saved; no design row is Classic", async ({ page, browser }, testInfo) => {
    // ADR-019 CP4. There is no theme selector yet: the theme is saved through
    // the member RPC (save_wedding_site_design), as a collaborator would.
    const owner = await createAccount("lb-site-theme-owner", "couple");
    await logIn(page, owner);
    const weddingId = await createFullWedding(page, "Boda de prueba con tema");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos.\nNos alegra compartir este día.", visible: true });
    await saveSection(page, "rsvp", { visible: true });
    const slug = uniqueSlug("tema");
    await saveSlug(page, slug);
    await publishSite(page);

    const collaborator = await createAccount("lb-site-theme-collab", "planner");
    const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
    await db.connect();
    try {
      // Fixture: the collaborator's membership (the invite flow is covered elsewhere).
      await db.query(
        `insert into public.wedding_memberships (wedding_id, user_id, role)
         select $1, id, 'collaborator' from auth.users where email = $2`,
        [weddingId, collaborator],
      );
      expect((await db.query("select 1 from public.wedding_site_designs where wedding_id = $1", [weddingId])).rowCount).toBe(0);
    } finally {
      await db.end();
    }
    const member = await signedInClient(collaborator);

    const context = await browser.newContext({ colorScheme: "light", viewport: { width: 390, height: 800 } });
    const visitor = await context.newPage();
    const expectTheme = async (palette: string | null, background: string) => {
      await visitor.goto(`/boda/${slug}`);
      await expect(visitor.getByRole("heading", { level: 1, name: "Boda de prueba con tema" })).toBeVisible();
      await expect(visitor.locator('[data-testid="public-site-section"]')).toHaveCount(2);
      const main = visitor.locator("main");
      if (palette) await expect(main).toHaveAttribute("data-site-palette", palette);
      else await expect(main).not.toHaveAttribute("data-site-palette", /.*/);
      const painted = await visitor.evaluate(() => {
        const main = getComputedStyle(document.querySelector("main") as Element).backgroundColor;
        return main === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : main;
      });
      expect(painted, palette ?? "classic").toBe(background);
      await expect(visitor.locator("form, input, a[href*='/rsvp']")).toHaveCount(0);
      await expectNoHorizontalScroll(visitor);
    };

    // No design row: Classic, and reading wrote none.
    await expectTheme(null, "rgb(253, 250, 247)");

    const themes = [
      ["editorial", "ivory", "rgb(251, 248, 242)"],
      ["minimal", "mono", "rgb(255, 255, 255)"],
      ["romantic", "rose", "rgb(250, 245, 241)"],
      ["tropical", "sand", "rgb(245, 239, 227)"],
    ] as const;
    for (const [theme, palette, background] of themes) {
      const { data, error } = await member.rpc("save_wedding_site_design", {
        target_wedding_id: weddingId,
        new_theme: theme,
        new_customization: {},
      });
      expect(error, theme).toBeNull();
      expect(data, theme).toBe(theme);
      await expectTheme(palette, background);
      await visitor.screenshot({ path: testInfo.outputPath(`theme-${theme}.png`), fullPage: true });
    }

    // Back to the original look by choosing Classic.
    expect((await member.rpc("save_wedding_site_design", { target_wedding_id: weddingId, new_theme: "classic", new_customization: {} })).error).toBeNull();
    await expectTheme(null, "rgb(253, 250, 247)");

    // Unpublishing still hides the site, whatever the theme.
    await member.rpc("save_wedding_site_design", { target_wedding_id: weddingId, new_theme: "romantic", new_customization: {} });
    await openSite(page, weddingId);
    await unpublishSite(page);
    const gone = await visitor.goto(`/boda/${slug}`);
    expect(gone?.status()).toBe(404);
    await context.close();
  });

  // ADR-019 CP5: "Estilo del sitio" and the member-only preview.
  test("S: members choose the theme in «Estilo del sitio»; the public page follows at once; nothing else changes", async ({
    page,
    browser,
  }) => {
    const ownerEmail = await createAccount("lb-site-style-owner", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba Estilo");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos a nuestra boda.", visible: true });
    await saveSection(page, "rsvp", { visible: true });
    const slug = uniqueSlug("estilo");
    await saveSlug(page, slug);

    // No design row: Classic is the selected card; the order is the registry's.
    const card = page.getByTestId("site-theme");
    await expect(card.getByRole("heading", { level: 2, name: site.design.title })).toBeVisible();
    await expect(card.getByText(site.design.contentNote)).toBeVisible();
    await expect(card.getByText(site.design.unpublishedNote)).toBeVisible();
    await expect(themeOptions(page)).toHaveCount(5);
    expect(await themeOptions(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-theme")))).toEqual([
      "classic",
      "editorial",
      "minimal",
      "romantic",
      "tropical",
    ]);
    await expectSelectedTheme(page, "classic");
    expect(await designOf(weddingId)).toBeNull();
    const before = await siteState(weddingId);

    // The owner chooses Editorial on the unpublished site: saved, still unpublished.
    await chooseTheme(page, "editorial");
    expect(await designOf(weddingId)).toBe("editorial");
    expect(await publication(weddingId)).toEqual({ slug, published: false });
    expect(await siteState(weddingId)).toEqual(before);
    const visitor = await freshPage(browser);
    await expectPublicNotFound(visitor.page, slug);

    // Published, it shows the chosen theme.
    await publishSite(page);
    await expect(card.getByText(site.design.liveNote)).toBeVisible();
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.locator("main")).toHaveAttribute("data-site-palette", "ivory");

    // A collaborator chooses too (but still can't publish), live at once.
    const collaboratorEmail = await createAccount("lb-site-style-collab", "planner");
    await addCollaborator(weddingId, collaboratorEmail);
    const collab = await freshPage(browser);
    await logIn(collab.page, collaboratorEmail);
    await openSite(collab.page, weddingId);
    await expectSelectedTheme(collab.page, "editorial");
    await expect(collab.page.getByRole("button", { name: site.unpublish.open })).toHaveCount(0);
    for (const [theme, palette] of [
      ["minimal", "mono"],
      ["romantic", "rose"],
      ["tropical", "sand"],
    ] as const) {
      await chooseTheme(collab.page, theme);
      await visitor.page.reload();
      await expect(visitor.page.locator("main")).toHaveAttribute("data-site-palette", palette);
      await expect(visitor.page.getByText("Bienvenidos a nuestra boda.")).toBeVisible();
    }
    // Back to Classic.
    await chooseTheme(collab.page, "classic");
    await visitor.page.reload();
    await expect(visitor.page.locator("main")).not.toHaveAttribute("data-site-palette", /.*/);
    expect(await designOf(weddingId)).toBe("classic");
    expect(await publication(weddingId)).toEqual({ slug, published: true });
    expect((await siteState(weddingId)).content).toEqual(before.content);

    // The owner's own save request, replayed by an outsider and by a
    // signed-out visitor: refused, and nothing changes.
    const saveRequest = await captureAction(page, () =>
      themeOption(page, "minimal").getByRole("button", { name: `${site.design.use}: ${site.themes.minimal.name}` }).click(),
    );
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb-site-style-outsider", "couple"));
    await replayAction(outsider.page, saveRequest);
    const anonymous = await freshPage(browser);
    await replayAction(anonymous.page, saveRequest);
    expect(await designOf(weddingId)).toBe("classic");
    // ...while the same request from a member works (it is a real save request).
    await replayAction(collab.page, saveRequest);
    expect(await designOf(weddingId)).toBe("minimal");

    for (const ctx of [visitor, collab, outsider, anonymous]) await ctx.context.close();
  });

  test("T: the member-only preview draws any theme, published or not, and never writes", async ({ page, browser }, testInfo) => {
    const ownerEmail = await createAccount("lb-site-preview-owner", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba Vista previa");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Texto visible de la introducción.", visible: true });
    await saveSection(page, "ceremony", { body: "Texto oculto de la ceremonia.", visible: false });
    await saveSection(page, "rsvp", { visible: true });
    const before = await siteState(weddingId);

    // From the selector to the preview: unpublished, the member still sees it.
    await themeOption(page, "romantic")
      .getByRole("link", { name: `${site.design.preview}: ${site.themes.romantic.name}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/site/preview\\?theme=romantic$`));
    await expect(page.getByTestId("site-preview-title")).toHaveText(`Vista previa: ${site.themes.romantic.name}`);
    await expect(page.getByText(site.preview.unpublished)).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    const canvas = page.getByTestId("site-preview");
    await expect(canvas.locator("[data-site-palette]")).toHaveAttribute("data-site-palette", "rose");
    await expect(canvas.getByRole("heading", { level: 1, name: "Boda de prueba Vista previa" })).toBeVisible();
    await expect(canvas.getByText("Texto visible de la introducción.")).toBeVisible();
    await expect(canvas.getByText(es.publicSite.rsvpDefault)).toBeVisible();
    await expect(page.getByText("Texto oculto de la ceremonia.")).toHaveCount(0);
    await expect(page.getByText("America/Costa_Rica")).toHaveCount(0);
    await expect(canvas.locator("form, input, a[href*='/rsvp']")).toHaveCount(0);
    await expect(page.locator("main")).toHaveCount(1);

    // Switching themes changes only the drawing; nothing is saved.
    for (const [theme, palette] of [
      ["editorial", "ivory"],
      ["minimal", "mono"],
      ["tropical", "sand"],
      ["classic", null],
    ] as const) {
      await page.getByRole("navigation", { name: site.preview.otherThemes }).getByRole("link", { name: site.themes[theme].name }).click();
      await expect(page).toHaveURL(new RegExp(`theme=${theme}$`));
      await expect(canvas).toHaveAttribute("data-theme", theme);
      if (palette) await expect(canvas.locator("[data-site-palette]")).toHaveAttribute("data-site-palette", palette);
      else await expect(canvas.locator("[data-site-palette]")).toHaveCount(0);
      await expect(canvas.getByText("Texto visible de la introducción.")).toBeVisible();
    }
    // Classic is the current one (no design row): no save button there.
    await expect(page.getByTestId("site-preview-current")).toHaveText(site.preview.current);
    // An unknown theme previews the current one.
    await page.goto(`/app/weddings/${weddingId}/site/preview?theme=neon`);
    await expect(canvas).toHaveAttribute("data-theme", "classic");
    expect(await designOf(weddingId)).toBeNull();
    expect(await siteState(weddingId)).toEqual(before);

    // Saving from the preview uses the same save; still unpublished.
    await page.goto(`/app/weddings/${weddingId}/site/preview?theme=tropical`);
    await page.getByRole("button", { name: `${site.design.use}: ${site.themes.tropical.name}` }).click();
    await expect(page.getByTestId("site-theme-status")).toHaveText(`Guardamos el estilo «${site.themes.tropical.name}».`);
    await expect(page.getByTestId("site-preview-current")).toBeVisible();
    expect(await designOf(weddingId)).toBe("tropical");
    expect(await siteState(weddingId)).toEqual(before);
    await screenshotPreview(page, testInfo, "preview-tropical");

    // A collaborator previews too.
    const collaboratorEmail = await createAccount("lb-site-preview-collab", "planner");
    await addCollaborator(weddingId, collaboratorEmail);
    const collab = await freshPage(browser);
    await logIn(collab.page, collaboratorEmail);
    await collab.page.goto(`/app/weddings/${weddingId}/site/preview?theme=editorial`);
    await expect(collab.page.getByTestId("site-preview").locator("[data-site-palette]")).toHaveAttribute(
      "data-site-palette",
      "ivory",
    );

    // An outsider gets a 404; a signed-out visitor is sent to log in.
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb-site-preview-outsider", "couple"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}/site/preview?theme=minimal`);
    expect(response?.status()).toBe(404);
    await expect(outsider.page.getByText("Texto visible de la introducción.")).toHaveCount(0);
    const anonymous = await freshPage(browser);
    await anonymous.page.goto(`/app/weddings/${weddingId}/site/preview?theme=minimal`);
    await expect(anonymous.page).toHaveURL(/\/login\?next=/);
    await expect(anonymous.page.getByText("Texto visible de la introducción.")).toHaveCount(0);

    expect(await designOf(weddingId)).toBe("tropical");
    expect(await publication(weddingId)).toBeNull();
    for (const ctx of [collab, outsider, anonymous]) await ctx.context.close();
  });

  test("U: the selector and the preview fit 360, 390, 768 and 1280 px, keyboard included", async ({ page }, testInfo) => {
    await logIn(page, await createAccount("lb-site-style-widths", "couple"));
    const weddingId = await createFullWedding(
      page,
      "Boda de prueba de María Fernanda de los Ángeles y Juan Sebastián Rodríguez",
    );
    await openSite(page, weddingId);
    const longLine = "Recepción en el salón principal con cena, baile y brindis".repeat(4);
    await saveSection(page, "intro", { body: `Bienvenidos.\n${longLine}`, visible: true });
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await openSite(page, weddingId);
      await page.getByTestId("site-theme").scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(page);
      await page.getByTestId("site-theme").screenshot({ path: testInfo.outputPath(`selector-${width}.png`) });
      for (const theme of ["editorial", "romantic", "tropical", "minimal", "classic"] as const) {
        await page.goto(`/app/weddings/${weddingId}/site/preview?theme=${theme}`);
        await expect(page.getByTestId("site-preview")).toHaveAttribute("data-theme", theme);
        await expectNoHorizontalScroll(page);
      }
      await screenshotPreview(page, testInfo, `preview-classic-${width}`);
    }

    // Keyboard: the preview link and the save button are reachable and
    // focus is visible; saving announces the result.
    await page.setViewportSize({ width: 390, height: 900 });
    await openSite(page, weddingId);
    const save = themeOption(page, "minimal").getByRole("button", { name: `${site.design.use}: ${site.themes.minimal.name}` });
    await save.focus();
    await expect(save).toBeFocused();
    expect(await save.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("site-theme-status")).toHaveText(`Guardamos el estilo «${site.themes.minimal.name}».`);
    await expectSelectedTheme(page, "minimal");
    // Thumbnails are decorative: nothing inside them is in the accessibility tree.
    await expect(page.getByTestId("site-theme-thumbnail").first()).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test("V: members customize the chosen theme with closed options: preview first, save, reset, change theme", async ({
    page,
    browser,
  }, testInfo) => {
    const customize = site.customize;
    const ownerEmail = await createAccount("lb-site-custom-owner", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba Personalizada");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos a la boda personalizada.", visible: true });
    await saveSection(page, "rsvp", { visible: true });
    const slug = uniqueSlug("personal");
    await saveSlug(page, slug);
    await publishSite(page);
    const before = await siteState(weddingId);

    // 1. Start with Editorial.
    await chooseTheme(page, "editorial");
    const visitor = await freshPage(browser);
    await visitor.page.goto(`/boda/${slug}`);
    await expectPublicLook(visitor.page, { palette: "ivory", bodyFont: "serif" });

    // The controls are the registry's: Editorial's own options, in Spanish.
    const panel = page.getByTestId("site-customize");
    await expect(panel.getByRole("heading", { name: `Personalizar «${site.themes.editorial.name}»` })).toBeVisible();
    // Three presets, plus custom colors (CP7).
    await expect(customizeField(page, "palette").getByRole("radio")).toHaveCount(4);
    await expect(customizeField(page, "hero").getByRole("radio")).toHaveCount(3);
    await expect(radio(page, "palette", customize.values.palette.ivory)).toBeChecked();
    await expect(panel.getByText("ivory", { exact: true })).toHaveCount(0);

    // 2–3. Palette + typography + density, previewed before saving.
    await radio(page, "palette", customize.values.palette.parchment).check();
    await radio(page, "typography", customize.values.typography.mixed).check();
    await radio(page, "density", customize.values.density.regular).check();
    await panel.getByRole("button", { name: customize.preview, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/site/preview\\?theme=editorial&customize=1&palette=parchment&typography=mixed&density=regular$`),
    );
    const canvas = page.getByTestId("site-preview");
    await expect(canvas.locator("[data-site-palette]")).toHaveAttribute("data-site-palette", "parchment");
    await expect(page.getByTestId("site-preview-unsaved")).toHaveText(site.preview.customNote);
    await expect(page.getByTestId("site-preview-title")).toHaveText(`Vista previa: ${site.themes.editorial.name} personalizado`);
    await screenshotPreview(page, testInfo, "custom-preview");

    // 4. Nothing saved yet: the public page is unchanged.
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: {} });
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "ivory", bodyFont: "serif" });

    // 5–6. Saved from the preview: the public page changes at once.
    const previewPanel = page.getByTestId("site-customize");
    await previewPanel.getByRole("button", { name: customize.saveDesign }).click();
    await expect(previewPanel.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.editorial.name}».`,
    );
    await expect(page.getByTestId("site-preview-current")).toHaveText(site.preview.currentDesign);
    expect(await customizationOf(weddingId)).toEqual({
      theme: "editorial",
      customization: {
        schemaVersion: 1,
        palette: { kind: "preset", key: "parchment" },
        typography: { pairing: "mixed" },
        layout: { density: "regular" },
      },
    });
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "parchment", bodyFont: "sans" });
    await expect(visitor.page.getByText("Bienvenidos a la boda personalizada.")).toBeVisible();

    // 7. Reset one group (the palette); typography and spacing stay.
    await openSite(page, weddingId);
    await expect(radio(page, "palette", customize.values.palette.parchment)).toBeChecked();
    await expect(panel.getByRole("button", { name: `${customize.reset}: ${customize.groups.hero}` })).toHaveCount(0);
    await panel.getByRole("button", { name: `${customize.reset}: ${customize.groups.palette}` }).click();
    await expect(panel.getByTestId("site-customize-status")).toHaveText(
      `Restablecimos «${customize.groups.palette}» a como viene el estilo.`,
    );
    expect(await customizationOf(weddingId)).toEqual({
      theme: "editorial",
      customization: { schemaVersion: 1, typography: { pairing: "mixed" }, layout: { density: "regular" } },
    });
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "ivory", bodyFont: "sans" });

    // 8. Reset all: the base theme stays Editorial (never back to Classic).
    await panel.getByRole("button", { name: customize.resetAll }).click();
    await expect(panel.getByTestId("site-customize-status")).toHaveText(
      `Quitamos toda la personalización. El sitio usa «${site.themes.editorial.name}» tal como viene.`,
    );
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: {} });
    await expectSelectedTheme(page, "editorial");
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "ivory", bodyFont: "serif" });

    // 9–10. A framed hero and regular spacing on Editorial, then Minimal:
    // Minimal has no framed hero (its own grid applies); the spacing stays.
    await radio(page, "hero", customize.values.hero.framed).check();
    await radio(page, "density", customize.values.density.regular).check();
    await radio(page, "palette", customize.values.palette.charcoal).check();
    await panel.getByRole("button", { name: customize.save }).click();
    await expect(panel.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.editorial.name}».`,
    );
    await themeOption(page, "minimal").getByRole("button", { name: `${site.design.use}: ${site.themes.minimal.name}` }).click();
    await expect(page.getByTestId("site-theme-status")).toHaveText(
      `Guardamos el estilo «${site.themes.minimal.name}». ${site.design.dropped}`,
    );
    await expectSelectedTheme(page, "minimal");
    expect(await customizationOf(weddingId)).toEqual({
      theme: "minimal",
      customization: { schemaVersion: 1, layout: { density: "regular" } },
    });
    await expect(panel.getByRole("heading", { name: `Personalizar «${site.themes.minimal.name}»` })).toBeVisible();
    await expect(radio(page, "hero", customize.values.hero.grid)).toBeChecked();
    await expect(customizeField(page, "hero").getByRole("radio", { name: customize.values.hero.framed })).toHaveCount(0);
    await expect(radio(page, "density", customize.values.density.regular)).toBeChecked();
    // Minimal fixes the alignment: stated, not offered.
    await expect(page.locator('[data-testid="site-customize-fixed"][data-field="alignment"]')).toBeVisible();
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "mono", bodyFont: "sans" });

    // 11. A collaborator customizes too.
    const collaboratorEmail = await createAccount("lb-site-custom-collab", "planner");
    await addCollaborator(weddingId, collaboratorEmail);
    const collab = await freshPage(browser);
    await logIn(collab.page, collaboratorEmail);
    await openSite(collab.page, weddingId);
    const collabPanel = collab.page.getByTestId("site-customize");
    await radio(collab.page, "palette", customize.values.palette.ink).check();
    const saveRequest = await captureAction(collab.page, () =>
      collabPanel.getByRole("button", { name: customize.save }).click(),
    );
    // The captured request was aborted, leaving that form pending: start again.
    await openSite(collab.page, weddingId);
    await radio(collab.page, "palette", customize.values.palette.ink).check();
    await collabPanel.getByRole("button", { name: customize.save }).click();
    await expect(collabPanel.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.minimal.name}».`,
    );
    await visitor.page.reload();
    await expectPublicLook(visitor.page, { palette: "ink", bodyFont: "sans" });
    const saved = await customizationOf(weddingId);

    // 12. The same save request from an outsider or a signed-out visitor: refused, nothing changes.
    await withDb((db) => db.query("update public.wedding_site_designs set customization = '{}' where wedding_id = $1", [weddingId]));
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb-site-custom-outsider", "couple"));
    await replayAction(outsider.page, saveRequest);
    const anonymous = await freshPage(browser);
    await replayAction(anonymous.page, saveRequest);
    expect(await customizationOf(weddingId)).toEqual({ theme: "minimal", customization: {} });
    const outsiderPage = await outsider.page.goto(`/app/weddings/${weddingId}/site`);
    expect(outsiderPage?.status()).toBe(404);
    // ...while the member's own request works (it is a real save request).
    await replayAction(collab.page, saveRequest);
    expect(await customizationOf(weddingId)).toEqual(saved);

    // Nothing but the design ever changed.
    expect(await siteState(weddingId)).toEqual(before);
    expect(await publication(weddingId)).toEqual({ slug, published: true });
    for (const ctx of [visitor, collab, outsider, anonymous]) await ctx.context.close();
  });

  test("W: an unpublished wedding is customized, previewed and saved, and stays 404 until the owner publishes", async ({
    page,
    browser,
  }) => {
    const customize = site.customize;
    const ownerEmail = await createAccount("lb-site-custom-private", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba Personalizada privada");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Texto de la boda privada.", visible: true });
    const slug = uniqueSlug("privada");
    await saveSlug(page, slug);
    const visitor = await freshPage(browser);

    // A collaborator customizes the unpublished site.
    const collaboratorEmail = await createAccount("lb-site-custom-private-collab", "planner");
    await addCollaborator(weddingId, collaboratorEmail);
    const collab = await freshPage(browser);
    await logIn(collab.page, collaboratorEmail);
    await openSite(collab.page, weddingId);
    await chooseTheme(collab.page, "tropical");
    const panel = collab.page.getByTestId("site-customize");
    await radio(collab.page, "palette", customize.values.palette.sunset).check();
    await radio(collab.page, "hero", customize.values.hero.editorial).check();
    await panel.getByRole("button", { name: customize.preview, exact: true }).click();
    await expect(collab.page.getByText(site.preview.unpublished)).toBeVisible();
    await expect(collab.page.getByTestId("site-preview").locator("[data-site-palette]")).toHaveAttribute(
      "data-site-palette",
      "sunset",
    );
    await expectPublicNotFound(visitor.page, slug);
    expect(await customizationOf(weddingId)).toEqual({ theme: "tropical", customization: {} });

    await collab.page.getByTestId("site-customize").getByRole("button", { name: customize.saveDesign }).click();
    await expect(collab.page.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.tropical.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({
      theme: "tropical",
      customization: { schemaVersion: 1, palette: { kind: "preset", key: "sunset" }, hero: { variant: "editorial" } },
    });
    // Saved, still private: no publish, and the public page is a 404.
    expect(await publication(weddingId)).toEqual({ slug, published: false });
    await expectPublicNotFound(visitor.page, slug);

    // An unknown or foreign value in the preview URL falls back to the theme's default.
    await collab.page.goto(`/app/weddings/${weddingId}/site/preview?theme=tropical&customize=1&palette=rose&hero=url(x)`);
    await expect(collab.page.getByTestId("site-preview").locator("[data-site-palette]")).toHaveAttribute("data-site-palette", "sand");
    await expect(collab.page.getByText("url(x)")).toHaveCount(0);

    // The owner publishes: the saved customization is what the public sees.
    await openSite(page, weddingId);
    await publishSite(page);
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.locator("main")).toHaveAttribute("data-site-palette", "sunset");
    await expect(visitor.page.getByText("Texto de la boda privada.")).toBeVisible();
    for (const ctx of [visitor, collab]) await ctx.context.close();
  });

  test("X: the customization controls and the preview fit 360, 390, 768 and 1280 px, keyboard included", async ({ page }, testInfo) => {
    const customize = site.customize;
    await logIn(page, await createAccount("lb-site-custom-widths", "couple"));
    const weddingId = await createFullWedding(
      page,
      "Boda de prueba de María Fernanda de los Ángeles y Juan Sebastián Rodríguez",
    );
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos.\nRecepción en el salón principal con cena y baile.", visible: true });
    await chooseTheme(page, "tropical");
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await openSite(page, weddingId);
      await page.getByTestId("site-customize").scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(page);
      await page.getByTestId("site-customize").screenshot({ path: testInfo.outputPath(`customize-${width}.png`) });
      await page.goto(
        `/app/weddings/${weddingId}/site/preview?theme=tropical&customize=1&palette=forest&width=wide&density=airy&hero=simple&sectionStyle=editorial`,
      );
      await expect(page.getByTestId("site-preview")).toHaveAttribute("data-theme", "tropical");
      await expect(page.getByTestId("site-preview-customize")).toHaveAttribute("open", "");
      await expectNoHorizontalScroll(page);
      await screenshotPreview(page, testInfo, `custom-preview-${width}`);
    }

    // Keyboard: radios move with the arrow keys, focus is visible, the
    // selection is shown by the radio and bold text (not color alone), and
    // the save is announced.
    await page.setViewportSize({ width: 390, height: 900 });
    await openSite(page, weddingId);
    const first = radio(page, "palette", customize.values.palette.sand);
    await first.focus();
    await expect(first).toBeFocused();
    expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("ArrowRight");
    const forest = radio(page, "palette", customize.values.palette.forest);
    await expect(forest).toBeFocused();
    await expect(forest).toBeChecked();
    expect(await forest.evaluate((el) => getComputedStyle(el.closest("label") as Element).fontWeight)).toBe("600");
    const save = page.getByTestId("site-customize").getByRole("button", { name: customize.save });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.tropical.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({
      theme: "tropical",
      customization: { schemaVersion: 1, palette: { kind: "preset", key: "forest" } },
    });
    // Tropical offers a choice in every field: eight named groups of radios.
    expect(
      await page
        .locator('[data-testid="site-customize"] [data-testid="site-customize-field"] legend')
        .evaluateAll((legends) => legends.map((legend) => legend.textContent)),
    ).toEqual(Object.values(customize.fields));
    for (const field of Object.keys(customize.fields) as (keyof typeof customize.fields)[]) {
      await expect(page.getByRole("group", { name: customize.fields[field] })).toBeVisible();
    }
  });
  test("Y: custom colors: switch from a preset, check contrast live, preview, save, light mode only, reset", async ({
    page,
    browser,
  }, testInfo) => {
    const customize = site.customize;
    const colors = customize.colors;
    const ownerEmail = await createAccount("lb-site-colors-owner", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba Colores");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Bienvenidos a la boda de colores.", visible: true });
    await saveSection(page, "faq", { title: "Preguntas", body: "¿Hay parqueo?\nSí, en el hotel.", visible: true });
    const slug = uniqueSlug("colores");
    await saveSlug(page, slug);
    await publishSite(page);
    const before = await siteState(weddingId);

    // 1. Editorial, with a preset saved first.
    await chooseTheme(page, "editorial");
    const panel = page.getByTestId("site-customize");
    await radio(page, "palette", customize.values.palette.parchment).check();
    await panel.getByRole("button", { name: customize.save }).click();
    await expect(panel.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.editorial.name}».`,
    );
    const light = await freshPage(browser);
    await light.page.goto(`/boda/${slug}`);
    await expect(light.page.locator("main")).toHaveAttribute("data-site-palette", "parchment");
    const parchmentBackground = await backgroundOf(light.page);

    // 2. Custom colors open only when chosen; six colors, each labelled.
    const fields = panel.getByTestId("site-customize-colors");
    await expect(fields).toBeHidden();
    await radio(page, "palette", colors.option).check();
    await expect(fields).toBeVisible();
    await expect(fields.getByTestId("site-customize-colors-light-only")).toHaveText(
      colors.lightOnly.replace("{name}", site.themes.editorial.name),
    );
    for (const role of Object.values(colors.roles)) {
      await expect(fields.getByLabel(role, { exact: true })).toBeVisible();
      await expect(fields.getByLabel(`${role}: selector de color`, { exact: true })).toBeVisible();
    }

    // 3. A valid accessible palette (dark background, still the light-mode look).
    await fillColors(page, NIGHT);
    await expect(fields.getByTestId("site-customize-colors-status")).toHaveText(colors.valid);
    await expect(panel.getByRole("button", { name: customize.save })).toBeEnabled();

    // 4. Previewed before saving: fixed parameters, never JSON.
    await panel.getByRole("button", { name: customize.preview, exact: true }).click();
    await expect(page).toHaveURL(/\/site\/preview\?theme=editorial&customize=1&palette=custom&colorBackground=%231d1b2e/);
    expect(page.url()).not.toMatch(/%7B|\{/);
    const canvas = page.getByTestId("site-preview").locator("[data-site-custom-colors]");
    await expect(canvas).toHaveCSS("background-color", "rgb(29, 27, 46)");
    await expect(page.getByTestId("site-preview-unsaved")).toHaveText(site.preview.customNote);
    await screenshotPreview(page, testInfo, "colors-preview");

    // 5. Nothing saved: the public page is unchanged.
    expect(await customizationOf(weddingId)).toEqual({
      theme: "editorial",
      customization: { schemaVersion: 1, palette: { kind: "preset", key: "parchment" } },
    });
    await light.page.reload();
    expect(await backgroundOf(light.page)).toBe(parchmentBackground);

    // 6. Saved from the preview: the preset is replaced, never kept next to the colors.
    await page.getByTestId("site-customize").getByRole("button", { name: customize.saveDesign }).click();
    await expect(page.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.editorial.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: { schemaVersion: 1, colors: NIGHT } });

    // 7. Light mode: the public page draws the custom colors.
    await light.page.reload();
    const main = light.page.locator("main");
    await expect(main).toHaveAttribute("data-site-custom-colors", "");
    await expect(main).toHaveAttribute("data-site-palette", "ivory");
    await expect(main).toHaveCSS("background-color", "rgb(29, 27, 46)");
    await expect(light.page.getByRole("heading", { level: 1 })).toHaveCSS("color", "rgb(244, 241, 255)");
    await expect(light.page.getByTestId("public-site-details")).toHaveCSS("color", "rgb(195, 189, 219)");
    await expect(light.page.getByText("Bienvenidos a la boda de colores.")).toBeVisible();
    expect(await lowContrastTexts(light.page)).toEqual([]);
    await light.page.screenshot({ path: testInfo.outputPath("colors-public-light.png"), fullPage: true });

    // 8. Dark mode: Editorial's normal dark palette, not the custom colors.
    const dark = await freshPage(browser, { colorScheme: "dark" });
    await dark.page.goto(`/boda/${slug}`);
    await expect(dark.page.locator("main")).toHaveCSS("background-color", "rgb(21, 19, 15)");
    await expect(dark.page.getByRole("heading", { level: 1 })).toHaveCSS("color", "rgb(237, 230, 217)");
    expect(await lowContrastTexts(dark.page)).toEqual([]);
    await dark.page.screenshot({ path: testInfo.outputPath("colors-public-dark.png"), fullPage: true });

    // 9–10. A low-contrast palette: explained next to the fields, preview and save wait.
    await openSite(page, weddingId);
    await expect(radio(page, "palette", colors.option)).toBeChecked();
    const text = fields.getByLabel(colors.roles.text, { exact: true });
    await expect(text).toHaveValue(NIGHT.text);
    await text.fill("#3a3850");
    await expect(fields.getByText(colors.pairs.textBackground)).toBeVisible();
    await expect(text).toHaveAttribute("aria-invalid", "true");
    await expect(text).toHaveAccessibleDescription(new RegExp(colors.pairs.textBackground));
    await expect(fields.getByTestId("site-customize-colors-status")).toContainText("problemas");
    await expect(panel.getByRole("button", { name: customize.save })).toBeDisabled();
    await expect(panel.getByRole("button", { name: customize.preview, exact: true })).toBeDisabled();
    // A malformed code says how to write one.
    const accent = fields.getByLabel(colors.roles.accent, { exact: true });
    await accent.fill("rojo");
    await expect(accent).toHaveAccessibleDescription(new RegExp(colors.format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await accent.fill(NIGHT.accent);
    await text.fill(NIGHT.text);
    await expect(panel.getByRole("button", { name: customize.save })).toBeEnabled();
    // The server refuses it too: the real save request with a low-contrast text color.
    const saveRequest = await captureAction(page, () => panel.getByRole("button", { name: customize.save }).click());
    const forged = { ...saveRequest, body: Buffer.from(saveRequest.body.toString("latin1").replace(NIGHT.text, "#3a3850"), "latin1") };
    expect(forged.body.toString("latin1")).toContain("#3a3850");
    await openSite(page, weddingId);
    await replayAction(page, forged);
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: { schemaVersion: 1, colors: NIGHT } });

    // 11–12. Reset custom colors: Editorial's own palette is back (the preset was replaced).
    await panel.getByRole("button", { name: `${customize.reset}: ${customize.groups.colors}` }).click();
    await expect(panel.getByTestId("site-customize-status")).toHaveText(
      `Restablecimos «${customize.groups.colors}» a como viene el estilo.`,
    );
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: {} });
    await expect(radio(page, "palette", customize.values.palette.ivory)).toBeChecked();
    await light.page.reload();
    await expect(light.page.locator("main")).not.toHaveAttribute("data-site-custom-colors", /.*/);
    await expect(light.page.locator("main")).toHaveCSS("background-color", "rgb(251, 248, 242)");

    // 13. A collaborator saves custom colors (and they survive a theme change).
    const collaboratorEmail = await createAccount("lb-site-colors-collab", "planner");
    await addCollaborator(weddingId, collaboratorEmail);
    const collab = await freshPage(browser);
    await logIn(collab.page, collaboratorEmail);
    await openSite(collab.page, weddingId);
    await radio(collab.page, "palette", colors.option).check();
    await fillColors(collab.page, MEADOW);
    const collabPanel = collab.page.getByTestId("site-customize");
    const collabSave = await captureAction(collab.page, () => collabPanel.getByRole("button", { name: customize.save }).click());
    await openSite(collab.page, weddingId);
    await radio(collab.page, "palette", colors.option).check();
    await fillColors(collab.page, MEADOW);
    await collabPanel.getByRole("button", { name: customize.save }).click();
    await expect(collabPanel.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.editorial.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({ theme: "editorial", customization: { schemaVersion: 1, colors: MEADOW } });
    await themeOption(collab.page, "tropical").getByRole("button", { name: `${site.design.use}: ${site.themes.tropical.name}` }).click();
    await expect(collab.page.getByTestId("site-theme-status")).toHaveText(`Guardamos el estilo «${site.themes.tropical.name}».`);
    expect(await customizationOf(weddingId)).toEqual({ theme: "tropical", customization: { schemaVersion: 1, colors: MEADOW } });
    await light.page.reload();
    await expect(light.page.locator("main")).toHaveCSS("background-color", "rgb(243, 247, 246)");
    expect(await lowContrastTexts(light.page)).toEqual([]);

    // 14. The collaborator's save request from an outsider or a signed-out visitor: nothing changes.
    await withDb((db) => db.query("update public.wedding_site_designs set customization = '{}' where wedding_id = $1", [weddingId]));
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb-site-colors-outsider", "couple"));
    await replayAction(outsider.page, collabSave);
    const anonymous = await freshPage(browser);
    await replayAction(anonymous.page, collabSave);
    expect(await customizationOf(weddingId)).toEqual({ theme: "tropical", customization: {} });
    expect((await outsider.page.goto(`/app/weddings/${weddingId}/site`))?.status()).toBe(404);

    // Nothing but the design ever changed.
    expect(await siteState(weddingId)).toEqual(before);
    expect(await publication(weddingId)).toEqual({ slug, published: true });
    for (const ctx of [light, dark, collab, outsider, anonymous]) await ctx.context.close();
  });

  test("Z: custom colors on an unpublished wedding (404 until published); the controls fit 360–1280 px, keyboard included", async ({
    page,
    browser,
  }, testInfo) => {
    const customize = site.customize;
    const colors = customize.colors;
    const ownerEmail = await createAccount("lb-site-colors-private", "couple");
    await logIn(page, ownerEmail);
    const weddingId = await createFullWedding(page, "Boda de prueba de María Fernanda de los Ángeles y Juan Sebastián Rodríguez");
    await openSite(page, weddingId);
    await saveSection(page, "intro", { body: "Texto de la boda privada con colores.", visible: true });
    await saveSection(page, "faq", { title: "Preguntas", body: "¿Hay parqueo?\nSí.", visible: true });
    const slug = uniqueSlug("colores-privada");
    await saveSlug(page, slug);
    await chooseTheme(page, "tropical");
    const visitor = await freshPage(browser);

    // Customize and preview while unpublished.
    const panel = page.getByTestId("site-customize");
    await radio(page, "palette", colors.option).check();
    await fillColors(page, NIGHT);
    await panel.getByRole("button", { name: customize.preview, exact: true }).click();
    await expect(page.getByText(site.preview.unpublished)).toBeVisible();
    await expect(page.getByTestId("site-preview").locator("[data-site-custom-colors]")).toHaveCSS("background-color", "rgb(29, 27, 46)");
    await expectPublicNotFound(visitor.page, slug);

    // Save: still private.
    await page.getByTestId("site-customize").getByRole("button", { name: customize.saveDesign }).click();
    await expect(page.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.tropical.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({ theme: "tropical", customization: { schemaVersion: 1, colors: NIGHT } });
    expect(await publication(weddingId)).toEqual({ slug, published: false });
    await expectPublicNotFound(visitor.page, slug);

    // Hostile preview parameters are ignored whole (the theme's palette), never echoed.
    await page.goto(
      `/app/weddings/${weddingId}/site/preview?theme=tropical&customize=1&palette=custom&colorBackground=url(x)&colorSurface=%23ffffff&colorText=%23111111&colorMuted=%23555555&colorAccent=%230f5c55&colorAccentText=%23ffffff`,
    );
    await expect(page.getByTestId("site-preview").locator("[data-site-palette]")).toHaveAttribute("data-site-palette", "sand");
    await expect(page.getByTestId("site-preview").locator("[data-site-custom-colors]")).toHaveCount(0);
    await expect(page.getByText("url(x)")).toHaveCount(0);

    // Every width: the controls (custom colors open) and the preview fit; text stays readable.
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await openSite(page, weddingId);
      await expect(page.getByTestId("site-customize-colors")).toBeVisible();
      await page.getByTestId("site-customize-colors").scrollIntoViewIfNeeded();
      await expectNoHorizontalScroll(page);
      await page.getByTestId("site-customize").screenshot({ path: testInfo.outputPath(`colors-customize-${width}.png`) });
      await page.goto(
        `/app/weddings/${weddingId}/site/preview?theme=tropical&customize=1&width=wide&hero=banner&palette=custom&${new URLSearchParams(
          colorParams(MEADOW),
        ).toString()}`,
      );
      await expect(page.getByTestId("site-preview").locator("[data-site-custom-colors]")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await screenshotPreview(page, testInfo, `colors-preview-${width}`);
    }

    // Keyboard: the palette radios move with the arrows into custom colors,
    // the code fields take typing, focus is visible, and the save is announced.
    await page.setViewportSize({ width: 390, height: 900 });
    await openSite(page, weddingId);
    const sunset = radio(page, "palette", customize.values.palette.sunset);
    await sunset.focus();
    await page.keyboard.press("ArrowRight");
    const custom = radio(page, "palette", colors.option);
    await expect(custom).toBeFocused();
    await expect(custom).toBeChecked();
    expect(await custom.evaluate((el) => getComputedStyle(el.closest("label") as Element).fontWeight)).toBe("600");
    const background = page.getByTestId("site-customize-colors").getByLabel(colors.roles.background, { exact: true });
    await background.focus();
    expect(await background.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await background.press("Control+a");
    await page.keyboard.type("#FAFAF7");
    await expect(background).toHaveValue("#fafaf7");
    await expect(page.getByTestId("site-customize-colors-status")).toContainText("problemas");
    await page.getByTestId("site-customize-colors").getByLabel(colors.roles.surface, { exact: true }).fill(MEADOW.surface);
    for (const role of ["text", "muted", "accent", "accentText"] as const) {
      await page.getByTestId("site-customize-colors").getByLabel(colors.roles[role], { exact: true }).fill(MEADOW[role]);
    }
    await expect(page.getByTestId("site-customize-colors-status")).toHaveText(colors.valid);
    const save = page.getByTestId("site-customize").getByRole("button", { name: customize.save });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("site-customize-status")).toHaveText(
      `Guardamos la personalización de «${site.themes.tropical.name}».`,
    );
    expect(await customizationOf(weddingId)).toEqual({
      theme: "tropical",
      customization: { schemaVersion: 1, colors: { ...MEADOW, background: "#fafaf7" } },
    });

    // The owner publishes: the saved colors are what the public sees (light mode).
    await publishSite(page);
    await visitor.page.goto(`/boda/${slug}`);
    await expect(visitor.page.locator("main")).toHaveCSS("background-color", "rgb(250, 250, 247)");
    await expect(visitor.page.getByText("Texto de la boda privada con colores.")).toBeVisible();
    expect(await lowContrastTexts(visitor.page)).toEqual([]);
    await visitor.context.close();
  });
});

/** Custom palettes used by the E2E (both pass every contrast pair). */
const NIGHT = { background: "#1d1b2e", surface: "#2a2740", text: "#f4f1ff", muted: "#c3bddb", accent: "#f2c46d", accentText: "#1d1b2e" };
const MEADOW = { background: "#f3f7f6", surface: "#ffffff", text: "#10201d", muted: "#4a5b57", accent: "#0f5c55", accentText: "#ffffff" };

/** The preview parameters of a palette. */
function colorParams(colors: typeof NIGHT): Record<string, string> {
  return {
    colorBackground: colors.background,
    colorSurface: colors.surface,
    colorText: colors.text,
    colorMuted: colors.muted,
    colorAccent: colors.accent,
    colorAccentText: colors.accentText,
  };
}

/** Types a palette into the open custom color fields (by their visible labels). */
async function fillColors(page: Page, colors: typeof NIGHT) {
  const fields = page.getByTestId("site-customize").getByTestId("site-customize-colors");
  for (const role of Object.keys(colors) as (keyof typeof NIGHT)[]) {
    await fields.getByLabel(site.customize.colors.roles[role], { exact: true }).fill(colors[role]);
  }
}

/** The public page's background color. */
async function backgroundOf(page: Page): Promise<string> {
  return page.locator("main").evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** Texts under 4.5:1 against the nearest painted background (WCAG AA). */
async function lowContrastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const backgroundOf = (element: Element | null): number[] => {
      for (let node = element; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length === 3 || (color.length === 4 && color[3] > 0)) return color;
      }
      return [255, 255, 255];
    };
    return [...document.querySelectorAll("main *")]
      .filter((element) => [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
      .map((element) => {
        const [a, b] = [luminance(rgb(getComputedStyle(element).color)), luminance(backgroundOf(element))];
        return { element: element.tagName.toLowerCase(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ element, ratio }) => `${element} ${ratio.toFixed(2)}`);
  });
}

function themeOptions(page: Page): Locator {
  return page.getByTestId("site-theme-option");
}

function themeOption(page: Page, theme: keyof typeof site.themes): Locator {
  return page.locator(`[data-testid="site-theme-option"][data-theme="${theme}"]`);
}

async function chooseTheme(page: Page, theme: keyof typeof site.themes) {
  const name = site.themes[theme].name;
  await themeOption(page, theme).getByRole("button", { name: `${site.design.use}: ${name}` }).click();
  await expect(page.getByTestId("site-theme-status")).toHaveText(`Guardamos el estilo «${name}».`);
  await expectSelectedTheme(page, theme);
}

/** Exactly one card is current, marked in words, with no save button. */
async function expectSelectedTheme(page: Page, theme: keyof typeof site.themes) {
  await expect(page.locator('[data-testid="site-theme-option"][aria-current="true"]')).toHaveCount(1);
  const current = themeOption(page, theme);
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(current.getByTestId("site-theme-selected")).toHaveText(`✓${site.design.selected}`);
  await expect(current.getByRole("button", { name: new RegExp(site.design.use) })).toHaveCount(0);
  await expect(page.getByTestId("site-theme-selected")).toHaveCount(1);
}

async function withDb<T>(run: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** The stored theme, or null when the wedding has no design row. */
async function designOf(weddingId: string): Promise<string | null> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ theme_key: string }>(
      "select theme_key from public.wedding_site_designs where wedding_id = $1",
      [weddingId],
    );
    return rows[0]?.theme_key ?? null;
  });
}

/** Hashes of the content and publication rows: what a theme save or a preview must leave alone. */
async function siteState(weddingId: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{ content: string; publication: string }>(
      `select (select md5(coalesce(string_agg(t::text, '|' order by t.kind), '')) from public.content_sections t where t.wedding_id = $1) as content,
              (select md5(coalesce(string_agg(p::text, '|'), '')) from public.wedding_publications p where p.wedding_id = $1) as publication`,
      [weddingId],
    );
    return rows[0];
  });
}

/** Fixture: a collaborator membership (the invite flow is covered elsewhere). */
async function addCollaborator(weddingId: string, email: string) {
  await withDb((db) =>
    db.query(
      `insert into public.wedding_memberships (wedding_id, user_id, role)
       select $1, id, 'collaborator' from auth.users where email = $2`,
      [weddingId, email],
    ),
  );
}

async function screenshotPreview(page: Page, testInfo: { outputPath: (name: string) => string }, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

/** A Supabase client signed in as a local fake account (for RPC-level setup without UI). */
async function signedInClient(email: string) {
  const { apiUrl, publishableKey } = readLocalSupabase();
  const supabase = createClient<Database>(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password: E2E_PASSWORD });
  if (error) throw new Error(`Could not sign in the local E2E account: ${error.code}`);
  return supabase;
}

async function saveSectionExpectingError(page: Page, kind: keyof typeof site.kinds, error: string) {
  const card = await sectionCard(page, kind);
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

/** One customization field (a fieldset of radios) in the page's «Personalizar». */
function customizeField(page: Page, field: keyof typeof site.customize.fields): Locator {
  return page.locator(`[data-testid="site-customize"] [data-testid="site-customize-field"][data-field="${field}"]`);
}

/** An option of a customization field, by its Spanish name. */
function radio(page: Page, field: keyof typeof site.customize.fields, name: string): Locator {
  return customizeField(page, field).getByRole("radio", { name: new RegExp(`^${name}( · ${site.customize.themeDefault})?$`) });
}

/** The stored theme and customization document. */
async function customizationOf(weddingId: string): Promise<{ theme: string; customization: unknown } | null> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ theme_key: string; customization: unknown }>(
      "select theme_key, customization from public.wedding_site_designs where wedding_id = $1",
      [weddingId],
    );
    return rows[0] ? { theme: rows[0].theme_key, customization: rows[0].customization } : null;
  });
}

/** The public page's palette and the section text's font family. */
async function expectPublicLook(page: Page, look: { palette: string; bodyFont: "serif" | "sans" }) {
  await expect(page.locator("main")).toHaveAttribute("data-site-palette", look.palette);
  const font = await page
    .locator('[data-testid="public-site-section"] p')
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font.includes("Georgia"), font).toBe(look.bodyFont === "serif");
}
