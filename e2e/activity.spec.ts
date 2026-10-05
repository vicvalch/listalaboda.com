import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { emailsTo, rsvpLinkOf, type OutboxMessage } from "./support/outbox";

// LB-15 (ADR-008): the wedding's activity history ("Actividad"), driven only
// through the real UI. Every organizer action, guest RSVP and recorded email
// shows up once, newest first, with the party, who did it and when — and
// nothing else: no links, tokens, answers, notes or addresses. Emails go to
// the local outbox (playwright.config.ts). Guest links are bearer
// credentials: assertions on them are redacted.

const guests = es.guests;
const mail = guests.invitationEmail;
const reminder = guests.reminder;
const activity = es.activity;
const rsvp = es.rsvp;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;
const RUN = randomUUID().slice(0, 8);

function address(label: string): string {
  return `e2e-${RUN}-act-${label}@example.com`;
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function openGuests(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/guests`);
  await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
}

async function openActivity(page: Page, weddingId: string) {
  const response = await page.goto(`/app/weddings/${weddingId}/activity`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: activity.title })).toBeVisible();
}

function party(page: Page, label: string): Locator {
  return page
    .getByTestId("guest-party")
    .filter({ has: page.getByRole("heading", { level: 3, name: label, exact: true }) });
}

function newPartySection(page: Page) {
  return page.getByRole("region", { name: guests.newParty.title });
}

/** "Nuevo grupo" with a contact email; returns the link shown once. */
async function createParty(page: Page, label: string, names: string[], email: string): Promise<string> {
  const section = newPartySection(page);
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  const url = await section.getByTestId("guest-link").inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

/** The activity rows as [event, party, actor line], newest first. */
async function activityRows(page: Page): Promise<string[][]> {
  const entries = page.getByTestId("activity-entry");
  const count = await entries.count();
  const rows: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = entries.nth(i);
    rows.push([
      (await entry.getByTestId("activity-event").innerText()).trim(),
      (await entry.getByTestId("activity-party").innerText()).trim(),
      (await entry.getByTestId("activity-actor").innerText()).trim(),
    ]);
  }
  return rows;
}

async function answer(page: Page, choices: Record<string, boolean>, note?: string, submit: string = rsvp.submit) {
  for (const [name, attending] of Object.entries(choices)) {
    await page
      .getByRole("group", { name, exact: true })
      .getByRole("radio", { name: attending ? rsvp.yes : rsvp.no })
      .check();
  }
  if (note) await page.getByLabel(rsvp.dietaryLabel).first().fill(note);
  await page.getByRole("button", { name: submit }).click();
  await expect(page.getByText(rsvp.saved)).toBeVisible();
}

async function waitForEmails(to: string, count: number, subjectStart: string): Promise<OutboxMessage[]> {
  await expect
    .poll(async () => (await emailsTo(to)).filter((m) => m.subject.startsWith(subjectStart)).length, {
      message: `${subjectStart} count`,
    })
    .toBe(count);
  return (await emailsTo(to)).filter((m) => m.subject.startsWith(subjectStart));
}

/** The page shows events, never capability material, answers, notes or addresses. */
async function expectNothingSensitive(page: Page, secrets: readonly string[]) {
  const html = await page.content();
  expect(html.includes("/rsvp/"), "no RSVP link on the activity page").toBe(false);
  for (const secret of secrets) {
    expect(html.includes(secret), "no sensitive value on the activity page (redacted)").toBe(false);
  }
}

test.describe("wedding activity history", () => {
  test("A–G: create, email, RSVP, confirmation, reminder, rotate and revoke each appear once, newest first", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb15-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Actividad", "2090-06-01");

    // Reachable from the wedding's home; empty until something happens.
    await page.getByRole("link", { name: activity.navLink }).click();
    await expect(page.getByRole("heading", { level: 1, name: activity.title })).toBeVisible();
    await expect(page.getByText(activity.empty.title)).toBeVisible();
    await expect(page.getByText(activity.sinceNote)).toBeVisible();

    // A: create a party.
    const recipient = address("familia");
    await openGuests(page, weddingId);
    const link = await createParty(page, "Familia Actividad", ["Ana Actividad", "Luis Actividad"], recipient);
    const token = link.split("/").at(-1) ?? "";
    await openActivity(page, weddingId);
    expect(await activityRows(page)).toEqual([[activity.events.guestInvitationCreated, "Familia Actividad", activity.byYou]]);

    // B: send the invitation email; reloading never duplicates history.
    await openGuests(page, weddingId);
    await createParty(page, "Familia Correo Actividad", ["Eva Actividad"], address("correo"));
    const section = newPartySection(page);
    await section.getByRole("button", { name: mail.sendFresh }).click();
    await expect(section.getByTestId("invitation-email-result")).toBeVisible();
    await openActivity(page, weddingId);
    const afterEmail = await activityRows(page);
    await page.reload();
    expect(await activityRows(page)).toEqual(afterEmail);
    expect(afterEmail.slice(0, 2)).toEqual([
      [activity.events.guestInvitationEmailSent, "Familia Correo Actividad", activity.byYou],
      [activity.events.guestInvitationCreated, "Familia Correo Actividad", activity.byYou],
    ]);

    // C + D: the guest answers (confirmation recorded), then changes the answer.
    const guest = await freshPage(browser);
    await guest.page.goto(link);
    await expect(guest.page).toHaveURL(/\/rsvp$/);
    await answer(guest.page, { "Ana Actividad": true, "Luis Actividad": true }, "sin lactosa");
    await waitForEmails(recipient, 1, "Confirmación de asistencia");
    await guest.page.goto(link);
    await answer(guest.page, { "Ana Actividad": true, "Luis Actividad": false }, undefined, rsvp.submitChanges);
    await waitForEmails(recipient, 2, "Confirmación de asistencia");
    await guest.context.close();

    // E: a manual reminder carries the SAME link.
    await openGuests(page, weddingId);
    const card = party(page, "Familia Actividad");
    await card.getByRole("button", { name: reminder.send }).click();
    await expect(card.getByTestId("reminder-email-result")).toBeVisible();
    const [sentReminder] = await waitForEmails(recipient, 1, "Recordatorio de confirmación");
    expect(rsvpLinkOf(sentReminder!) === link, "the reminder carries the same link (value redacted)").toBe(true);

    // F: the owner replaces the link.
    await card.getByRole("button", { name: guests.rotate.open, exact: true }).click();
    await card.getByRole("button", { name: guests.rotate.confirmButton }).click();
    const rotated = await card.getByTestId("guest-link").inputValue();
    expect(GUEST_LINK.test(rotated) && rotated !== link, "a new link (value redacted)").toBe(true);

    // G: and revokes it.
    await card.getByRole("button", { name: guests.revoke.open }).click();
    await card.getByRole("button", { name: guests.revoke.confirmButton }).click();
    await expect(page.getByText(guests.revoke.done)).toBeVisible();

    await openActivity(page, weddingId);
    const guestActor = activity.by.replace("{actor}", activity.actors.guest);
    const rows = await activityRows(page);
    expect(rows.filter((r) => r[1] === "Familia Actividad")).toEqual([
      [activity.events.guestInvitationRevoked, "Familia Actividad", activity.byYou],
      [activity.events.guestInvitationLinkRotated, "Familia Actividad", activity.byYou],
      [activity.events.rsvpReminderEmailSent, "Familia Actividad", activity.byYou],
      [activity.events.rsvpConfirmationEmailSent, "Familia Actividad", guestActor],
      [activity.events.guestRsvpUpdated, "Familia Actividad", guestActor],
      [activity.events.rsvpConfirmationEmailSent, "Familia Actividad", guestActor],
      [activity.events.guestRsvpSubmitted, "Familia Actividad", guestActor],
      [activity.events.guestInvitationCreated, "Familia Actividad", activity.byYou],
    ]);
    // Each row is dated (wedding time zone, or UTC when it has none).
    await expect(page.getByTestId("activity-entry").first().locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
    await expectNothingSensitive(page, [
      token,
      rotated.split("/").at(-1) ?? "",
      recipient,
      "sin lactosa",
      rsvp.status.attending,
      rsvp.status.not_attending,
    ]);
  });

  test("H: members only — a collaborator reads it; another wedding's owner gets a 404; signed-out goes to login", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb15-tenant-owner"));
    const weddingA = await createWedding(page, "Boda de prueba Actividad A");
    await openGuests(page, weddingA);
    await createParty(page, "Familia Privada", ["Nora Privada"], address("privada"));

    // A collaborator joins through a real MembershipInvite and sees the same history.
    await page.goto(`/app/weddings/${weddingA}`);
    const invite = await createInvite(page, "collaborator");
    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb15-tenant-collab"));
    await collab.page.goto(invite);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingA}\\?joined=new$`));
    await openActivity(collab.page, weddingA);
    expect(await activityRows(collab.page)).toEqual([
      [activity.events.guestInvitationCreated, "Familia Privada", activity.by.replace("{actor}", es.members.fallback.owner)],
    ]);

    // Another wedding's owner: the same 404 as a missing wedding, nothing shown.
    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("lb15-tenant-other"));
    await createWedding(other.page, "Boda de prueba Actividad B");
    const denied = await other.page.goto(`/app/weddings/${weddingA}/activity`);
    expect(denied?.status()).toBe(404);
    await expect(other.page.getByText("Familia Privada")).toHaveCount(0);

    // Signed out: sent to log in, nothing rendered.
    const anon = await freshPage(browser);
    await anon.page.goto(`/app/weddings/${weddingA}/activity`);
    await expect(anon.page).toHaveURL(/\/login/);
    await expect(anon.page.getByText("Familia Privada")).toHaveCount(0);

    for (const ctx of [collab, other, anon]) await ctx.context.close();
  });
});
