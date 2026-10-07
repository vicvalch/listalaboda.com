import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { resendEventBody, signWebhook } from "../src/test/fixtures/resend-webhook";

import { E2E_CRON_SECRET } from "./support/cron";
import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";
import { emailsTo, expectEmailCount, type OutboxMessage } from "./support/outbox";
import { E2E_RESEND_WEBHOOK_SECRET } from "./support/webhook";

// LB-18.4 (ADR-010 §7 E9/E11; ADR-011 §10) against the production build: an
// automatic reminder is never sent to a current address this wedding saw
// bounce, and a genuinely different address brings it back. Emails go to the
// local outbox; the bounce arrives through the real signed webhook route with
// a FAKE test-only secret; the scheduler route is called with the FAKE
// test-only CRON_SECRET. The database clock can't be moved, so the test
// tooling (direct local Postgres) sets the time zone, moves the policy's
// enabled_at into the past and reads ground truth; it never performs the
// actions under test. Guest links are bearer credentials: never printed.

const guests = es.guests;
const auto = guests.automaticReminders;
const mail = guests.invitationEmail;
const contact = guests.contactEmail;
const RUN = randomUUID().slice(0, 8);

let counter = 0;
function address(label: string): string {
  counter += 1;
  return `e2e-${RUN}-lb184-${label}-${counter}@example.com`;
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
async function createAndInvite(page: Page, label: string, email: string): Promise<OutboxMessage> {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill("Ana Rebote");
  await section.getByLabel(guests.newParty.emailLabel).fill(email);
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
  await section.getByRole("button", { name: mail.sendFresh }).click();
  await expect(section.getByTestId("invitation-email-result")).toHaveText(mail.sent.replace("{email}", email));
  const sent = await expectEmailCount(email, 1);
  if (!sent) throw new Error("no email captured");
  return sent;
}

async function enablePolicy(page: Page) {
  const form = page.getByTestId("automatic-reminder-form");
  await form.getByLabel(auto.daysLabel).selectOption("14");
  await form.getByLabel(auto.enabledLabel).check();
  await form.getByRole("button", { name: auto.submit }).click();
  await expect(form.getByText(auto.saved)).toBeVisible();
}

async function saveEmail(card: Locator, email: string) {
  await card.getByText(contact.edit, { exact: true }).click();
  await card.getByLabel(contact.fieldLabel).fill(email);
  await card.getByRole("button", { name: contact.submit }).click();
  await expect(card.getByTestId("party-contact-email")).toHaveText(email);
}

async function runScheduler(request: APIRequestContext) {
  const response = await request.get("/api/cron/rsvp-reminders", {
    headers: { authorization: `Bearer ${E2E_CRON_SECRET}` },
  });
  expect(response.status()).toBe(200);
}

async function remindersTo(to: string): Promise<OutboxMessage[]> {
  return (await emailsTo(to)).filter((m) => m.subject.startsWith("Recordatorio de confirmación"));
}

async function occurrence(weddingId: string, label: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{ state: string; outcome_reason: string | null; attempt_count: number }>(
      `select o.state::text as state, o.outcome_reason::text as outcome_reason, o.attempt_count
       from public.automatic_rsvp_reminders o
       join public.guest_invitations i on i.id = o.guest_invitation_id
       where i.wedding_id = $1 and i.label = $2`,
      [weddingId, label],
    );
    return rows[0];
  });
}

test.describe("automatic reminders and undeliverable recipients", () => {
  test("a bounced current address gets no automatic reminder (case-only edits don't help); a new address does", async ({
    page,
    request,
  }) => {
    await logIn(page, await createAccount("lb184-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Rebote Automático", dueDate());
    await withDb((db) => db.query("update public.weddings set time_zone = 'UTC' where id = $1", [weddingId]));
    await openGuests(page, weddingId);

    const label = "Familia Rebote Automático";
    const bad = address("bad");
    const invitation = await createAndInvite(page, label, bad);

    // The owner turns automatic reminders on; the fixture moves enabled_at back.
    await page.reload();
    await enablePolicy(page);
    await withDb((db) =>
      db.query(
        "update public.wedding_rsvp_reminder_policies set enabled_at = now() - interval '30 days' where wedding_id = $1",
        [weddingId],
      ),
    );

    // The provider reports a bounce for the invitation, signed.
    const signed = signWebhook(resendEventBody("email.bounced", invitation.messageId), {
      id: `msg_e2e${RUN}${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      secret: E2E_RESEND_WEBHOOK_SECRET,
    });
    expect((await page.request.post("/api/webhooks/resend", { data: signed.body, headers: signed.headers })).status()).toBe(
      200,
    );

    // The scheduler runs: nothing goes to the bounced address, nothing is consumed.
    await runScheduler(request);
    expect(await remindersTo(bad)).toEqual([]);
    expect(await occurrence(weddingId, label)).toEqual({
      state: "skipped",
      outcome_reason: "recipient_undeliverable",
      attempt_count: 0,
    });
    await page.reload();
    const card = party(page, label);
    await expect(card.getByTestId("party-automatic-reminder-status")).toHaveText(
      auto.party.notSending.recipient_undeliverable,
    );
    await expect(card.getByTestId("party-contact-email-warning")).toBeVisible();
    expect((await page.locator("main").innerText()).includes("recipient_undeliverable")).toBe(false);

    // A case-only edit is the SAME address: still nothing.
    const caseOnly = bad.charAt(0).toUpperCase() + bad.slice(1);
    await saveEmail(card, caseOnly);
    await runScheduler(request);
    expect(await remindersTo(bad)).toEqual([]);
    expect(await remindersTo(caseOnly)).toEqual([]);
    expect(await occurrence(weddingId, label)).toEqual({
      state: "skipped",
      outcome_reason: "recipient_undeliverable",
      attempt_count: 0,
    });
    await page.reload();
    await expect(card.getByTestId("party-automatic-reminder-status")).toHaveText(
      auto.party.notSending.recipient_undeliverable,
    );

    // A genuinely different address: the line is scheduled again and the next
    // run sends ONE reminder to it. The recent invitation went to the OLD
    // address, so it doesn't count as "recently reminded".
    const good = address("good");
    await saveEmail(card, good);
    await page.reload();
    await expect(card.getByTestId("party-automatic-reminder-status")).toContainText("Programado para el");
    await runScheduler(request);
    await expect.poll(async () => (await remindersTo(good)).length).toBe(1);
    expect(await occurrence(weddingId, label)).toEqual({ state: "sent", outcome_reason: null, attempt_count: 1 });
    await runScheduler(request);
    expect(await remindersTo(good)).toHaveLength(1);
    expect(await remindersTo(bad)).toEqual([]);
    await page.reload();
    await expect(card.getByTestId("party-automatic-reminder-status")).toContainText("Enviado el");
  });
});
