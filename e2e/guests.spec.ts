import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createInvite, createWedding, es, formAlert, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-09: the couple's guest list ("Invitados") and the guests' RSVP through
// a party link, without accounts. Names are generic fake fixtures. Guest
// links are bearer credentials: assertions on them are redacted.

const guests = es.guests;
const rsvp = es.rsvp;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;

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

function guestRow(scope: Locator, name: string): Locator {
  return scope.getByTestId("guest-row").filter({ has: scope.page().getByText(name, { exact: true }) });
}

async function readLink(scope: Locator | Page): Promise<string> {
  const field = scope.getByTestId("guest-link");
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

/** "Nuevo grupo" with its first guests; returns the link shown once. */
async function createParty(page: Page, label: string, names: string[]): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  return readLink(section);
}

async function rotateLink(page: Page, label: string): Promise<string> {
  const card = party(page, label);
  await card.getByRole("button", { name: guests.rotate.open }).click();
  await expect(card.getByText(guests.rotate.confirmBody)).toBeVisible();
  await card.getByRole("button", { name: guests.rotate.confirmButton }).click();
  return readLink(card);
}

function guestGroup(page: Page, name: string): Locator {
  return page.getByRole("group", { name, exact: true });
}

async function answer(page: Page, name: string, attending: boolean) {
  await guestGroup(page, name)
    .getByRole("radio", { name: attending ? rsvp.yes : rsvp.no })
    .check();
}

async function expectSaved(page: Page, summary: string[]) {
  await expect(page.getByText(rsvp.saved)).toBeVisible();
  await expect(page.getByTestId("rsvp-summary-guest")).toHaveText(summary);
}

async function expectUnavailable(page: Page) {
  await expect(page.getByRole("heading", { level: 1, name: rsvp.unavailable.title })).toBeVisible();
  await expect(page.getByRole("group")).toHaveCount(0);
}

async function expectGuestStatus(page: Page, label: string, name: string, status: string) {
  await expect(guestRow(party(page, label), name).getByTestId("guest-status")).toHaveText(status);
}

async function rsvpCount(weddingId: string): Promise<{ guests: number; rows: number }> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ guests: number; rows: number }>(
      `select (select count(*)::int from public.guests where wedding_id = $1) as guests,
              (select count(*)::int from public.rsvps where wedding_id = $1) as rows`,
      [weddingId],
    );
    return rows[0] ?? { guests: 0, rows: 0 };
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

