import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { REJECTING_DOMAIN, emailsTo, expectEmailCount, rsvpLinkOf } from "./support/outbox";

// LB-11: the party's contact email and its invitation email. The app under
// test writes emails to a local outbox (playwright.config.ts) — nothing is
// ever sent. Addresses are fake (example.com). Guest links are bearer
// credentials: assertions on them are redacted.

const guests = es.guests;
const contact = guests.contactEmail;
const mail = guests.invitationEmail;
const rsvp = es.rsvp;
const site = es.site;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;
const RUN = randomUUID().slice(0, 8);
let addressCounter = 0;

/** A fresh fake recipient for this run. */
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

async function readLink(scope: Locator | Page): Promise<string> {
  const field = scope.getByTestId("guest-link");
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

function newPartySection(page: Page) {
  return page.getByRole("region", { name: guests.newParty.title });
}

/** "Nuevo grupo", optionally with a contact email; returns the link shown once. */
async function createParty(page: Page, label: string, names: string[], email?: string): Promise<string> {
  const section = newPartySection(page);
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  if (email) await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  return readLink(section);
}

async function saveEmail(card: Locator, email: string, open: string) {
  await card.getByText(open, { exact: true }).click();
  await card.getByLabel(contact.fieldLabel).fill(email);
  await card.getByRole("button", { name: contact.submit }).click();
}

async function expectGuestPage(page: Page, link: string, partyLabel: string) {
  const response = await page.goto(link);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/rsvp$/);
  await expect(page.getByRole("heading", { level: 1, name: partyLabel })).toBeVisible();
}

async function expectUnavailable(page: Page, link: string) {
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: rsvp.unavailable.title })).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(0);
}

/** Invitation emails only: since LB-12, answering also sends a confirmation. */
async function invitationsTo(to: string) {
  return (await emailsTo(to)).filter((m) => m.subject.startsWith("Tu invitación a"));
}

async function answerAll(page: Page, names: string[]) {
  for (const name of names) {
    await page.getByRole("group", { name, exact: true }).getByRole("radio", { name: rsvp.yes }).check();
  }
  await page.getByRole("button", { name: rsvp.submit }).click();
  await expect(page.getByText(rsvp.saved)).toBeVisible();
}

/** Owner + a collaborator who joined through a real MembershipInvite. */
async function ownerAndCollaborator(browser: Browser, page: Page, label: string) {
  await logIn(page, await createAccount(`${label}-owner`));
  const weddingId = await createWedding(page, `Boda de prueba ${label}`, "2090-06-01");
  const inviteUrl = await createInvite(page, "collaborator");
  const collab = await freshPage(browser);
  await logIn(collab.page, await createAccount(`${label}-collab`));
  await collab.page.goto(inviteUrl);
  await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
  await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
  return { weddingId, collab };
}

type CapturedAction = { url: string; headers: Record<string, string>; body: Buffer };

/** Captures a Server Action request WITHOUT letting it reach the server. */
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

