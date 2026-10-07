import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { resendEventBody, signWebhook } from "../src/test/fixtures/resend-webhook";

import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { emailsTo, expectEmailCount, rsvpLinkOf, type OutboxMessage } from "./support/outbox";
import { E2E_RESEND_WEBHOOK_SECRET } from "./support/webhook";

// LB-18.3 (ADR-011 §9) against the production build: delivery status on the
// party card, the current-address warning and the same-address guard on
// manual emails, end to end. Emails go to the local outbox; delivery outcomes
// arrive through the real signed webhook route with a FAKE test-only secret.
// No real provider. Guest links are bearer credentials: never printed.

const guests = es.guests;
const delivery = guests.delivery;
const mail = guests.invitationEmail;
const reminder = guests.reminder;
const contact = guests.contactEmail;
const ROUTE = "/api/webhooks/resend";
const RUN = randomUUID().slice(0, 8);

let counter = 0;
function address(label: string): string {
  counter += 1;
  return `e2e-${RUN}-lb183-${label}-${counter}@example.com`;
}

function party(page: Page, label: string): Locator {
  return page
    .getByTestId("guest-party")
    .filter({ has: page.getByRole("heading", { level: 3, name: label, exact: true }) });
}

async function openGuests(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/guests`);
  await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
}

/** Creates a party with a contact email and emails it the fresh link; returns the captured invitation. */
async function createAndInvite(page: Page, label: string, names: string[], email: string): Promise<OutboxMessage> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  await section.getByRole("button", { name: mail.sendFresh }).click();
  await expect(section.getByTestId("invitation-email-result")).toHaveText(mail.sent.replace("{email}", email));
  const sent = await expectEmailCount(email, 1);
  if (!sent) throw new Error("no email captured");
  return sent;
}

/** The provider reports an outcome for one send, signed like the provider would. */
async function report(page: Page, messageId: string, type: "email.bounced" | "email.complained" | "email.delivery_delayed") {
  const signed = signWebhook(resendEventBody(type, messageId), {
    id: `msg_e2e${RUN}${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    secret: E2E_RESEND_WEBHOOK_SECRET,
  });
  const response = await page.request.post(ROUTE, { data: signed.body, headers: signed.headers });
  expect(response.status()).toBe(200);
}

async function saveEmail(card: Locator, email: string) {
  await card.getByText(contact.edit, { exact: true }).click();
  await card.getByLabel(contact.fieldLabel).fill(email);
  await card.getByRole("button", { name: contact.submit }).click();
  await expect(card.getByTestId("party-contact-email")).toHaveText(email);
}

/** Email-send controls are disabled for a blocked address; sharing and editing are not. */
async function expectEmailControls(card: Locator, state: "blocked" | "enabled", owner: boolean) {
  const reminderButton = card.getByRole("button", { name: reminder.send });
  const sharing = [
    card.getByRole("button", { name: guests.personalLink.show }),
    card.getByRole("button", { name: reminder.whatsapp.prepare }),
  ];
  if (state === "blocked") {
    await expect(reminderButton).toBeDisabled();
    if (owner) await expect(card.getByRole("button", { name: mail.rotateSend.open })).toBeDisabled();
  } else {
    await expect(reminderButton).toBeEnabled();
    if (owner) await expect(card.getByRole("button", { name: mail.rotateSend.open })).toBeEnabled();
  }
  for (const control of sharing) await expect(control).toBeEnabled();
  await expect(card.getByText(contact.edit, { exact: true })).toBeVisible();
  if (owner) await expect(card.getByRole("button", { name: guests.rotate.open, exact: true })).toBeEnabled();
}

/** The UI is a convenience: force a disabled button back on and the server still refuses. */
async function forceEnable(button: Locator) {
  await button.evaluate((element) => element.removeAttribute("disabled"));
}

async function sendReminder(card: Locator): Promise<Locator> {
  await card.getByRole("button", { name: reminder.send }).click();
  const result = card.getByTestId("reminder-email-result");
  await expect(result).toBeVisible();
  return result;
}