test.describe("guest list and RSVP", () => {
  test("A–D: create a party, guests answer without an account (mixed), then change it", async ({
    page,
    browser,
  }) => {
    // A: the organizer creates "Familia Pérez" with two guests.
    await logIn(page, await createAccount("lb9-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Invitados", "2090-06-01");
    await page.getByRole("link", { name: guests.navLink }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/guests$`));
    await expect(page.getByTestId("guest-summary-total")).toContainText("0");

    const firstLink = await createParty(page, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
    const card = party(page, "Familia Pérez");
    await expect(card.getByText(guests.link.active)).toBeVisible();
    // A fresh link replaces the first one; the first one stops working (G covers it in depth).
    const link = await rotateLink(page, "Familia Pérez");
    expect(link).not.toBe(firstLink);

    await page.reload();
    await expect(card.getByTestId("guest-name")).toHaveText(["Ana Pérez", "Carlos Pérez"]);
    await expectGuestStatus(page, "Familia Pérez", "Ana Pérez", guests.status.pending);
    await expectGuestStatus(page, "Familia Pérez", "Carlos Pérez", guests.status.pending);
    // The link itself can't be shown again after a reload.
    await expect(page.getByTestId("guest-link")).toHaveCount(0);
    await expect(card.getByText(guests.link.notRecoverable)).toBeVisible();

    // B: a guest opens the link in a brand-new browser, no account.
    const guest = await freshPage(browser);
    const response = await guest.page.goto(link);
    expect(response?.status()).toBe(200);
    // The token left the URL; no login, no /app.
    await expect(guest.page).toHaveURL(/\/rsvp$/);
    await expect(guest.page.getByRole("heading", { level: 1, name: "Familia Pérez" })).toBeVisible();
    await expect(guest.page.getByRole("group")).toHaveCount(2);
    await expect(guestGroup(guest.page, "Ana Pérez")).toBeVisible();
    await expect(guestGroup(guest.page, "Carlos Pérez")).toBeVisible();
    // Nothing private: no wedding name, no checklist, no members, no navigation into /app.
    await expect(guest.page.getByText("Boda de prueba Invitados")).toHaveCount(0);
    await expect(guest.page.getByText(es.checklist.title)).toHaveCount(0);
    await expect(guest.page.getByText(es.wedding.peopleTitle)).toHaveCount(0);
    await expect(guest.page.locator('a[href^="/app"]')).toHaveCount(0);
    // Nothing preselected.
    await expect(guest.page.getByRole("radio", { checked: true })).toHaveCount(0);

    // Unanswered is never "No": a partial answer saves nothing.
    await answer(guest.page, "Ana Pérez", true);
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(formAlert(guest.page)).toHaveText(rsvp.validation.fixErrors);
    await expect(guestGroup(guest.page, "Carlos Pérez")).toHaveAccessibleDescription(
      rsvp.validation.choiceRequired,
    );
    expect((await rsvpCount(weddingId)).rows).toBe(0);

    // C: mixed answer.
    await answer(guest.page, "Ana Pérez", true);
    await answer(guest.page, "Carlos Pérez", false);
    await guestGroup(guest.page, "Ana Pérez").getByLabel(rsvp.dietaryLabel).fill("Vegetariana");
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expectSaved(guest.page, [
      `Ana Pérez — ${rsvp.status.attending}`,
      `Carlos Pérez — ${rsvp.status.not_attending}`,
    ]);

    await page.reload();
    await expectGuestStatus(page, "Familia Pérez", "Ana Pérez", guests.status.attending);
    await expectGuestStatus(page, "Familia Pérez", "Carlos Pérez", guests.status.not_attending);
    await expect(guestRow(card, "Ana Pérez").getByTestId("guest-dietary-note")).toContainText("Vegetariana");
    await expect(page.getByTestId("guest-summary-total")).toContainText("2");
    await expect(page.getByTestId("guest-summary-attending")).toContainText("1");
    await expect(page.getByTestId("guest-summary-not-attending")).toContainText("1");
    await expect(page.getByTestId("guest-summary-pending")).toContainText("0");

    // D: the guest comes back with the SAME link and changes Carlos to Sí.
    await guest.page.goto(link);
    await expect(guestGroup(guest.page, "Carlos Pérez").getByRole("radio", { name: rsvp.no })).toBeChecked();
    await expect(guestGroup(guest.page, "Ana Pérez").getByLabel(rsvp.dietaryLabel)).toHaveValue("Vegetariana");
    await answer(guest.page, "Carlos Pérez", true);
    await guest.page.getByRole("button", { name: rsvp.submitChanges }).click();
    await expectSaved(guest.page, [
      `Ana Pérez — ${rsvp.status.attending}`,
      `Carlos Pérez — ${rsvp.status.attending}`,
    ]);
    // "Cambiar respuesta" goes back to the prefilled form.
    await guest.page.getByRole("link", { name: rsvp.change }).click();
    await expect(guestGroup(guest.page, "Carlos Pérez").getByRole("radio", { name: rsvp.yes })).toBeChecked();

    await page.reload();
    await expectGuestStatus(page, "Familia Pérez", "Carlos Pérez", guests.status.attending);
    await expect(page.getByTestId("guest-summary-attending")).toContainText("2");
    // Still one current RSVP per guest.
    expect(await rsvpCount(weddingId)).toEqual({ guests: 2, rows: 2 });

    await guest.context.close();
  });

  test("E: a random link shows the generic unavailable page, nothing else", async ({ page }) => {
    const random = randomBytes(32).toString("base64url");
    const response = await page.goto(`/rsvp/${random}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/rsvp$/);
    await expectUnavailable(page);
    // Opening /rsvp directly (no link at all) looks the same.
    await page.context().clearCookies();
    await page.goto("/rsvp");
    await expectUnavailable(page);
    await page.goto("/rsvp/not-even-a-token");
    await expectUnavailable(page);
  });

  test("guest routes never cache and never send a Referer", async ({ request }) => {
    const random = randomBytes(32).toString("base64url");
    const handoff = await request.get(`/rsvp/${random}`, { maxRedirects: 0 });
    expect(handoff.status()).toBe(303);
    const handoffHeaders = handoff.headers();
    expect(handoffHeaders.location).toMatch(/\/rsvp$/);
    expect(handoffHeaders["referrer-policy"]).toBe("no-referrer");
    expect(handoffHeaders["cache-control"]).toContain("no-store");
    const cookie = handoffHeaders["set-cookie"] ?? "";
    expect(cookie).toContain("lb_guest_rsvp=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/rsvp/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const page = await request.get("/rsvp");
    expect(page.headers()["referrer-policy"]).toBe("no-referrer");
    expect(page.headers()["cache-control"]).toContain("no-store");
    expect(await page.text()).toContain('name="robots" content="noindex, nofollow"');
  });

  test("F–G: revoke, then a new link; guests and answers survive both", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb9-links"));
    const weddingId = await createWedding(page, "Boda de prueba Enlaces", "2090-06-01");
    await openGuests(page, weddingId);
    const link = await createParty(page, "Ana y Carlos", ["Ana", "Carlos"]);
    const card = party(page, "Ana y Carlos");

    const guest = await freshPage(browser);
    await guest.page.goto(link);
    await answer(guest.page, "Ana", true);
    await answer(guest.page, "Carlos", false);
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expectSaved(guest.page, [`Ana — ${rsvp.status.attending}`, `Carlos — ${rsvp.status.not_attending}`]);

    // F: revoke.
    await card.getByRole("button", { name: guests.revoke.open }).click();
    await expect(card.getByText(guests.revoke.confirmBody)).toBeVisible();
    await card.getByRole("button", { name: guests.revoke.confirmButton }).click();
    await expect(page.getByText(guests.revoke.done)).toBeVisible();
    await expect(card.getByText(guests.link.revoked)).toBeVisible();
    await expect(card.getByRole("button", { name: guests.revoke.open })).toHaveCount(0);

    await guest.page.reload();
    await expectUnavailable(guest.page);
    await guest.page.goto(link);
    await expectUnavailable(guest.page);
    // The organizer keeps the party and its answers.
    await expectGuestStatus(page, "Ana y Carlos", "Ana", guests.status.attending);
    await expectGuestStatus(page, "Ana y Carlos", "Carlos", guests.status.not_attending);

    // G: a new link reopens access; the old one stays dead.
    const newLink = await rotateLink(page, "Ana y Carlos");
    expect(newLink).not.toBe(link);
    await page.reload();
    await expect(card.getByText(guests.link.active)).toBeVisible();

    await guest.page.goto(link);
    await expectUnavailable(guest.page);
    await guest.page.goto(newLink);
    await expect(guest.page.getByRole("heading", { level: 1, name: "Ana y Carlos" })).toBeVisible();
    await expect(guestGroup(guest.page, "Ana").getByRole("radio", { name: rsvp.yes })).toBeChecked();
    await expect(guestGroup(guest.page, "Carlos").getByRole("radio", { name: rsvp.no })).toBeChecked();

    // Rotating an active link also kills the previous one.
    const third = await rotateLink(page, "Ana y Carlos");
    await guest.page.goto(newLink);
    await expectUnavailable(guest.page);
    await guest.page.goto(third);
    await expect(guest.page.getByRole("group")).toHaveCount(2);

    await guest.context.close();
  });

  test("party management: add, rename, remove (with answer warning), delete", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb9-manage"));
    const weddingId = await createWedding(page, "Boda de prueba Grupos", "2090-06-01");
    await openGuests(page, weddingId);

    // Validation keeps what was typed.
    const section = page.getByRole("region", { name: guests.newParty.title });
    await section.getByLabel(guests.newParty.labelLabel).fill("Familia Gómez");
    await section.getByRole("button", { name: guests.newParty.submit }).click();
    await expect(section.getByText(guests.validation.namesRequired)).toBeVisible();
    await expect(section.getByLabel(guests.newParty.labelLabel)).toHaveValue("Familia Gómez");

    const link = await createParty(page, "Familia Gómez", ["Gina", "Gael"]);
    const card = party(page, "Familia Gómez");

    await card.getByText(guests.addGuest.open, { exact: true }).click();
    await card.getByRole("textbox", { name: guests.addGuest.label }).fill("Gloria");
    await card.getByRole("button", { name: guests.addGuest.submit }).click();
    await expect(card.getByTestId("guest-name")).toHaveText(["Gina", "Gael", "Gloria"]);

    await card.getByText(guests.editParty.open, { exact: true }).click();
    await card.getByRole("textbox", { name: guests.editParty.label }).fill("Familia Gómez Ruiz");
    await card.getByRole("button", { name: guests.editParty.submit }).click();
    const renamed = party(page, "Familia Gómez Ruiz");
    await expect(renamed).toBeVisible();

    await guestRow(renamed, "Gael").getByLabel(guests.editGuest.openFor.replace("{name}", "Gael")).click();
    await guestRow(renamed, "Gael").getByRole("textbox", { name: guests.editGuest.label }).fill("Gael G.");
    await guestRow(renamed, "Gael").getByRole("button", { name: guests.editGuest.submit }).click();
    await expect(renamed.getByTestId("guest-name")).toHaveText(["Gina", "Gael G.", "Gloria"]);

    // Gina answers; removing her warns that her answer goes too.
    const guest = await freshPage(browser);
    await guest.page.goto(link);
    await answer(guest.page, "Gina", true);
    await answer(guest.page, "Gael G.", true);
    await answer(guest.page, "Gloria", false);
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();

    await page.reload();
    await guestRow(renamed, "Gina").getByRole("button", { name: guests.removeGuest.openFor.replace("{name}", "Gina") }).click();
    await expect(renamed.getByText(guests.removeGuest.confirmWithRsvp)).toBeVisible();
    await renamed.getByRole("button", { name: guests.removeGuest.confirmButton, exact: true }).click();
    await expect(renamed.getByTestId("guest-name")).toHaveText(["Gael G.", "Gloria"]);

    // The guest page follows the party's current composition.
    await guest.page.goto(link);
    await expect(guest.page.getByRole("group")).toHaveCount(2);
    await expect(guestGroup(guest.page, "Gina")).toHaveCount(0);

    // Delete the party: guests, answers and link go with it.
    await renamed.getByRole("button", { name: guests.deleteParty.open }).click();
    await expect(renamed.getByText(guests.deleteParty.confirmBody)).toBeVisible();
    await renamed.getByRole("button", { name: guests.deleteParty.confirmButton }).click();
    await expect(page.getByText(guests.deleteParty.done)).toBeVisible();
    await expect(page.getByTestId("guest-party")).toHaveCount(0);
    expect(await rsvpCount(weddingId)).toEqual({ guests: 0, rows: 0 });
    await guest.page.goto(link);
    await expectUnavailable(guest.page);

    // A single-guest party offers no "Quitar" for its only guest.
    await createParty(page, "María", ["María"]);
    await expect(guestRow(party(page, "María"), "María").getByRole("button", { name: /Quitar/ })).toHaveCount(0);

    await guest.context.close();
  });

  test("H: an organizer can't reach another wedding's party, even by forging the form", async ({
    browser,
  }) => {
    const ownerB = await freshPage(browser);
    await logIn(ownerB.page, await createAccount("lb9-wedding-b"));
    const weddingB = await createWedding(ownerB.page, "Boda de prueba B", "2090-06-01");
    await openGuests(ownerB.page, weddingB);
    const linkB = await createParty(ownerB.page, "Grupo B", ["Beto"]);
    const partyBId = await party(ownerB.page, "Grupo B")
      .locator('input[name="guestInvitationId"]')
      .first()
      .inputValue();

    const ownerA = await freshPage(browser);
    await logIn(ownerA.page, await createAccount("lb9-wedding-a"));
    const weddingA = await createWedding(ownerA.page, "Boda de prueba A", "2090-06-01");

    // Not a member of B: its guest list is the same 404 as a missing wedding.
    const denied = await ownerA.page.goto(`/app/weddings/${weddingB}/guests`);
    expect(denied?.status()).toBe(404);
    await expect(ownerA.page.getByText("Grupo B")).toHaveCount(0);

    // Forge A's own "Editar grupo" form to target B's party.
    await openGuests(ownerA.page, weddingA);
    await createParty(ownerA.page, "Grupo A", ["Ana"]);
    const cardA = party(ownerA.page, "Grupo A");
    await cardA.getByText(guests.editParty.open, { exact: true }).click();
    await cardA.evaluate((card, forgedId) => {
      for (const input of card.querySelectorAll<HTMLInputElement>('input[name="guestInvitationId"]')) {
        input.value = forgedId;
      }
    }, partyBId);
    await cardA.getByRole("textbox", { name: guests.editParty.label }).fill("Secuestrado");
    await cardA.getByRole("button", { name: guests.editParty.submit }).click();
    await expect(cardA.getByText(guests.errors.notFound)).toBeVisible();

    await ownerB.page.reload();
    await expect(party(ownerB.page, "Grupo B")).toBeVisible();
    await expect(ownerB.page.getByText("Secuestrado")).toHaveCount(0);
    const guest = await freshPage(browser);
    await guest.page.goto(linkB);
    await expect(guest.page.getByRole("heading", { level: 1, name: "Grupo B" })).toBeVisible();

    for (const ctx of [ownerA, ownerB, guest]) await ctx.context.close();
  });

  test("I: a collaborator manages the guest list but not links, settings or members", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("lb9-collab-owner"));
    const weddingId = await createWedding(owner.page, "Boda de prueba Colabora", "2090-06-01");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb9-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));

    // Existing permission model unchanged.
    await expect(collab.page.getByRole("link", { name: es.wedding.settingsLink })).toHaveCount(0);
    await expect(collab.page.getByRole("button", { name: new RegExp(`^${es.members.remove.open}`) })).toHaveCount(0);
    await expect(collab.page.getByText(es.invites.collaboratorNote)).toBeVisible();
    await collab.page.goto(`/app/weddings/${weddingId}/settings`);
    await expect(collab.page.getByText(es.weddingSettings.ownerOnly)).toBeVisible();

    // Guest list: full management.
    await collab.page.goto(`/app/weddings/${weddingId}`);
    await collab.page.getByRole("link", { name: guests.navLink }).click();
    await expect(collab.page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
    const link = await createParty(collab.page, "Amigos del trabajo", ["Tomás"]);
    const card = party(collab.page, "Amigos del trabajo");
    await card.getByText(guests.addGuest.open, { exact: true }).click();
    await card.getByRole("textbox", { name: guests.addGuest.label }).fill("Teresa");
    await card.getByRole("button", { name: guests.addGuest.submit }).click();
    await expect(card.getByTestId("guest-name")).toHaveText(["Tomás", "Teresa"]);

    // Link administration is owner-only: no "Generar nuevo enlace" / "Revocar acceso".
    await expect(card.getByRole("button", { name: guests.rotate.open })).toHaveCount(0);
    await expect(card.getByRole("button", { name: guests.revoke.open })).toHaveCount(0);
    await expect(card.getByText(guests.link.notRecoverableCollaborator)).toBeVisible();

    // The party's initial link (from creation) works for its guests.
    const guest = await freshPage(browser);
    await guest.page.goto(link);
    await answer(guest.page, "Tomás", true);
    await answer(guest.page, "Teresa", false);
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await collab.page.reload();
    await expectGuestStatus(collab.page, "Amigos del trabajo", "Teresa", guests.status.not_attending);

    // The owner sees the collaborator's work and can replace or revoke the link.
    await openGuests(owner.page, weddingId);
    await expect(party(owner.page, "Amigos del trabajo").getByTestId("guest-name")).toHaveText(["Tomás", "Teresa"]);
    await expect(party(owner.page, "Amigos del trabajo").getByRole("button", { name: guests.revoke.open })).toBeVisible();
    const rotated = await rotateLink(owner.page, "Amigos del trabajo");
    expect(rotated).not.toBe(link);
    await guest.page.goto(link);
    await expectUnavailable(guest.page);
    await guest.context.close();

    await owner.context.close();
    await collab.context.close();
  });

  test("J: guest list and RSVP page fit a phone screen (360 and 390 px)", async ({ page, browser }) => {
    await logIn(page, await createAccount("lb9-phone"));
    const weddingId = await createWedding(page, "Boda de prueba Teléfono", "2090-06-01");
    await openGuests(page, weddingId);
    const names = [
      "María Fernanda de los Ángeles Rodríguez Villalobos",
      "Juan Carlos",
      "Sofía",
      "Mateo",
      "Valentina",
    ];
    const link = await createParty(page, "Familia Rodríguez Villalobos y amigos de la infancia", names);

    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 780 });
      await page.reload();
      await expectNoHorizontalScroll(page);
      const card = party(page, "Familia Rodríguez Villalobos y amigos de la infancia");
      await card.getByRole("button", { name: guests.deleteParty.open }).click();
      await expect(card.getByText(guests.deleteParty.confirmBody)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await card.getByRole("button", { name: guests.deleteParty.cancel }).click();
    }

    const guest = await freshPage(browser);
    await guest.page.setViewportSize({ width: 360, height: 740 });
    await guest.page.goto(link);
    await expect(guest.page.getByRole("group")).toHaveCount(5);
    await expectNoHorizontalScroll(guest.page);
    for (const [index, name] of names.entries()) await answer(guest.page, name, index % 2 === 0);
    // Choices are large enough to tap.
    const yesLabel = await guestGroup(guest.page, names[0]).locator("label").first().boundingBox();
    expect(yesLabel?.height ?? 0).toBeGreaterThanOrEqual(44);
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await expectNoHorizontalScroll(guest.page);

    await guest.page.setViewportSize({ width: 390, height: 780 });
    await guest.page.getByRole("link", { name: rsvp.change }).click();
    await expectNoHorizontalScroll(guest.page);

    await guest.context.close();
  });
});
