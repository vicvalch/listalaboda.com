import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";
import { emailsTo, expectEmailCount, rsvpLinkOf } from "./support/outbox";

// LB-13 (ADR-006): a party's personal RSVP link can be shown again, as the
// SAME link, after an explicit "Mostrar enlace" — never on page load. The
// app runs with a fake, test-only encryption key (playwright.config.ts).
// Guest links are bearer credentials: assertions on them are redacted.

const guests = es.guests;
const personal = guests.personalLink;
const rsvp = es.rsvp;
const site = es.site;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/([A-Za-z0-9_-]{43})$/;
const RUN = randomUUID().slice(0, 8);
const SECRETS = "private.guest_invitation_capability_secrets";

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

function tokenOf(link: string): string {
  const token = GUEST_LINK.exec(link)?.[1];
  expect(token !== undefined, "guest link has the expected shape (value redacted)").toBe(true);
  return token as string;
}

async function readField(scope: Locator | Page, testId: string): Promise<string> {
  const field = scope.getByTestId(testId);
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  tokenOf(url);
  return url;
}

/** "Nuevo grupo"; returns the link shown right after creation. */
async function createParty(page: Page, label: string, names: string[], email?: string): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  if (email) await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  return readField(section, "guest-link");
}

/** Explicit "Mostrar enlace" on a party card; returns the recovered link. */
async function showLink(page: Page, label: string): Promise<string> {
  const card = party(page, label);
  await card.getByRole("button", { name: personal.show }).click();
  return readField(card, "recovered-guest-link");
}

async function rotateLink(page: Page, label: string): Promise<string> {
  const card = party(page, label);
  await card.getByRole("button", { name: guests.rotate.open }).click();
  await card.getByRole("button", { name: guests.rotate.confirmButton }).click();
  return readField(card, "guest-link");
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
}

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Ground truth for one party: its stored hash and envelope (test tooling only). */
async function stored(weddingId: string, label: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string; token_hash: string; token_ciphertext: string | null }>(
      `select i.id, i.token_hash, s.token_ciphertext
       from public.guest_invitations i
       left join ${SECRETS} s on s.guest_invitation_id = i.id
       where i.wedding_id = $1 and i.label = $2`,
      [weddingId, label],
    );
    if (rows.length !== 1) throw new Error("party not found");
    return rows[0]!;
  });
}

/** Fixture: turns a party into the pre-LB-13 state (hash only, no envelope). */
async function makeLegacy(weddingId: string, label: string) {
  const { id } = await stored(weddingId, label);
  await withDb((db) => db.query(`delete from ${SECRETS} where guest_invitation_id = $1`, [id]));
}

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

