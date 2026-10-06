import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { E2E_CRON_SECRET } from "./support/cron";
import { createAccount, createInvite, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";
import { emailsTo, rsvpLinkOf, type OutboxMessage } from "./support/outbox";

// LB-17 (ADR-010): automatic RSVP reminders. The app writes emails to the
// local outbox (playwright.config.ts) and runs with a FAKE test-only
// CRON_SECRET; no cron is configured anywhere, so these journeys call the
// scheduler route themselves. The database clock can't be moved, so the test
// tooling (direct local Postgres) sets the wedding's time zone and moves the
// policy's enabled_at into the past; it never performs the actions under
// test. Guest links are bearer credentials: assertions on them are redacted.

const guests = es.guests;
const auto = guests.automaticReminders;
const rsvp = es.rsvp;
const ROUTE = "/api/cron/rsvp-reminders";
const RUN = randomUUID().slice(0, 8);
let addressCounter = 0;

function address(label: string): string {
  addressCounter += 1;
  return `e2e-${RUN}-auto-${label}-${addressCounter}@example.com`;
}

/** A UTC wedding date whose 14-day reminder became due within the last day. */
function dueDate(): string {
  const d = new Date(Date.now() - 10 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + 14);
  return d.toISOString().slice(0, 10);
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

async function setTimeZone(weddingId: string, zone: string) {
  await withDb((db) => db.query("update public.weddings set time_zone = $2 where id = $1", [weddingId, zone]));
}

/** Time travel for the fixture: the owner enabled the policy a month ago. */
async function enabledLongAgo(weddingId: string) {
  await withDb((db) =>
    db.query(
      "update public.wedding_rsvp_reminder_policies set enabled_at = now() - interval '30 days' where wedding_id = $1",
      [weddingId],
    ),
  );
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

async function createParty(page: Page, label: string, names: string[], email?: string): Promise<string> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  if (email) await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  const link = await section.getByTestId("guest-link").inputValue();
  // A fresh page before the next creation (no overlapping form transitions).
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
  return link;
}

async function enablePolicy(page: Page, days: "14" | "21" | "30") {
  const form = page.getByTestId("automatic-reminder-form");
  await form.getByLabel(auto.daysLabel).selectOption(days);
  await form.getByLabel(auto.enabledLabel).check();
  await form.getByRole("button", { name: auto.submit }).click();
  await expect(form.getByText(auto.saved)).toBeVisible();
}

async function runScheduler(request: APIRequestContext, authorization?: string) {
  return request.get(ROUTE, { headers: authorization ? { authorization } : {} });
}

async function remindersTo(to: string): Promise<OutboxMessage[]> {
  return (await emailsTo(to)).filter((m) => m.subject.startsWith("Recordatorio de confirmación"));
}

function automaticStatus(page: Page, label: string): Locator {
  return party(page, label).getByTestId("party-automatic-reminder-status");
}

test.describe("automatic RSVP reminders", () => {
  test("A, B: an owner turns it on (preview first); a collaborator sees it but can't configure it", async ({
    page,
    browser,
  }) => {
    await logIn(page, await createAccount("lb17-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Automática", "2090-06-30");
    const inviteUrl = await createInvite(page, "collaborator");
    await openGuests(page, weddingId);
    await createParty(page, "Familia Programada", ["Ana Programa"], address("programada"));

    // Off by default; without a time zone it can't be turned on yet.
    const panel = page.getByTestId("automatic-reminders");
    await expect(panel.getByTestId("automatic-reminder-status")).toHaveText(auto.statusOff);
    await expect(panel.getByTestId("automatic-reminder-needs-date")).toContainText(auto.needsDate);
    await expect(panel.getByTestId("automatic-reminder-form")).toHaveCount(0);
    await expect(party(page, "Familia Programada").getByTestId("party-automatic-reminder")).toHaveCount(0);

    await setTimeZone(weddingId, "America/Costa_Rica");
    await page.reload();
    const form = panel.getByTestId("automatic-reminder-form");
    await expect(form.getByLabel(auto.enabledLabel)).not.toBeChecked();
    await form.getByLabel(auto.daysLabel).selectOption("21");
    await expect(panel.getByTestId("automatic-reminder-preview-date")).toHaveText(
      "Se enviará el 9 de junio de 2090 a las 10:00 (hora de la boda).",
    );
    await enablePolicy(page, "21");
    await page.reload();
    await expect(panel.getByTestId("automatic-reminder-status")).toHaveText(
      "Activado: 21 días antes de la boda, a las 10:00 (hora de la boda).",
    );
    await expect(panel.getByTestId("automatic-reminder-count")).toHaveText(auto.previewCountOne);
    await expect(automaticStatus(page, "Familia Programada")).toHaveText("Programado para el 9 de junio de 2090.");

    // The collaborator: status visible, no controls.
    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb17-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await openGuests(collab.page, weddingId);
    const collabPanel = collab.page.getByTestId("automatic-reminders");
    await expect(collabPanel.getByTestId("automatic-reminder-status")).toContainText("Activado: 21 días");
    await expect(collabPanel.getByTestId("automatic-reminder-owner-only")).toHaveText(auto.ownerOnly);
    await expect(collabPanel.getByTestId("automatic-reminder-form")).toHaveCount(0);
    await expect(collabPanel.getByRole("checkbox")).toHaveCount(0);
    await expect(automaticStatus(collab.page, "Familia Programada")).toHaveText("Programado para el 9 de junio de 2090.");
    await collab.context.close();
  });

  test("C–I: due parties get exactly one automatic reminder; answered, manually reminded and unrecoverable ones get none", async ({
    page,
    browser,
    request,
  }) => {
    await logIn(page, await createAccount("lb17-due"));
    const weddingId = await createWedding(page, "Boda de prueba Recordatorio Automático", dueDate());
    await setTimeZone(weddingId, "UTC");
    await openGuests(page, weddingId);

    const dueEmail = address("debida");
    const dueLink = await createParty(page, "Familia Debida", ["Ana Debida"], dueEmail);
    const answeredEmail = address("respondio");
    const answeredLink = await createParty(page, "Familia Respondió", ["Luis Respondió"], answeredEmail);
    const manualEmail = address("manual");
    await createParty(page, "Familia Manual", ["Marta Manual"], manualEmail);
    const legacyEmail = address("legado");
    await createParty(page, "Familia Legado", ["Pablo Legado"], legacyEmail);

    // G: one party answers through its own link before the run.
    const guest = await freshPage(browser);
    await guest.page.goto(answeredLink);
    await guest.page
      .getByRole("group", { name: "Luis Respondió", exact: true })
      .getByRole("radio", { name: rsvp.yes })
      .check();
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
    await guest.context.close();

    // H: the owner reminds one party by hand first.
    await page.reload();
    await party(page, "Familia Manual").getByRole("button", { name: guests.reminder.send }).click();
    await expect(party(page, "Familia Manual").getByTestId("reminder-email-result")).toBeVisible();
    expect(await remindersTo(manualEmail)).toHaveLength(1);

    // I: a pre-LB-13 style link (no envelope): it can't be recovered.
    await withDb(async (db) => {
      await db.query(
        `delete from private.guest_invitation_capability_secrets s using public.guest_invitations i
         where s.guest_invitation_id = i.id and i.wedding_id = $1 and i.label = 'Familia Legado'`,
        [weddingId],
      );
    });

    // A: the owner turns it on (14 days); the fixture moves enabled_at back.
    await page.reload();
    await enablePolicy(page, "14");
    await enabledLongAgo(weddingId);

    // J: no secret or a wrong secret runs nothing.
    expect((await runScheduler(request)).status()).toBe(401);
    expect((await runScheduler(request, "Bearer wrong-secret-0123456789abcdefghijklmn")).status()).toBe(401);
    expect((await request.get(`${ROUTE}?secret=${E2E_CRON_SECRET}`)).status()).toBe(401);
    expect(await remindersTo(dueEmail)).toEqual([]);

    // C: the scheduler run.
    const first = await runScheduler(request, `Bearer ${E2E_CRON_SECRET}`);
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toBe("no-store");
    const body = (await first.json()) as Record<string, unknown>;
    expect(Object.values(body).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("@");

    await expect.poll(async () => (await remindersTo(dueEmail)).length).toBe(1);
    const email = (await remindersTo(dueEmail))[0]!;
    expect(rsvpLinkOf(email) === dueLink, "the automatic reminder carries the party's current link (redacted)").toBe(true);
    expect(email.subject).toBe("Recordatorio de confirmación — Boda de prueba Recordatorio Automático");

    // G, H, I: nothing for the others.
    expect(await remindersTo(answeredEmail)).toEqual([]);
    expect(await remindersTo(manualEmail)).toHaveLength(1);
    expect(await remindersTo(legacyEmail)).toEqual([]);

    // F: a second (and third) run sends nothing more.
    for (let i = 0; i < 2; i += 1) {
      expect((await runScheduler(request, `Bearer ${E2E_CRON_SECRET}`)).status()).toBe(200);
    }
    expect(await remindersTo(dueEmail)).toHaveLength(1);
    expect(await remindersTo(manualEmail)).toHaveLength(1);

    // E: statuses on the party cards, separate from the latest email line.
    await page.reload();
    await expect(automaticStatus(page, "Familia Debida")).toContainText("Enviado el");
    await expect(party(page, "Familia Debida").getByTestId("party-reminder-email-status")).toContainText(dueEmail);
    await expect(automaticStatus(page, "Familia Respondió")).toHaveText(auto.party.notSending.answered);
    await expect(automaticStatus(page, "Familia Manual")).toHaveText(auto.party.notSending.recently_reminded);
    await expect(automaticStatus(page, "Familia Legado")).toHaveText(auto.party.notSending.link_unrecoverable);
    const html = await page.content();
    for (const internal of ["recently_reminded", "link_unrecoverable", "sent_unrecorded", "claim_token"]) {
      expect(html.includes(`>${internal}<`)).toBe(false);
    }

    // D: the activity history says "Automático" for the automatic send and
    // keeps the member for the manual one.
    await page.goto(`/app/weddings/${weddingId}/activity`);
    const reminders = page
      .getByTestId("activity-entry")
      .filter({ has: page.getByTestId("activity-event").getByText(es.activity.events.rsvpReminderEmailSent) });
    await expect(reminders).toHaveCount(2);
    await expect(
      reminders.filter({ has: page.getByTestId("activity-party").getByText("Familia Debida") }).getByTestId("activity-actor"),
    ).toHaveText(es.activity.automatic);
    await expect(
      reminders.filter({ has: page.getByTestId("activity-party").getByText("Familia Manual") }).getByTestId("activity-actor"),
    ).toHaveText(es.activity.byYou);
  });
});
