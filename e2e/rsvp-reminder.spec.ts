import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";
import { REJECTING_DOMAIN, emailsTo, expectEmailCount, rsvpLinkOf, type OutboxMessage } from "./support/outbox";

// LB-14 (ADR-007): manual RSVP reminders with the party's SAME current link
// — by email ("Enviar recordatorio") or as a WhatsApp-ready text to copy
// ("Preparar mensaje para WhatsApp"). The app writes emails to a local
// outbox (playwright.config.ts); nothing is sent. Addresses are fake. Guest
// links are bearer credentials: assertions on them are redacted.

const guests = es.guests;
const reminder = guests.reminder;
const personal = guests.personalLink;
const rsvp = es.rsvp;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/([A-Za-z0-9_-]{43})$/;
const RUN = randomUUID().slice(0, 8);
const SECRETS = "private.guest_invitation_capability_secrets";
let addressCounter = 0;

function address(label: string, domain = "example.com"): string {
  addressCounter += 1;
  return `e2e-${RUN}-rec-${label}-${addressCounter}@${domain}`;
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

function tokenOf(link: string): string {
  const token = GUEST_LINK.exec(link)?.[1];
  expect(token !== undefined, "guest link has the expected shape (value redacted)").toBe(true);
  return token as string;
}

/** "Nuevo grupo"; returns the link shown right after creation. */
async function createParty(page: Page, label: string, names: string[], email?: string): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  if (email) await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  const url = await section.getByTestId("guest-link").inputValue();
  tokenOf(url);
  return url;
}

async function rotateLink(page: Page, label: string): Promise<string> {
  const card = party(page, label);
  await card.getByRole("button", { name: guests.rotate.open, exact: true }).click();
  await card.getByRole("button", { name: guests.rotate.confirmButton }).click();
  const field = card.getByTestId("guest-link");
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  tokenOf(url);
  return url;
}

async function sendReminder(page: Page, label: string): Promise<Locator> {
  const card = party(page, label);
  await card.getByRole("button", { name: reminder.send }).click();
  const result = card.getByTestId("reminder-email-result");
  await expect(result).toBeVisible();
  return result;
}

async function prepareWhatsApp(page: Page, label: string): Promise<string> {
  const card = party(page, label);
  await card.getByRole("button", { name: reminder.whatsapp.prepare }).click();
  const field = card.getByTestId("reminder-message");
  await expect(field).toBeVisible();
  return field.inputValue();
}

/** Reminder emails only (invitations and confirmations have other subjects). */
async function remindersTo(to: string): Promise<OutboxMessage[]> {
  return (await emailsTo(to)).filter((m) => m.subject.startsWith("Recordatorio de confirmación"));
}

async function expectReminderCount(to: string, count: number): Promise<OutboxMessage | undefined> {
  await expect.poll(async () => (await remindersTo(to)).length, { message: "reminder count" }).toBe(count);
  return (await remindersTo(to)).at(-1);
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

/** Ground truth for one party's link and reminder status (test tooling only). */
async function stored(weddingId: string, label: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{
      id: string;
      token_hash: string;
      token_issued_at: Date;
      revoked_at: Date | null;
      token_ciphertext: string | null;
      reminder_sent_at: Date | null;
      reminder_sent_to: string | null;
    }>(
      `select i.id, i.token_hash, i.token_issued_at, i.revoked_at, s.token_ciphertext,
              i.rsvp_reminder_email_sent_at as reminder_sent_at, i.rsvp_reminder_email_sent_to as reminder_sent_to
       from public.guest_invitations i
       left join ${SECRETS} s on s.guest_invitation_id = i.id
       where i.wedding_id = $1 and i.label = $2`,
      [weddingId, label],
    );
    if (rows.length !== 1) throw new Error("party not found");
    return rows[0]!;
  });
}

const linkFields = (s: Awaited<ReturnType<typeof stored>>) => ({
  hash: s.token_hash,
  issued: s.token_issued_at,
  revoked: s.revoked_at,
  envelope: s.token_ciphertext,
});

/** No token anywhere in a fresh page load (HTML + RSC payload) or browser storage. */
async function expectNoTokenOnPage(page: Page, weddingId: string, token: string) {
  const html = await page.content();
  expect(html.includes(token), "no token in the page (value redacted)").toBe(false);
  const raw = await (await page.request.get(`/app/weddings/${weddingId}/guests`)).text();
  expect(raw.includes(token), "no token in the raw response (value redacted)").toBe(false);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage.includes(token), "no token in browser storage (value redacted)").toBe(false);
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

