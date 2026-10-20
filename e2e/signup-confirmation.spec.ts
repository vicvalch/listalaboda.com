import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  chooseAccountTypeInBrowser,
  createAccount,
  createInvite,
  createWedding,
  es,
  fillCredentials,
  formAlert,
  logIn,
} from "./support/flows";
import { countEmailsTo, latestEmailTo, signupConfirmationLinkIn } from "./support/mailpit";
import { createUnconfirmedAccount, sendSignupConfirmation } from "./support/signup-confirmation";

// Batch 3: scanner-safe, cross-device signup confirmation against the REAL
// local Supabase Auth stack. The email lands in Mailpit, rendered from
// supabase/templates/confirmation.html (the template production uses); the
// tests open the link it contains exactly as a person (or a scanner) would.
// The local stack auto-confirms the signup form, so the email is sent with
// Supabase's own `resend` for an unconfirmed account (support/signup-confirmation).
// Confirmation links are bearer credentials: never printed.

const copy = es.auth.signupConfirm;
const CONFIRM_URL = /\/auth\/confirm(?:\?next=[^&]+)?$/;
const ONBOARDING = /\/onboarding\/account-type(?:\?.*)?$/;

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** A new unconfirmed account and the link of its (count-th) confirmation email. */
async function unconfirmedWithLink(label: string, baseURL: string, next?: string) {
  const email = await createUnconfirmedAccount(label);
  await sendSignupConfirmation(email, baseURL, next);
  return { email, link: await confirmationLink(email, baseURL) };
}

/** The email: Spanish, the app's prepare route with Supabase's token hash and the continuation. */
async function confirmationLink(email: string, baseURL: string, count = 1): Promise<string> {
  const { subject, text } = await latestEmailTo(email, count);
  expect(subject).toBe("Confirma tu cuenta | ListaLaBoda");
  expect(text).toContain("Confirmar mi cuenta");
  expect(text).not.toMatch(/Confirm your (mail|signup)/i);
  const link = signupConfirmationLinkIn(text);
  expect(`${link.origin}${link.pathname}`).toBe(`${baseURL}/auth/confirm/prepare`);
  expect([...link.searchParams.keys()]).toEqual(["token_hash", "redirect_to"]);
  expect(/^(?:pkce_)?[0-9a-f]{56}$/.test(link.searchParams.get("token_hash") ?? ""), "token hash shape (value redacted)").toBe(
    true,
  );
  return link.toString();
}

/** Opens the link: the token leaves the URL at once; the page asks before doing anything. */
async function openLink(page: Page, link: string) {
  await page.goto(link);
  await expect(page).toHaveURL(CONFIRM_URL);
  await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
}

async function pressConfirm(page: Page) {
  await page.getByRole("button", { name: copy.submit }).click();
}

/** Login is still refused as unconfirmed: nothing consumed the token. */
async function expectStillUnconfirmed(page: Page, email: string) {
  await page.goto("/login");
  await fillCredentials(page, email);
  await page.getByRole("button", { name: es.auth.login.submit }).click();
  await expect(formAlert(page)).toHaveText(es.auth.login.emailNotConfirmed);
}

async function expectUsedLinkGuidance(page: Page) {
  await expect(page).toHaveURL(/\/login\?(?:next=[^&]+&)?error=confirm$/);
  await expect(page.getByRole("status").filter({ hasText: es.auth.login.confirmLinkInvalid })).toBeVisible();
  await expect(page.getByText(es.auth.login.callbackFailed)).toHaveCount(0);
}

