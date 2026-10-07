import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { resendEventBody, signWebhook } from "../src/test/fixtures/resend-webhook";

import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";
import { expectEmailCount, rsvpLinkOf } from "./support/outbox";
import { E2E_RESEND_WEBHOOK_SECRET } from "./support/webhook";

// LB-18.2 (ADR-011 §7): the signed Resend webhook against the production
// build. The app writes emails to the local outbox; the journey signs a
// delivery event for that send with a FAKE test-only secret and posts it
// like the provider would. There is no delivery UI yet, so the outcome is
// read from local Postgres (test tooling only, never the action under test).
// Guest links are bearer credentials: assertions on them are redacted.

const guests = es.guests;
const mail = guests.invitationEmail;
const ROUTE = "/api/webhooks/resend";
const RUN = randomUUID().slice(0, 8);

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

function eventId(): string {
  return `msg_e2e${RUN}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

test.describe("Resend delivery webhook", () => {
  test("a signed delivery event for a real send is accepted; unsigned and forged ones are refused", async ({ page, request }) => {
    await logIn(page, await createAccount("lb18-webhook-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Webhook", "2090-06-01");
    await page.goto(`/app/weddings/${weddingId}/guests`);
    await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();

    const recipient = `e2e-${RUN}-webhook@example.com`;
    const section = page.getByRole("region", { name: guests.newParty.title });
    await section.getByLabel(guests.newParty.labelLabel).fill("Familia Webhook");
    await section.getByLabel(guests.newParty.namesLabel).fill("Ana Webhook");
    await section.getByLabel(guests.newParty.emailLabel).fill(recipient);
    await section.getByRole("button", { name: guests.newParty.submit }).click();
    await expect(party(page, "Familia Webhook")).toBeVisible();
    await section.getByRole("button", { name: mail.sendFresh }).click();
    await expect(section.getByTestId("invitation-email-result")).toHaveText(mail.sent.replace("{email}", recipient));

    const email = await expectEmailCount(recipient, 1);
    if (!email) throw new Error("no email captured");

    // Unsigned: 401, nothing recorded.
    const unsigned = await request.post(ROUTE, {
      data: resendEventBody("email.delivered", email.messageId),
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.status()).toBe(401);
    expect(await unsigned.text()).toBe("");

    // Forged (another secret): 401.
    const forged = signWebhook(resendEventBody("email.complained", email.messageId), {
      id: eventId(),
      secret: `whsec_${Buffer.from("TEST-ONLY-forger-webhook-key-000").toString("base64")}`,
    });
    const forgedResponse = await request.post(ROUTE, { data: forged.body, headers: forged.headers });
    expect(forgedResponse.status()).toBe(401);

    // Signed with the deployment's (fake) secret: 200, empty, no cookies.
    const signed = signWebhook(resendEventBody("email.delivered", email.messageId), {
      id: eventId(),
      secret: E2E_RESEND_WEBHOOK_SECRET,
    });
    const accepted = await request.post(ROUTE, { data: signed.body, headers: signed.headers });
    expect(accepted.status()).toBe(200);
    expect(await accepted.text()).toBe("");
    expect(accepted.headers()["cache-control"]).toBe("no-store");
    expect(accepted.headers()["set-cookie"]).toBeUndefined();

    // The provider's retry of the same event: 200 again, still one event.
    expect((await request.post(ROUTE, { data: signed.body, headers: signed.headers })).status()).toBe(200);

    const state = await withDb(async (db) => {
      const delivery = (
        await db.query<{ id: string; status: string }>(
          "select id, status::text as status from public.email_deliveries where provider_message_id = $1",
          [email.messageId],
        )
      ).rows[0];
      const events = (
        await db.query<{ n: number }>("select count(*)::int as n from public.email_delivery_events where delivery_id = $1", [
          delivery?.id,
        ])
      ).rows[0];
      return { status: delivery?.status, events: events?.n };
    });
    expect(state).toEqual({ status: "delivered", events: 1 });

    // Other methods don't exist.
    expect((await request.get(ROUTE)).status()).toBe(405);

    // The guest's RSVP page and the wedding's guest page are unaffected.
    const guest = await page.context().browser()!.newContext();
    const guestPage = await guest.newPage();
    const response = await guestPage.goto(rsvpLinkOf(email));
    expect(response?.status()).toBe(200);
    await expect(guestPage.getByRole("heading", { level: 1, name: "Familia Webhook" })).toBeVisible();
    await guest.close();

    await page.goto(`/app/weddings/${weddingId}/guests`);
    await expect(party(page, "Familia Webhook")).toBeVisible();
    await expect(page.getByText("delivered")).toHaveCount(0);
  });
});