test.describe("manual RSVP reminders", () => {
  test("A: the owner emails a reminder with the SAME link; one email, the right recipient, the status shows", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb14-email"));
    const weddingId = await createWedding(page, "Boda de prueba Recordatorio", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("familia");
    const original = await createParty(page, "Familia Recordatorio", ["Ana Recuerdo", "Luis Recuerdo"], recipient);
    const token = tokenOf(original);
    const before = await stored(weddingId, "Familia Recordatorio");

    // A fresh request: no link anywhere before an explicit action.
    await page.reload();
    const card = party(page, "Familia Recordatorio");
    await expect(card.getByTestId("party-reminder-email-status")).toHaveText(reminder.never);
    await expect(card.getByText(`Enviaremos el enlace personal actual del grupo a ${recipient}.`)).toBeVisible();
    await expectNoTokenOnPage(page, weddingId, token);

    const result = await sendReminder(page, "Familia Recordatorio");
    await expect(result).toHaveText(`Recordatorio enviado a ${recipient}.`);

    const email = await expectReminderCount(recipient, 1);
    if (!email) throw new Error("no reminder captured");
    expect(email.to).toBe(recipient);
    expect(email.subject).toBe("Recordatorio de confirmación — Boda de prueba Recordatorio");
    expect(email.text).toContain("Hola, Familia Recordatorio:");
    const reminded = rsvpLinkOf(email);
    expect(reminded === original, "the reminder carries the original link (value redacted)").toBe(true);
    // Exactly one email in total for this address (no invitation, no duplicate).
    await expectEmailCount(recipient, 1);

    // The latest reminder status, separate from invitation and confirmation.
    await page.reload();
    await expect(card.getByTestId("party-reminder-email-status")).toContainText("Último recordatorio enviado el");
    await expect(card.getByTestId("party-reminder-email-status")).toContainText(recipient);
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(guests.invitationEmail.never);
    await expect(card.getByTestId("party-rsvp-confirmation-status")).toHaveText(guests.rsvpConfirmationEmail.never);

    // Nothing about the link changed, and it still works; still no token on the page.
    const after = await stored(weddingId, "Familia Recordatorio");
    expect(linkFields(after)).toEqual(linkFields(before));
    expect(after.reminder_sent_to).toBe(recipient);
    await expectNoTokenOnPage(page, weddingId, token);
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, reminded, "Familia Recordatorio");
    await guest.context.close();
  });

  test("B: a collaborator sends a reminder with the same link and still can't rotate", async ({ page, browser }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb14-collab");
    await openGuests(page, weddingId);
    const recipient = address("colabora");
    const original = await createParty(page, "Amigos Recordatorio", ["Tomás"], recipient);
    const before = await stored(weddingId, "Amigos Recordatorio");

    await openGuests(collab.page, weddingId);
    const result = await sendReminder(collab.page, "Amigos Recordatorio");
    await expect(result).toHaveText(`Recordatorio enviado a ${recipient}.`);
    const email = await expectReminderCount(recipient, 1);
    if (!email) throw new Error("no reminder captured");
    expect(rsvpLinkOf(email) === original, "same link (value redacted)").toBe(true);

    const card = party(collab.page, "Amigos Recordatorio");
    await expect(card.getByRole("button", { name: guests.rotate.open })).toHaveCount(0);
    await expect(card.getByRole("button", { name: guests.invitationEmail.rotateSend.open })).toHaveCount(0);
    expect(linkFields(await stored(weddingId, "Amigos Recordatorio"))).toEqual(linkFields(before));
    await collab.context.close();
  });

  test("C, F: no contact email — no email action; the WhatsApp text has the same link and no private data", async ({
    page,
    browser,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await logIn(page, await createAccount("lb14-whatsapp"));
    const weddingId = await createWedding(page, "Boda de prueba WhatsApp", "2090-06-01");
    await openGuests(page, weddingId);
    const original = await createParty(page, "Familia Mensaje", ["Marta Mensaje", "Pablo Mensaje"]);
    const token = tokenOf(original);

    // The guests answer first, with a private food note.
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, original, "Familia Mensaje");
    await guest.page.getByRole("group", { name: "Marta Mensaje", exact: true }).getByRole("radio", { name: rsvp.yes }).check();
    await guest.page.getByRole("group", { name: "Pablo Mensaje", exact: true }).getByRole("radio", { name: rsvp.no }).check();
    await guest.page
      .getByRole("group", { name: "Marta Mensaje", exact: true })
      .getByLabel(rsvp.dietaryLabel)
      .fill("Sin gluten privado");
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await guest.context.close();

    await page.reload();
    const card = party(page, "Familia Mensaje");
    // C: no email action, a clear explanation.
    await expect(card.getByTestId("reminder-no-email")).toHaveText(reminder.noEmail);
    await expect(card.getByRole("button", { name: reminder.send })).toHaveCount(0);
    await expectNoTokenOnPage(page, weddingId, token);

    // F: the WhatsApp text, on explicit request only.
    const before = await stored(weddingId, "Familia Mensaje");
    const message = await prepareWhatsApp(page, "Familia Mensaje");
    expect(message.startsWith("Hola, Familia Mensaje:")).toBe(true);
    expect(message).toContain("Te recordamos que todavía puedes confirmar tu asistencia a Boda de prueba WhatsApp");
    expect(message.split("\n").includes(original), "the text carries the same link (value redacted)").toBe(true);
    for (const secret of ["Sin gluten privado", rsvp.yes, rsvp.no, "Asistirá", "No asistirá"]) {
      expect(message).not.toContain(secret);
    }
    // Copy works; the UI never claims it was sent.
    await card.getByRole("button", { name: reminder.whatsapp.copy }).click();
    await expect(card.getByText(reminder.whatsapp.copied)).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message);
    await expect(card.getByText(/WhatsApp enviado|Enviado por WhatsApp/i)).toHaveCount(0);

    // Preparing is not delivery: nothing recorded, nothing about the link changed.
    const after = await stored(weddingId, "Familia Mensaje");
    expect(after.reminder_sent_at).toBeNull();
    expect(linkFields(after)).toEqual(linkFields(before));
    expect(page.url().includes(token)).toBe(false);
    expect((await page.context().cookies()).some((c) => c.value.includes(token))).toBe(false);

    // "Ocultar mensaje" removes it from the page.
    await card.getByRole("button", { name: reminder.whatsapp.hide, exact: true }).click();
    await expect(card.getByTestId("reminder-message")).toHaveCount(0);
    expect((await page.content()).includes(token)).toBe(false);
  });

  test("D: a legacy hash-only link — no reminder, no WhatsApp text, no silent rotation; the owner's new link fixes it", async ({
    page,
    browser,
  }) => {
    const { weddingId, collab } = await ownerAndCollaborator(browser, page, "lb14-legacy");
    await openGuests(page, weddingId);
    const recipient = address("antigua");
    const legacyLink = await createParty(page, "Familia Antigua", ["Elena"], recipient);
    const { id } = await stored(weddingId, "Familia Antigua");
    await withDb((db) => db.query(`delete from ${SECRETS} where guest_invitation_id = $1`, [id]));
    const before = await stored(weddingId, "Familia Antigua");

    await page.reload();
    const card = party(page, "Familia Antigua");
    const result = await sendReminder(page, "Familia Antigua");
    await expect(result).toHaveText(`${reminder.errors.linkUnrecoverable} ${personal.regenerateOwner}`);
    await card.getByRole("button", { name: reminder.whatsapp.prepare }).click();
    await expect(card.getByTestId("reminder-message-result")).toHaveText(
      `${reminder.errors.linkUnrecoverable} ${personal.regenerateOwner}`,
    );
    await expect(card.getByTestId("reminder-message")).toHaveCount(0);

    await openGuests(collab.page, weddingId);
    const collabResult = await sendReminder(collab.page, "Familia Antigua");
    await expect(collabResult).toHaveText(`${reminder.errors.linkUnrecoverable} ${personal.regenerateCollaborator}`);
    await expect(party(collab.page, "Familia Antigua").getByRole("button", { name: guests.rotate.open })).toHaveCount(0);

    // Nothing sent, nothing rotated, the guest's link still works.
    expect(await remindersTo(recipient)).toHaveLength(0);
    expect(linkFields(await stored(weddingId, "Familia Antigua"))).toEqual(linkFields(before));
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, legacyLink, "Familia Antigua");

    // The owner's explicit new link makes reminders possible again.
    const newLink = await rotateLink(page, "Familia Antigua");
    await page.reload();
    await expect(await sendReminder(page, "Familia Antigua")).toHaveText(`Recordatorio enviado a ${recipient}.`);
    const email = await expectReminderCount(recipient, 1);
    if (!email) throw new Error("no reminder captured");
    expect(rsvpLinkOf(email) === newLink, "the reminder carries the owner's new link (value redacted)").toBe(true);
    await expectUnavailable(guest.page, legacyLink);
    await guest.context.close();
    await collab.context.close();
  });

  test("E: after an owner rotates the link, the reminder carries the NEW link; the old one stays dead", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb14-rotated"));
    const weddingId = await createWedding(page, "Boda de prueba Rotado", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("rotado");
    const oldLink = await createParty(page, "Familia Rotada", ["Rosa"], recipient);
    const newLink = await rotateLink(page, "Familia Rotada");
    const before = await stored(weddingId, "Familia Rotada");

    await page.reload();
    await sendReminder(page, "Familia Rotada");
    const email = await expectReminderCount(recipient, 1);
    if (!email) throw new Error("no reminder captured");
    const reminded = rsvpLinkOf(email);
    expect(reminded === newLink, "the reminder carries the new link (value redacted)").toBe(true);
    expect(reminded === oldLink, "never the old link (value redacted)").toBe(false);
    expect(email.text.includes(tokenOf(oldLink)) || email.html.includes(tokenOf(oldLink))).toBe(false);
    expect(linkFields(await stored(weddingId, "Familia Rotada"))).toEqual(linkFields(before));

    const guest = await freshPage(browser);
    await expectUnavailable(guest.page, oldLink);
    await expectGuestPage(guest.page, newLink, "Familia Rotada");
    await guest.context.close();
  });

  test("G: the RSVP confirmation still carries no /rsvp/ link; the reminder does", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb14-confirm"));
    const weddingId = await createWedding(page, "Boda de prueba Distinción", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("distincion");
    const link = await createParty(page, "Familia Distinción", ["Sara"], recipient);

    await sendReminder(page, "Familia Distinción");
    const reminderEmail = await expectReminderCount(recipient, 1);
    if (!reminderEmail) throw new Error("no reminder captured");
    expect(rsvpLinkOf(reminderEmail) === link, "reminder: current link (value redacted)").toBe(true);

    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, link, "Familia Distinción");
    await guest.page.getByRole("group", { name: "Sara", exact: true }).getByRole("radio", { name: rsvp.yes }).check();
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await expectEmailCount(recipient, 2);
    const confirmation = (await emailsTo(recipient)).find((m) => m.subject.startsWith("Confirmación de asistencia"));
    if (!confirmation) throw new Error("no confirmation captured");
    for (const part of [confirmation.subject, confirmation.text, confirmation.html]) {
      expect(part.includes("/rsvp/"), "no RSVP link in the confirmation").toBe(false);
      expect(part.includes(tokenOf(link)), "no token in the confirmation (value redacted)").toBe(false);
    }
    expect(reminderEmail.text.includes("/rsvp/")).toBe(true);

    // Three distinct statuses on the card.
    await page.reload();
    const card = party(page, "Familia Distinción");
    await expect(card.getByTestId("party-invitation-email-status")).toHaveText(guests.invitationEmail.never);
    await expect(card.getByTestId("party-rsvp-confirmation-status")).toContainText("Última confirmación enviada el");
    await expect(card.getByTestId("party-reminder-email-status")).toContainText("Último recordatorio enviado el");
    await guest.context.close();
  });

  test("H: the provider rejects — a calm error, no status, the link untouched and working", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb14-fail"));
    const weddingId = await createWedding(page, "Boda de prueba Falla", "2090-06-01");
    await openGuests(page, weddingId);
    const recipient = address("rechazo", REJECTING_DOMAIN);
    const link = await createParty(page, "Familia Rechazo", ["Iván"], recipient);
    const before = await stored(weddingId, "Familia Rechazo");

    await page.reload();
    const result = await sendReminder(page, "Familia Rechazo");
    await expect(result).toHaveText(reminder.errors.providerFailed);
    expect(await emailsTo(recipient)).toHaveLength(0);

    await page.reload();
    await expect(party(page, "Familia Rechazo").getByTestId("party-reminder-email-status")).toHaveText(reminder.never);
    const after = await stored(weddingId, "Familia Rechazo");
    expect(after.reminder_sent_at).toBeNull();
    expect(linkFields(after)).toEqual(linkFields(before));
    const guest = await freshPage(browser);
    await expectGuestPage(guest.page, link, "Familia Rechazo");
    await guest.context.close();
  });

  test("an inactive (revoked) link offers no reminder at all", async ({ page }) => {
    await logIn(page, await createAccount("lb14-revoked"));
    const weddingId = await createWedding(page, "Boda de prueba Revocada", "2090-06-01");
    await openGuests(page, weddingId);
    await createParty(page, "Familia Revocada", ["Nora"], address("revocada"));
    const card = party(page, "Familia Revocada");
    await card.getByRole("button", { name: guests.revoke.open }).click();
    await card.getByRole("button", { name: guests.revoke.confirmButton }).click();
    await expect(page.getByText(guests.revoke.done)).toBeVisible();
    await expect(card.getByTestId("reminder-inactive")).toHaveText(reminder.inactive);
    await expect(card.getByRole("button", { name: reminder.send })).toHaveCount(0);
    await expect(card.getByRole("button", { name: reminder.whatsapp.prepare })).toHaveCount(0);
  });
});