test.describe("recoverable RSVP link", () => {
  test("A, E: the same link after a reload, only on request; nothing on the page before", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb13-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Enlace", "2090-06-01");
    await openGuests(page, weddingId);
    const original = await createParty(page, "Familia Igual", ["Ana Igual", "Luis Igual"]);
    const token = tokenOf(original);

    // A fresh request: the link is nowhere in the page (HTML or RSC payload).
    await page.reload();
    const card = party(page, "Familia Igual");
    await expect(card.getByRole("button", { name: personal.show })).toBeVisible();
    await expect(page.getByTestId("guest-link")).toHaveCount(0);
    await expect(page.getByTestId("recovered-guest-link")).toHaveCount(0);
    const html = await page.content();
    const { token_ciphertext: envelope, token_hash: hash } = await stored(weddingId, "Familia Igual");
    expect(envelope).toMatch(/^v1\./);
    for (const secret of [token, envelope!, hash]) {
      expect(html.includes(secret), "no token, envelope or hash in the page (value redacted)").toBe(false);
    }
    const raw = await (await page.request.get(`/app/weddings/${weddingId}/guests`)).text();
    expect(raw.includes(token) || raw.includes(envelope!), "nothing in the raw response").toBe(false);
    // Nothing stored in the browser either.
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(storage.includes(token)).toBe(false);

    // Explicit recovery: exactly the original link.
    const recovered = await showLink(page, "Familia Igual");
    expect(recovered === original, "recovered link equals the original (value redacted)").toBe(true);
    expect(page.url()).not.toContain(token);
    expect((await page.context().cookies()).some((c) => c.value.includes(token))).toBe(false);

    // "Ocultar" drops it from the page.
    await card.getByRole("button", { name: personal.hide }).click();
    await expect(card.getByTestId("recovered-guest-link")).toHaveCount(0);
    expect((await page.content()).includes(token)).toBe(false);

    // And it is the working capability.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, recovered, "Familia Igual");
    // The guest page carries no envelope.
    expect((await guest.page.content()).includes(envelope!)).toBe(false);
    await guest.context.close();
  });

  test("B: a collaborator recovers the same link but can't rotate it", async ({ page, browser }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb13-collab");
    await openGuests(page, weddingId);
    const original = await createParty(page, "Amigos Colabora", ["Tomás"]);

    await openGuests(collab.page, weddingId);
    const recovered = await showLink(collab.page, "Amigos Colabora");
    expect(recovered === original, "same link for the collaborator (value redacted)").toBe(true);
    const card = party(collab.page, "Amigos Colabora");
    await expect(card.getByRole("button", { name: guests.rotate.open })).toHaveCount(0);

    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, recovered, "Amigos Colabora");
    await guest.context.close();
    await collab.context.close();
  });

  test("C, D: a pre-LB-13 link works but can't be shown; only an owner's explicit new link repairs it", async ({
    page,
    browser,
  }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb13-legacy");
    await openGuests(page, weddingId);
    const legacyLink = await createParty(page, "Familia Antigua", ["Elena"]);
    await makeLegacy(weddingId, "Familia Antigua");
    const before = await stored(weddingId, "Familia Antigua");
    expect(before.token_ciphertext).toBeNull();

    // C: the guest's link still works.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, legacyLink, "Familia Antigua");

    // Organizers can't recover it; the owner is pointed to "Generar nuevo enlace".
    await page.reload();
    const card = party(page, "Familia Antigua");
    await card.getByRole("button", { name: personal.show }).click();
    await expect(card.getByTestId("personal-link-result")).toHaveText(`${personal.legacy} ${personal.regenerateOwner}`);
    await expect(card.getByTestId("recovered-guest-link")).toHaveCount(0);

    await openGuests(collab.page, weddingId);
    const collabCard = party(collab.page, "Familia Antigua");
    await collabCard.getByRole("button", { name: personal.show }).click();
    await expect(collabCard.getByTestId("personal-link-result")).toHaveText(
      `${personal.legacy} ${personal.regenerateCollaborator}`,
    );
    await expect(collabCard.getByRole("button", { name: guests.rotate.open })).toHaveCount(0);

    // Nothing was mutated silently.
    expect(await stored(weddingId, "Familia Antigua")).toEqual(before);
    await expectGuestPage(guest.page, legacyLink, "Familia Antigua");

    // D: the owner explicitly generates a new link.
    const newLink = await rotateLink(page, "Familia Antigua");
    expect(newLink === legacyLink).toBe(false);
    await expectUnavailable(guest.page, legacyLink);
    await expectGuestPage(guest.page, newLink, "Familia Antigua");

    await page.reload();
    const recovered = await showLink(page, "Familia Antigua");
    expect(recovered === newLink, "recovery returns the NEW link (value redacted)").toBe(true);
    await guest.context.close();
    await collab.context.close();
  });

  test("E: the public site and the RSVP page carry no token, envelope or hash", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb13-site"));
    const weddingId = await createWedding(page, "Boda de prueba Sitio Enlace", "2090-06-01");
    await openGuests(page, weddingId);
    const link = await createParty(page, "Familia Pública", ["Paula"]);
    const { token_ciphertext: envelope, token_hash: hash } = await stored(weddingId, "Familia Pública");
    const secrets = [tokenOf(link), envelope!, hash];

    // Publish a minimal site through the real editor.
    await page.goto(`/app/weddings/${weddingId}/site`);
    const intro = page.locator('[data-testid="site-section"][data-kind="intro"]');
    await intro.getByLabel(site.sections.bodyLabel).fill("Bienvenidos a nuestra boda de prueba.");
    await intro.getByLabel(site.sections.visibleLabel).setChecked(true);
    await intro.getByRole("button", { name: site.sections.submit }).click();
    await expect(intro.getByRole("status")).toHaveText(site.sections.saved);
    const slug = `enlace-${randomBytes(4).toString("hex")}`;
    await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
    await page.getByRole("button", { name: site.slug.submit }).click();
    await expect(page.getByText(site.slug.saved)).toBeVisible();
    await page.getByRole("button", { name: site.publish.submit }).click();
    await expect(page.getByText(site.publish.done)).toBeVisible();

    const visitor = await freshPage(browser);
    const response = await visitor.page.goto(`/boda/${slug}`);
    expect(response?.status()).toBe(200);
    const publicHtml = await visitor.page.content();
    for (const secret of secrets) {
      expect(publicHtml.includes(secret), "nothing secret on the public site (value redacted)").toBe(false);
    }

    await expectGuestPage(visitor.page, link, "Familia Pública");
    const rsvpHtml = await visitor.page.content();
    for (const secret of [envelope!, hash]) {
      expect(rsvpHtml.includes(secret), "no envelope or hash on the RSVP page (value redacted)").toBe(false);
    }
    await visitor.context.close();
  });

  test("F: the invitation email carries the current link (the one recovered later); the confirmation carries none", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb13-mail"));
    const weddingId = await createWedding(page, "Boda de prueba Correo Enlace", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = `e2e-${RUN}-enlace@example.com`;
    const original = await createParty(page, "Familia Correo", ["Marta"], recipient);

    // Send the invitation with the fresh link.
    const section = page.getByRole("region", { name: guests.newParty.title });
    await section.getByRole("button", { name: guests.invitationEmail.sendFresh }).click();
    await expect(section.getByTestId("invitation-email-result")).toContainText(recipient);
    const invitation = await expectEmailCount(recipient, 1);
    if (!invitation) throw new Error("no invitation captured");
    const emailed = rsvpLinkOf(invitation);
    expect(emailed === original, "the email carries the link shown at creation (value redacted)").toBe(true);

    // Later: recovery gives that same link (sending created no second token).
    await page.reload();
    const recovered = await showLink(page, "Familia Correo");
    expect(recovered === emailed, "recovered link equals the emailed one (value redacted)").toBe(true);

    // The guest answers; the confirmation has no capability at all.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, recovered, "Familia Correo");
    await guest.page.getByRole("group", { name: "Marta", exact: true }).getByRole("radio", { name: rsvp.yes }).check();
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await expectEmailCount(recipient, 2);
    const confirmation = (await emailsTo(recipient)).find((m) => m.subject.startsWith("Confirmación de asistencia"));
    if (!confirmation) throw new Error("no confirmation captured");
    const { token_ciphertext: envelope } = await stored(weddingId, "Familia Correo");
    for (const part of [confirmation.subject, confirmation.text, confirmation.html]) {
      expect(part.includes("/rsvp/"), "no RSVP link in the confirmation").toBe(false);
      expect(part.includes(tokenOf(recovered)), "no token in the confirmation (value redacted)").toBe(false);
      expect(part.includes(envelope!), "no envelope in the confirmation (value redacted)").toBe(false);
    }
    await guest.context.close();
  });
});