async function ownerAndCollaborator(browser: Browser, page: Page, label: string) {
  await logIn(page, await createAccount(`${label}-owner`));
  const weddingId = await createWedding(page, `Boda de prueba ${label}`, "2090-06-01");
  const inviteUrl = await createInvite(page, "collaborator");
  const context = await browser.newContext();
  const collab = await context.newPage();
  await logIn(collab, await createAccount(`${label}-collab`));
  await collab.goto(inviteUrl);
  await collab.getByRole("button", { name: es.inviteAccept.submit }).click();
  await expect(collab).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
  return { weddingId, collab, context };
}

test.describe("email delivery status and the same-address guard", () => {
  test("bounced: status and warning show, manual emails are blocked, editing the address re-enables them", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb183-bounce"));
    const weddingId = await createWedding(page, "Boda de prueba Entrega", "2090-06-01");
    await openGuests(page, weddingId);

    const bad = address("bad");
    const invitation = await createAndInvite(page, "Familia Rebote", ["Ana Rebote"], bad);

    // Accepted, nothing reported yet: "Enviado", never "Entregado"; no warning.
    await page.reload();
    const card = party(page, "Familia Rebote");
    await expect(card.getByTestId("party-invitation-delivery-status")).toContainText(delivery.status.accepted);
    await expect(card.getByTestId("party-invitation-delivery-status")).not.toContainText(delivery.status.delivered);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveCount(0);

    // A delay is shown but blocks nothing.
    await report(page, invitation.messageId, "email.delivery_delayed");
    await page.reload();
    await expect(card.getByTestId("party-invitation-delivery-status")).toContainText(delivery.status.delayed);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveCount(0);
    await expectEmailControls(card, "enabled", true);

    // The provider reports a bounce.
    await report(page, invitation.messageId, "email.bounced");
    await page.reload();
    await expect(card.getByTestId("party-invitation-delivery-status")).toContainText(delivery.status.bounced);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveText(delivery.warning.undeliverable);
    // The address the bounced email went to is on its own line.
    await expect(card.getByTestId("party-invitation-email-status")).toContainText(bad);

    // No provider ids or technical words anywhere on the page.
    const html = await page.content();
    expect(html.includes(invitation.messageId)).toBe(false);
    for (const word of ["webhook", "svix", "provider", "bounced", "suppressed", "complained"]) {
      expect((await page.locator("main").innerText()).toLowerCase().includes(word), word).toBe(false);
    }

    // The old link still works, and the guest page never shows delivery information.
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    expect((await guestPage.goto(rsvpLinkOf(invitation)))?.status()).toBe(200);
    const guestText = await guestPage.locator("body").innerText();
    for (const word of [delivery.label, delivery.status.bounced, delivery.warning.undeliverable]) {
      expect(guestText.includes(word), word).toBe(false);
    }
    await guest.close();

    // Email buttons are disabled (the warning explains why, also next to the
    // reminder); showing the link, WhatsApp, editing and a plain new link aren't.
    await expectEmailControls(card, "blocked", true);
    await expect(card.getByTestId("reminder-email-blocked")).toHaveText(delivery.warning.undeliverable);
    await card.getByRole("button", { name: reminder.whatsapp.prepare }).click();
    await expect(card.getByTestId("reminder-message")).toBeVisible();
    await card.getByRole("button", { name: guests.personalLink.show }).click();
    await expect(card.getByTestId("recovered-guest-link")).toBeVisible();

    // The server stays the boundary: a forced reminder click is refused.
    const reminderButton = card.getByRole("button", { name: reminder.send });
    await forceEnable(reminderButton);
    await reminderButton.click();
    await expect(card.getByTestId("reminder-email-result")).toHaveText(reminder.errors.recipientUndeliverable);
    // And a forced invitation email with a freshly generated link, too.
    await card.getByRole("button", { name: guests.rotate.open, exact: true }).click();
    await card.getByRole("button", { name: guests.rotate.confirmButton }).click();
    await expect(card.getByTestId("guest-link")).toBeVisible();
    const sendFresh = card.getByRole("button", { name: mail.sendFresh });
    await expect(sendFresh).toBeDisabled();
    await forceEnable(sendFresh);
    await sendFresh.click();
    await expect(card.getByTestId("invitation-email-result")).toContainText(mail.errors.recipientUndeliverable);
    await expectEmailCount(bad, 1);

    // A case-only edit is the SAME address: still blocked.
    const caseOnly = bad.charAt(0).toUpperCase() + bad.slice(1);
    await saveEmail(card, caseOnly);
    await page.reload();
    await expect(card.getByTestId("party-contact-email")).toHaveText(caseOnly);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveText(delivery.warning.undeliverable);
    await expectEmailControls(card, "blocked", true);

    // A genuinely different address clears the warning and enables email again.
    const good = address("good");
    await saveEmail(card, good);
    await page.reload();
    await expect(card.getByTestId("party-contact-email-warning")).toHaveCount(0);
    await expectEmailControls(card, "enabled", true);
    await expect(await sendReminder(card)).toHaveText(reminder.sent.replace("{email}", good));
    await expectEmailCount(good, 1);
    await expectEmailCount(bad, 1);
    expect(await emailsTo(caseOnly)).toEqual([]);

    // The new send has its own status; the old bounce stays on the old line.
    await page.reload();
    await expect(card.getByTestId("party-reminder-delivery-status")).toContainText(delivery.status.accepted);
    await expect(card.getByTestId("party-invitation-delivery-status")).toContainText(delivery.status.bounced);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveCount(0);
  });

  test("complained: a collaborator sees it, can't email that address, and the RSVP confirmation is skipped", async ({
    page,
    browser,
  }) => {
    const { weddingId, collab, context } = await ownerAndCollaborator(browser, page, "lb183-spam");
    await openGuests(page, weddingId);
    const spam = address("spam");
    const invitation = await createAndInvite(page, "Familia Spam", ["Eva Spam"], spam);
    await report(page, invitation.messageId, "email.complained");

    await openGuests(collab, weddingId);
    const card = party(collab, "Familia Spam");
    await expect(card.getByTestId("party-invitation-delivery-status")).toContainText(delivery.status.complained);
    await expect(card.getByTestId("party-contact-email-warning")).toHaveText(delivery.warning.complained);
    // Collaborators have no owner-only controls; their reminder email is disabled with the spam wording.
    await expectEmailControls(card, "blocked", false);
    await expect(card.getByTestId("reminder-email-blocked")).toHaveText(delivery.warning.complained);
    const reminderButton = card.getByRole("button", { name: reminder.send });
    await forceEnable(reminderButton);
    await reminderButton.click();
    await expect(card.getByTestId("reminder-email-result")).toHaveText(reminder.errors.recipientComplained);
    await expectEmailCount(spam, 1);

    // The guest answers: saved, no confirmation email, no failure note.
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(rsvpLinkOf(invitation));
    await guestPage.getByRole("group", { name: "Eva Spam", exact: true }).getByRole("radio", { name: es.rsvp.yes }).check();
    await guestPage.getByRole("button", { name: es.rsvp.submit }).click();
    await expect(guestPage.getByText(es.rsvp.saved)).toBeVisible();
    await expect(guestPage.getByTestId("rsvp-confirmation-note")).toHaveCount(0);
    await expect(guestPage.getByText(es.rsvp.confirmation.failed)).toHaveCount(0);
    expect((await emailsTo(spam)).length).toBe(1);
    await guest.close();

    // The collaborator edits the address: the warning goes, a reminder goes out.
    const fixed = address("fixed");
    await saveEmail(card, fixed);
    await collab.reload();
    await expect(card.getByTestId("party-contact-email-warning")).toHaveCount(0);
    await expectEmailControls(card, "enabled", false);
    await expect(await sendReminder(card)).toHaveText(reminder.sent.replace("{email}", fixed));
    await expectEmailCount(fixed, 1);
    await context.close();
  });
});