test.describe("guest invitation email", () => {
  test("A, B: the owner adds a contact email, the collaborator edits it; outsiders never see it", async ({
    page,
    browser,
  }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb11-contact");
    await openGuests(page, weddingId);
    const link = await createParty(page, "Familia Contacto", ["Ana Contacto", "Luis Contacto"]);
    const card = party(page, "Familia Contacto");
    await expect(card.getByTestId("party-contact-email")).toHaveText(contact.none);
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(mail.never);
    await expect(card.getByText(mail.needsEmail)).toBeVisible();

    // A: invalid first (clear, non-technical), then a valid one; the domain is normalized.
    await saveEmail(card, "no-es-un-correo", contact.add);
    await expect(card.getByText(contact.validation.invalid)).toBeVisible();
    const first = address("contacto");
    await card.getByLabel(contact.fieldLabel).fill(first.replace("example.com", "Example.COM"));
    await card.getByRole("button", { name: contact.submit }).click();
    await expect(card.getByText(contact.saved)).toBeVisible();
    await expect(card.getByTestId("party-contact-email")).toHaveText(first);
    // The owner can now "Generar nuevo enlace y enviar".
    await expect(card.getByRole("button", { name: mail.rotateSend.open })).toBeVisible();

    // B: the collaborator sees and edits it, but can't regenerate + send.
    await openGuests(collab.page, weddingId);
    const collabCard = party(collab.page, "Familia Contacto");
    await expect(collabCard.getByTestId("party-contact-email")).toHaveText(first);
    await expect(collabCard.getByRole("button", { name: mail.rotateSend.open })).toHaveCount(0);
    await expect(collabCard.getByTestId("invitation-email-owner-required")).toHaveText(mail.ownerRequired);
    const second = address("editado");
    await saveEmail(collabCard, second, contact.edit);
    await expect(collabCard.getByText(contact.saved)).toBeVisible();
    await page.reload();
    await expect(card.getByTestId("party-contact-email")).toHaveText(second);

    // Editing the email never touched the link.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, link, "Familia Contacto");
    // M: the RSVP page never shows the contact email.
    await expect(guest.page.getByText(second)).toHaveCount(0);
    expect(await guest.page.content()).not.toContain(second);

    // Removing it keeps the party, its guests and its link.
    await collabCard.getByRole("button", { name: contact.remove.open }).click();
    await expect(collabCard.getByText(contact.remove.confirmBody)).toBeVisible();
    await collabCard.getByRole("button", { name: contact.remove.confirmButton }).click();
    await expect(collabCard.getByTestId("party-contact-email")).toHaveText(contact.none);
    await expectGuestPage(guest.page, link, "Familia Contacto");

    // An outsider gets the same 404 as for any other wedding.
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb11-contact-outsider"));
    const response = await outsider.page.goto(`/app/weddings/${weddingId}/guests`);
    expect(response?.status()).toBe(404);
    expect(await outsider.page.content()).not.toContain(first);

    // Nothing was ever sent.
    expect(await emailsTo(first)).toEqual([]);
    expect(await emailsTo(second)).toEqual([]);
    await Promise.all([collab.context.close(), guest.context.close(), outsider.context.close()]);
  });

  test("C, D, E, G, K, O: a new party's fresh link is emailed and works; RSVP sends only a confirmation", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb11-send-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Correo", "2090-06-01");
    await openGuests(page, weddingId);

    // C: create with an email; the link is still shown for manual sharing.
    const recipient = address("fresco");
    const shownLink = await createParty(page, "Familia Correo", ["Ana Correo", "Luis Correo"], recipient);
    const section = newPartySection(page);
    await expect(party(page, "Familia Correo").getByTestId("party-invitation-email-status")).toHaveText(mail.never);
    // Creating never sends by itself.
    expect(await emailsTo(recipient)).toEqual([]);

    await section.getByRole("button", { name: mail.sendFresh }).click();
    await expect(section.getByTestId("invitation-email-result")).toHaveText(
      mail.sent.replace("{email}", recipient),
    );

    // D: one email, to the party's address, carrying exactly the shown link.
    const email = await expectEmailCount(recipient, 1);
    if (!email) throw new Error("no email captured");
    expect(email.subject).toBe("Tu invitación a Boda de prueba Correo");
    expect(email.text).toContain("Hola, Familia Correo:");
    expect(email.text).toContain("1 de junio de 2090");
    expect(rsvpLinkOf(email) === shownLink, "emailed link is the shown link (value redacted)").toBe(true);
    expect(email.html).toContain(es.invitationEmail.cta);
    // G: the site isn't published, so no website link.
    expect(email.text).not.toContain("/boda/");
    expect(email.html).not.toContain("/boda/");
    // Never other parties, answers or member data.
    expect(email.text).not.toContain("Ana Correo");

    // K: the status shows the send (date/time and recipient).
    await page.reload();
    const status = party(page, "Familia Correo").getByTestId("party-invitation-email-status");
    await expect(status).toContainText("Última invitación enviada el");
    await expect(status).toContainText(recipient);

    // E: the emailed link works for the guest, without an account.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, rsvpLinkOf(email), "Familia Correo");
    // O (LB-12): answering sends one RSVP confirmation — a different email,
    // without the link — and never another invitation.
    await answerAll(guest.page, ["Ana Correo", "Luis Correo"]);
    const confirmation = await expectEmailCount(recipient, 2);
    expect(confirmation?.subject).toBe("Confirmación de asistencia — Boda de prueba Correo");
    expect(confirmation?.text.includes("/rsvp/"), "no RSVP link in the confirmation").toBe(false);
    expect(await invitationsTo(recipient)).toHaveLength(1);
    await guest.context.close();
  });

  test("F, M, N: the published website is linked and resolves; public pages never show the email", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb11-site-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Sitio Correo", "2090-06-01");
    const slug = `correo-${RUN}`;
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

    await openGuests(page, weddingId);
    const recipient = address("sitio");
    await createParty(page, "Familia Sitio", ["Sol Sitio"], recipient);
    await newPartySection(page).getByRole("button", { name: mail.sendFresh }).click();
    const email = await expectEmailCount(recipient, 1);
    if (!email) throw new Error("no email captured");

    // F: both links resolve.
    const siteUrl = `http://localhost:3100/boda/${slug}`;
    expect(email.text).toContain(siteUrl);
    expect(email.html).toContain(`href="${siteUrl}"`);
    const visitor = await freshPage(browser);
    const publicResponse = await visitor.page.goto(siteUrl);
    expect(publicResponse?.status()).toBe(200);
    // M: the public website never shows the contact email.
    expect(await visitor.page.content()).not.toContain(recipient);
    // N: still no open RSVP on the public site.
    await expect(visitor.page.locator("form")).toHaveCount(0);
    await expect(visitor.page.getByRole("radio")).toHaveCount(0);

    await expectGuestPage(visitor.page, rsvpLinkOf(email), "Familia Sitio");
    expect(await visitor.page.content()).not.toContain(recipient);
    await visitor.context.close();
  });

  test("H, I: the owner regenerates and sends (old link dies, answers stay); a collaborator can't, even forged", async ({
    page,
    browser,
  }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb11-rotate");
    await openGuests(page, weddingId);
    const recipient = address("rotar");
    const oldLink = await createParty(page, "Familia Rotar", ["Ana Rotar", "Luis Rotar"], recipient);

    // The party answers with the original link.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, oldLink, "Familia Rotar");
    await answerAll(guest.page, ["Ana Rotar", "Luis Rotar"]);

    // After a reload the plaintext is gone: emailing needs a new link.
    await page.reload();
    const card = party(page, "Familia Rotar");
    await expect(page.getByTestId("guest-link")).toHaveCount(0);

    // I: a forged request — the owner's own "Generar nuevo enlace y enviar",
    // replayed from the collaborator's session — is refused, sends nothing.
    await openGuests(collab.page, weddingId);
    await expect(party(collab.page, "Familia Rotar").getByRole("button", { name: mail.rotateSend.open })).toHaveCount(0);
    const forged = await captureAction(page, async () => {
      await card.getByRole("button", { name: mail.rotateSend.open }).click();
      await card.getByRole("button", { name: mail.rotateSend.confirmButton }).click();
    });
    expect(await replayAction(collab.page, forged)).toContain(mail.ownerRequired);
    expect(await invitationsTo(recipient)).toEqual([]);
    await expectGuestPage(guest.page, oldLink, "Familia Rotar");

    // H: the owner confirms explicitly (the warning names the address).
    await page.reload();
    await card.getByRole("button", { name: mail.rotateSend.open }).click();
    await expect(card.getByText(mail.rotateSend.confirmBody.replace("{email}", recipient))).toBeVisible();
    await card.getByRole("button", { name: mail.rotateSend.confirmButton }).click();
    await expect(card.getByTestId("invitation-email-result")).toContainText(mail.sent.replace("{email}", recipient));
    // The new link is still shown for manual sharing.
    const shown = await readLink(card);

    // The party's answer earlier sent its RSVP confirmation (LB-12); this is the invitation.
    const email = await expectEmailCount(recipient, 2);
    if (!email) throw new Error("no email captured");
    expect(await invitationsTo(recipient)).toHaveLength(1);
    const newLink = rsvpLinkOf(email);
    expect(newLink === shown, "emailed link is the shown link (value redacted)").toBe(true);
    expect(newLink !== oldLink, "a new link was generated (value redacted)").toBe(true);

    await expectUnavailable(guest.page, oldLink);
    await expectGuestPage(guest.page, newLink, "Familia Rotar");
    // Guests and their answers stayed.
    await page.reload();
    await expect(card.getByTestId("guest-status")).toHaveText([guests.status.attending, guests.status.attending]);
    await expect(card.getByTestId("party-invitation-email-status")).toContainText(recipient);

    await Promise.all([collab.context.close(), guest.context.close()]);
  });

  test("J, K: a provider failure keeps every link usable and records no send", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb11-fail-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Fallo", "2090-06-01");
    await openGuests(page, weddingId);
    const failing = address("falla", REJECTING_DOMAIN);

    // New party: the email fails; the party and its link are fine.
    const link = await createParty(page, "Familia Fallo", ["Uno Fallo"], failing);
    const section = newPartySection(page);
    await section.getByRole("button", { name: mail.sendFresh }).click();
    await expect(section.getByTestId("invitation-email-result")).toHaveText(mail.errors.providerFailed);
    expect(await readLink(section)).toBe(link);
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, link, "Familia Fallo");

    await page.reload();
    const card = party(page, "Familia Fallo");
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(mail.never);

    // Regenerate + send fails: the rotation stands and the new link is shown,
    // with a retry; the old link is gone.
    await card.getByRole("button", { name: mail.rotateSend.open }).click();
    await card.getByRole("button", { name: mail.rotateSend.confirmButton }).click();
    const result = card.getByTestId("invitation-email-result").first();
    await expect(result.getByRole("alert")).toHaveText(mail.errors.rotatedNotSent);
    const newLink = await readLink(card);
    expect(newLink !== link, "a new link was generated (value redacted)").toBe(true);
    await expect(card.getByRole("button", { name: mail.sendFresh })).toBeVisible();
    await expectUnavailable(guest.page, link);
    await expectGuestPage(guest.page, newLink, "Familia Fallo");

    await page.reload();
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(mail.never);
    expect(await emailsTo(failing)).toEqual([]);
    await guest.context.close();
  });
});
