import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { createAccount, createWedding, es, logIn } from "./support/flows";
import { REJECTING_DOMAIN, emailsTo, expectEmailCount, type OutboxMessage } from "./support/outbox";

// LB-12: the RSVP confirmation email. The app under test writes emails to a
// local outbox (playwright.config.ts): nothing is ever sent. Addresses are
// fake (example.com). Guest links are bearer credentials: assertions on them
// are redacted, and the confirmation must never contain one.

const guests = es.guests;
const confirmation = guests.rsvpConfirmationEmail;
const rsvp = es.rsvp;
const site = es.site;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/([A-Za-z0-9_-]{43})$/;
const RUN = randomUUID().slice(0, 8);
let addressCounter = 0;

function address(label: string, domain = "example.com"): string {
  addressCounter += 1;
  return `e2e-${RUN}-${label}-${addressCounter}@${domain}`;
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function openGuests(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/guests`);
  await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
}

function party(page: Page, label: string): Locator {
  return page
    .getByTestId("guest-party")
    .filter({ has: page.getByRole("heading", { level: 3, name: label, exact: true }) });
}

/** "Nuevo grupo", optionally with a contact email; returns the link shown once. */
async function createParty(page: Page, label: string, names: string[], email?: string): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  if (email) await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  const url = await section.getByTestId("guest-link").inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

function tokenOf(link: string): string {
  return GUEST_LINK.exec(link)?.[1] ?? "";
}

async function openRsvp(page: Page, link: string, partyLabel: string) {
  await page.goto(link);
  await expect(page).toHaveURL(/\/rsvp$/);
  await expect(page.getByRole("heading", { level: 1, name: partyLabel })).toBeVisible();
}

/** Answers each guest (true = "Sí, asistirá") and saves. */
async function answer(page: Page, choices: Record<string, boolean>, submit: string = rsvp.submit) {
  for (const [name, attending] of Object.entries(choices)) {
    await page
      .getByRole("group", { name, exact: true })
      .getByRole("radio", { name: attending ? rsvp.yes : rsvp.no })
      .check();
  }
  await page.getByRole("button", { name: submit }).click();
  await expect(page.getByText(rsvp.saved)).toBeVisible();
}

/** Confirmation emails only (the invitation email has a different subject). */
async function confirmationsTo(to: string): Promise<OutboxMessage[]> {
  return (await emailsTo(to)).filter((m) => m.subject.startsWith("Confirmación de asistencia"));
}

/** No RSVP capability in any part of a confirmation. */
function expectNoCapability(email: OutboxMessage, token: string) {
  for (const part of [email.subject, email.text, email.html]) {
    expect(part.includes("/rsvp/"), "no RSVP link in the confirmation").toBe(false);
    expect(part.includes(token), "no capability token in the confirmation (value redacted)").toBe(false);
  }
}

test.describe("RSVP confirmation email", () => {
  test("A, B: first answer and a change each send a confirmation of the CURRENT answers", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb12-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Confirmación", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("confirma");
    const link = await createParty(page, "Familia Confirma", ["Ana Confirma", "Carlos Confirma"], recipient);
    const card = party(page, "Familia Confirma");
    await expect(card.getByTestId("party-rsvp-confirmation-status")).toHaveText(confirmation.never);
    expect(await emailsTo(recipient)).toEqual([]);

    // A: the guest answers; the RSVP is saved and one confirmation goes out.
    const guest = await freshPage(browser);
    await openRsvp(guest.page, link, "Familia Confirma");
    await answer(guest.page, { "Ana Confirma": true, "Carlos Confirma": true });
    await expect(guest.page.getByTestId("rsvp-confirmation-note")).toHaveText(rsvp.confirmation.sent);
    // The guest page never shows the stored address.
    expect(await guest.page.content()).not.toContain(recipient);

    const first = await expectEmailCount(recipient, 1);
    if (!first) throw new Error("no confirmation captured");
    expect(first.subject).toBe("Confirmación de asistencia — Boda de prueba Confirmación");
    expect(first.text).toContain("Hola, Familia Confirma:");
    expect(first.text).toContain(`- Ana Confirma: ${rsvp.status.attending}`);
    expect(first.text).toContain(`- Carlos Confirma: ${rsvp.status.attending}`);
    expect(first.text).toContain("1 de junio de 2090");
    expect(first.text).not.toContain(recipient);
    expectNoCapability(first, tokenOf(link));

    await page.reload();
    const status = card.getByTestId("party-rsvp-confirmation-status");
    await expect(status).toContainText("Última confirmación enviada el");
    await expect(status).toContainText(recipient);
    // The invitation status is a separate concept and stays "never sent".
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(guests.invitationEmail.never);

    // B: the guest changes one answer: a second confirmation with the new state.
    await guest.page.getByRole("link", { name: rsvp.change }).click();
    await answer(guest.page, { "Carlos Confirma": false }, rsvp.submitChanges);
    const second = await expectEmailCount(recipient, 2);
    if (!second) throw new Error("no second confirmation captured");
    expect(second.text).toContain(`- Ana Confirma: ${rsvp.status.attending}`);
    expect(second.text).toContain(`- Carlos Confirma: ${rsvp.status.not_attending}`);
    expectNoCapability(second, tokenOf(link));

    await page.reload();
    await expect(card.getByTestId("guest-row").filter({ hasText: "Carlos Confirma" })).toContainText(
      guests.status.not_attending,
    );
    await expect(card.getByTestId("party-rsvp-confirmation-status")).toContainText(recipient);
    await guest.context.close();
  });

  test("C: a party without a contact email answers normally; no email, no warning", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb12-noemail"));
    const weddingId = await createWedding(page, "Boda de prueba Sin Correo", "2090-06-01");
    await openGuests(page, weddingId);
    const link = await createParty(page, "Familia Sin Correo", ["Sol Sin Correo"]);

    const guest = await freshPage(browser);
    await openRsvp(guest.page, link, "Familia Sin Correo");
    await answer(guest.page, { "Sol Sin Correo": true });
    await expect(guest.page.getByTestId("rsvp-summary")).toContainText(rsvp.status.attending);
    await expect(guest.page.getByTestId("rsvp-confirmation-note")).toHaveCount(0);
    await expect(guest.page.getByText(rsvp.confirmation.failed)).toHaveCount(0);

    await page.reload();
    await expect(party(page, "Familia Sin Correo").getByTestId("party-rsvp-confirmation-status")).toHaveText(
      confirmation.never,
    );
    await guest.context.close();
  });

  test("D: a provider failure never fails the RSVP: saved, a soft mail warning, nothing recorded", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb12-fail"));
    const weddingId = await createWedding(page, "Boda de prueba Fallo Confirmación", "2090-06-01");
    await openGuests(page, weddingId);
    const failing = address("falla", REJECTING_DOMAIN);
    const link = await createParty(page, "Familia Fallo", ["Uno Fallo", "Dos Fallo"], failing);

    const guest = await freshPage(browser);
    await openRsvp(guest.page, link, "Familia Fallo");
    await answer(guest.page, { "Uno Fallo": true, "Dos Fallo": false });
    await expect(guest.page.getByTestId("rsvp-confirmation-note")).toHaveText(rsvp.confirmation.failed);
    await expect(guest.page.getByText(rsvp.errors.failed)).toHaveCount(0);

    // The answers really persisted.
    await openRsvp(guest.page, link, "Familia Fallo");
    await expect(
      guest.page.getByRole("group", { name: "Uno Fallo", exact: true }).getByRole("radio", { name: rsvp.yes }),
    ).toBeChecked();
    await expect(
      guest.page.getByRole("group", { name: "Dos Fallo", exact: true }).getByRole("radio", { name: rsvp.no }),
    ).toBeChecked();

    expect(await emailsTo(failing)).toEqual([]);
    await page.reload();
    const card = party(page, "Familia Fallo");
    await expect(card.getByTestId("party-rsvp-confirmation-status")).toHaveText(confirmation.never);
    await expect(card.getByTestId("guest-row").filter({ hasText: "Uno Fallo" })).toContainText(
      guests.status.attending,
    );
    await guest.context.close();
  });

  test("E, F: the published website is linked (never the RSVP link); no page shows the contact data", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb12-site"));
    const weddingId = await createWedding(page, "Boda de prueba Sitio Confirmación", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("sitio");
    const link = await createParty(page, "Familia Sitio", ["Sol Sitio"], recipient);

    // Unpublished: no website link.
    const guest = await freshPage(browser);
    await openRsvp(guest.page, link, "Familia Sitio");
    await answer(guest.page, { "Sol Sitio": true });
    const unpublished = await expectEmailCount(recipient, 1);
    if (!unpublished) throw new Error("no confirmation captured");
    expect(unpublished.text).not.toContain("/boda/");
    expect(unpublished.html).not.toContain("/boda/");
    expectNoCapability(unpublished, tokenOf(link));

    // Publish the site, answer again: the website is linked.
    const slug = `confirma-${RUN}`;
    await page.goto(`/app/weddings/${weddingId}/site`);
    await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.saved)).toBeVisible();
    const intro = page.locator('[data-testid="site-section"][data-kind="intro"]');
    await intro.getByLabel(site.sections.bodyLabel).fill("Bienvenidos a nuestra boda.");
    await intro.getByLabel(site.sections.visibleLabel).setChecked(true);
    await intro.getByRole("button", { name: site.sections.submit }).click();
    await expect(intro.getByRole("status")).toHaveText(site.sections.saved);
    await page.getByRole("button", { name: site.publish.submit }).click();
    await expect(page.getByText(site.publish.done)).toBeVisible();

    await openRsvp(guest.page, link, "Familia Sitio");
    await answer(guest.page, { "Sol Sitio": false }, rsvp.submitChanges);
    const published = await expectEmailCount(recipient, 2);
    if (!published) throw new Error("no confirmation captured");
    const siteUrl = `http://localhost:3100/boda/${slug}`;
    expect(published.text).toContain(siteUrl);
    expect(published.html).toContain(`href="${siteUrl}"`);
    expectNoCapability(published, tokenOf(link));
    expect(await confirmationsTo(recipient)).toHaveLength(2);

    // F: neither the RSVP page nor the public website shows the contact
    // email, the last recipient or the provider id.
    const rsvpHtml = await guest.page.content();
    const visitor = await freshPage(browser);
    await visitor.page.goto(siteUrl);
    const publicHtml = await visitor.page.content();
    for (const html of [rsvpHtml, publicHtml]) {
      expect(html).not.toContain(recipient);
      expect(html).not.toContain(published.messageId);
      expect(html).not.toContain(unpublished.messageId);
    }
    await Promise.all([guest.context.close(), visitor.context.close()]);
  });
});