test.describe("scanner-safe signup confirmation", () => {
  test("A: normal confirmation in another browser → the one-time choice → /app; token never in the page", async ({
    browser,
    baseURL,
  }) => {
    const { email, link } = await unconfirmedWithLink("confirm-a", baseURL!);
    // Browser B: never saw the sign-up (no PKCE verifier, no cookies).
    const b = await freshPage(browser);
    await openLink(b.page, link);
    const token = new URL(link).searchParams.get("token_hash")!;
    expect(b.page.url()).not.toContain(token);
    expect(await b.page.content()).not.toContain(token);
    expect(await b.page.evaluate(() => document.cookie)).not.toContain("lb_signup_token");

    await pressConfirm(b.page);
    await chooseAccountTypeInBrowser(b.page, "planner");
    await expect(b.page).toHaveURL(/\/app$/);
    await b.context.close();

    // The account works with its password everywhere.
    const c = await freshPage(browser);
    await logIn(c.page, email);
    await expect(c.page).not.toHaveURL(/\/login/);
    await c.context.close();
  });

  test("B: GET never consumes the token: a scanner's opens, the link twice, then the person confirms", async ({
    browser,
    baseURL,
  }) => {
    const { email, link } = await unconfirmedWithLink("confirm-b", baseURL!);
    const scanner = await freshPage(browser);
    await scanner.page.goto(link);
    await scanner.page.goto(link);
    await scanner.page.request.get(link, { maxRedirects: 0 });
    await scanner.context.close();

    const person = await freshPage(browser);
    await openLink(person.page, link);
    await openLink(person.page, link);
    await expectStillUnconfirmed(person.page, email);

    await openLink(person.page, link);
    await pressConfirm(person.page);
    await expect(person.page).toHaveURL(ONBOARDING);
    await person.context.close();
  });

  test("C: reuse after confirmation → calm login guidance; in the confirming browser Back/Forward are safe", async ({
    browser,
    baseURL,
  }) => {
    const { email, link } = await unconfirmedWithLink("confirm-c", baseURL!);
    const b = await freshPage(browser);
    await openLink(b.page, link);
    await pressConfirm(b.page);
    await expect(b.page).toHaveURL(ONBOARDING);

    // Back: the confirm page again, now without a token, signed in → "ready, continue".
    await b.page.goBack();
    await expect(b.page).toHaveURL(CONFIRM_URL);
    await expect(b.page.getByRole("heading", { level: 1, name: copy.doneTitle })).toBeVisible();
    await expect(b.page.getByRole("button", { name: copy.submit })).toHaveCount(0);
    await b.page.goForward();
    await expect(b.page).toHaveURL(ONBOARDING);

    // The same browser opens the used link again: signed in, it simply continues.
    await openLink(b.page, link);
    await pressConfirm(b.page);
    await expect(b.page).toHaveURL(ONBOARDING);
    await b.context.close();

    // Another browser reuses it: the login page explains, no scary callback error.
    const c = await freshPage(browser);
    await openLink(c.page, link);
    await pressConfirm(c.page);
    await expectUsedLinkGuidance(c.page);
    await fillCredentials(c.page, email);
    await c.page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(c.page).toHaveURL(ONBOARDING);
    await c.context.close();
  });

  test("D: a retried sign-up before opening the first email: the old link explains, the newest works", async ({
    browser,
    baseURL,
  }) => {
    const { email, link: first } = await unconfirmedWithLink("confirm-d", baseURL!);
    await new Promise((resolve) => setTimeout(resolve, 1_200)); // the local per-address resend interval (1 s)
    await sendSignupConfirmation(email, baseURL!);
    const newest = await confirmationLink(email, baseURL!, 2);
    expect(newest).not.toBe(first);

    const page = (await freshPage(browser)).page;
    await openLink(page, first);
    await pressConfirm(page);
    await expectUsedLinkGuidance(page);

    await openLink(page, newest);
    await pressConfirm(page);
    await expect(page).toHaveURL(ONBOARDING);
    await page.context().close();
  });

  test("E: next=/app/billing survives the email and the one-time choice", async ({ browser, baseURL }) => {
    const { link } = await unconfirmedWithLink("confirm-e", baseURL!, "/app/billing");
    expect(new URL(new URL(link).searchParams.get("redirect_to")!).searchParams.get("next")).toBe("/app/billing");
    const { context, page } = await freshPage(browser);
    await openLink(page, link);
    await expect(page).toHaveURL(/\/auth\/confirm\?next=%2Fapp%2Fbilling$/);
    await pressConfirm(page);
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=%2Fapp%2Fbilling$/);
    await chooseAccountTypeInBrowser(page, "couple");
    await expect(page).toHaveURL(/\/app\/billing$/);
    await context.close();
  });

  test("F: an invitation continues after confirming in the invite's browser (no account type asked)", async ({
    browser,
    baseURL,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("confirm-f-owner", "couple"));
    const weddingId = await createWedding(owner.page, "Boda confirmación");
    const inviteUrl = await createInvite(owner.page, "collaborator");
    await owner.context.close();

    const { context, page } = await freshPage(browser);
    await page.goto(inviteUrl);
    await expect(page).toHaveURL(/\/login\?next=%2Finvite%2Fcontinue$/);
    // The sign-up happened (unconfirmed); the email carries the invite continuation.
    const { link } = await unconfirmedWithLink("confirm-f-invitee", baseURL!, "/invite/continue");
    await openLink(page, link);
    await pressConfirm(page);
    await expect(page).toHaveURL(/\/invite\/continue$/);
    await page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);
    await context.close();
  });

  test("F2: confirmed on another device: reopen the invite there (not 'invalid', no account-type detour), then join only that wedding", async ({
    browser,
    baseURL,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("confirm-f2-owner", "planner"));
    const weddingId = await createWedding(owner.page, "Boda en otro dispositivo");
    const inviteUrl = await createInvite(owner.page, "collaborator");
    await owner.context.close();
    // An unrelated wedding the invite must never open.
    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("confirm-f2-outsider", "planner"));
    const unrelatedId = await createWedding(outsider.page, "Boda ajena");
    await outsider.context.close();

    // Browser A (the computer): the invite, then the sign-up; the handoff cookie lives only here.
    const a = await freshPage(browser);
    await a.page.goto(inviteUrl);
    await expect(a.page).toHaveURL(/\/login\?next=%2Finvite%2Fcontinue$/);
    await a.page.goto("/signup?next=%2Finvite%2Fcontinue");
    await expect(a.page.getByText(es.auth.invitePending)).toBeVisible();
    expect((await a.context.cookies()).some((c) => c.name === "lb_membership_invite")).toBe(true);
    const { link } = await unconfirmedWithLink("confirm-f2-invitee", baseURL!, "/invite/continue");

    // Browser B (the phone): the email link, confirmed there, with no invite context.
    const b = await freshPage(browser);
    expect((await b.context.cookies()).some((c) => c.name === "lb_membership_invite")).toBe(false);
    await openLink(b.page, link);
    await pressConfirm(b.page);
    await expect(b.page).toHaveURL(/\/invite\/continue$/);
    const missing = b.page.getByTestId("invite-missing");
    await expect(missing.getByRole("heading", { level: 1, name: es.inviteMissing.title })).toBeVisible();
    await expect(missing).toContainText(es.inviteMissing.body);
    await expect(missing).toContainText(es.inviteMissing.newLink);
    await expect(b.page.getByText(es.inviteInvalid.title)).toHaveCount(0);
    // No way into the one-time account-type choice from here: reopening the invite is the way in.
    await expect(b.page.getByRole("link", { name: es.common.goToMyWeddings })).toHaveCount(0);
    await expect(missing.locator('a[href^="/app"], a[href^="/onboarding"]')).toHaveCount(0);

    // Reopening the original invitation in B continues normally, without the choice.
    await b.page.goto(inviteUrl);
    await expect(b.page).toHaveURL(/\/invite\/continue$/);
    await b.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(b.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await expect(b.page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);
    await expect(b.page).not.toHaveURL(ONBOARDING);

    // Only that wedding. Still untyped, any other wedding (real or not) stops at the one-time
    // choice before any wedding data, as for every invitee (SIT-01)…
    for (const id of [unrelatedId, "00000000-0000-4000-8000-000000000000"]) {
      await b.page.goto(`/app/weddings/${id}`);
      await expect(b.page).toHaveURL(ONBOARDING);
      await expect(b.page.getByText("Boda ajena")).toHaveCount(0);
    }
    // …and once a type is chosen, the unrelated wedding is the same 404 as a missing one.
    await b.page.goto("/app");
    await chooseAccountTypeInBrowser(b.page, "planner");
    const response = await b.page.goto(`/app/weddings/${unrelatedId}`);
    expect(response?.status()).toBe(404);
    await expect(b.page.getByText("Boda ajena")).toHaveCount(0);
    await b.page.goto(`/app/weddings/${weddingId}`);
    await expect(b.page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);

    await a.context.close();
    await b.context.close();
  });

  test("G: invalid, unknown and used tokens look the same; a malformed link shows only 'not available'", async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await freshPage(browser);
    await openLink(page, `${baseURL}/auth/confirm/prepare?token_hash=pkce_${"0".repeat(56)}`);
    await pressConfirm(page);
    await expectUsedLinkGuidance(page);
    const unknownText = await page.getByRole("status").filter({ hasText: es.auth.login.confirmLinkInvalid }).innerText();

    await page.goto(`${baseURL}/auth/confirm/prepare?token_hash=%3Cscript%3E`);
    await expect(page).toHaveURL(/\/auth\/confirm$/);
    await expect(page.getByRole("heading", { level: 1, name: copy.unavailableTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: copy.login })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("button", { name: copy.submit })).toHaveCount(0);
    await context.close();

    // A real, used link gives exactly the same words.
    const { link } = await unconfirmedWithLink("confirm-g", baseURL!);
    const b = await freshPage(browser);
    await openLink(b.page, link);
    await pressConfirm(b.page);
    await b.context.close();
    const c = await freshPage(browser);
    await openLink(c.page, link);
    await pressConfirm(c.page);
    await expectUsedLinkGuidance(c.page);
    expect(await c.page.getByRole("status").filter({ hasText: es.auth.login.confirmLinkInvalid }).innerText()).toBe(
      unknownText,
    );
    await c.context.close();
  });

  test("H: signing up again with a confirmed account: the same neutral answer, login guidance, no email", async ({
    page,
  }) => {
    const email = await createAccount("confirm-h", "planner");
    const before = await countEmailsTo(email);
    await page.goto("/signup?next=%2Fapp%2Fbilling");
    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.signup.submit }).click();
    const status = page.getByRole("status").filter({ hasText: es.auth.signup.checkEmailTitle });
    await expect(status).toContainText(es.auth.signup.checkEmailBody);
    for (const hint of es.auth.signup.checkEmailHints) await expect(status).toContainText(hint);
    await expect(status).not.toContainText("mismo navegador");
    await expect(status.getByRole("link", { name: es.auth.signup.checkEmailLogin })).toHaveAttribute(
      "href",
      "/login?next=%2Fapp%2Fbilling",
    );
    await expect(page).toHaveURL(/\/signup\?next=%2Fapp%2Fbilling$/);
    expect(await countEmailsTo(email)).toBe(before);
  });
});
