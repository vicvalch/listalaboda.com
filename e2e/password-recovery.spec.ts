import { expect, test, type Browser, type Page } from "@playwright/test";

import { chooseAccountTypeInBrowser, createAccount, es, fillCredentials, formAlert, logIn, logOut } from "./support/flows";
import { E2E_PASSWORD, uniqueEmail } from "./support/identities";
import { countEmailsTo, latestEmailTextTo, recoveryLinkIn } from "./support/mailpit";

// AUTH-RECOVERY-02: scanner-safe recovery against the REAL local Supabase
// Auth stack. Its emails land in Mailpit (never a provider), rendered from
// supabase/templates/recovery.html, the same template production uses; the
// tests open the link it contains exactly as a person (or a scanner) would.
// Recovery links are bearer credentials: never printed.

const copy = es.auth;
const confirm = copy.recoveryConfirm;
const NEW_PASSWORD = "local-only-nueva-clave-e2e";
const CONFIRM_URL = /\/auth\/recovery\/confirm$/;

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function requestRecovery(page: Page, email: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: copy.login.forgotPassword }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel(copy.fields.email).fill(email);
  await page.getByRole("button", { name: copy.forgotPassword.submit }).click();
  await expect(page.getByRole("status").filter({ hasText: copy.forgotPassword.sentTitle })).toContainText(
    copy.forgotPassword.sentBody,
  );
}

/** The email's link: the app's prepare route with Supabase's token hash, nothing else. */
async function recoveryLink(email: string, baseURL: string): Promise<string> {
  const link = recoveryLinkIn(await latestEmailTextTo(email));
  expect(`${link.origin}${link.pathname}`).toBe(`${baseURL}/auth/recovery/prepare`);
  expect([...link.searchParams.keys()]).toEqual(["token_hash"]);
  expect(/^pkce_[0-9a-f]{56}$/.test(link.searchParams.get("token_hash") ?? ""), "token hash shape (value redacted)").toBe(true);
  return link.toString();
}

/** Opens the link: the token leaves the URL at once; the page asks before doing anything. */
async function openLink(page: Page, link: string) {
  await page.goto(link);
  await expect(page).toHaveURL(CONFIRM_URL);
  await expect(page.getByRole("heading", { level: 1, name: confirm.title })).toBeVisible();
}

async function pressContinue(page: Page) {
  await page.getByRole("button", { name: confirm.submit }).click();
}

async function setNewPassword(page: Page, password = NEW_PASSWORD) {
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).fill(password);
  await page.getByLabel(copy.resetPassword.confirmPassword, { exact: true }).fill(password);
  await page.getByRole("button", { name: copy.resetPassword.submit }).click();
}

async function expectLoginWorks(page: Page, email: string, password: string) {
  await page.goto("/login");
  await fillCredentials(page, email, password);
  await page.getByRole("button", { name: copy.login.submit }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function expectLoginRefused(page: Page, email: string, password: string) {
  await page.goto("/login");
  await fillCredentials(page, email, password);
  await page.getByRole("button", { name: copy.login.submit }).click();
  await expect(formAlert(page)).toHaveText(copy.login.invalidCredentials);
}

test.describe("scanner-safe password recovery", () => {
  test("A: normal recovery; the token stays out of the URL, the page and JavaScript; only the new password works", async ({
    page,
    context,
    baseURL,
  }) => {
    const email = await createAccount("recover-untyped", null);
    await requestRecovery(page, email);
    const link = await recoveryLink(email, baseURL!);
    const token = new URL(link).searchParams.get("token_hash")!;

    await openLink(page, link);
    const handoff = (await context.cookies()).find((c) => c.name === "lb_recovery_token");
    expect(handoff?.httpOnly).toBe(true);
    expect(handoff?.sameSite).toBe("Lax");
    expect(handoff?.path).toBe("/auth/recovery");
    expect(handoff ? handoff.expires * 1000 - Date.now() : 0).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
    expect(await page.evaluate(() => document.cookie)).not.toContain("lb_recovery_token");
    expect((await page.content()).includes(token), "token absent from the HTML").toBe(false);
    expect(page.url().includes(token), "token absent from the URL").toBe(false);

    await pressContinue(page);
    await expect(page.getByRole("heading", { level: 1, name: copy.resetPassword.title })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === "lb_recovery_token")).toBe(false);

    // A mismatch shows as soon as the second field is left, and blocks the submit.
    await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel(copy.resetPassword.confirmPassword, { exact: true }).fill(`${NEW_PASSWORD}-x`);
    await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).focus();
    await expect(page.getByText(copy.validation.passwordMismatch)).toBeVisible();

    // Untyped → the one-time choice (post-reset routing unchanged).
    await setNewPassword(page);
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    await chooseAccountTypeInBrowser(page, "planner");
    await expect(page).toHaveURL(/\/app$/);
    await logOut(page);

    await expectLoginRefused(page, email, E2E_PASSWORD);
    await expectLoginWorks(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/app$/);
  });

  for (const type of ["planner", "couple"] as const) {
    test(`A: a ${type} goes to the role-aware /app entry after the reset`, async ({ page, baseURL }) => {
      const email = await createAccount(`recover-${type}`, type);
      await requestRecovery(page, email);
      await openLink(page, await recoveryLink(email, baseURL!));
      await pressContinue(page);
      await setNewPassword(page);
      await expect(page).toHaveURL(/\/app$/);
    });
  }

  test("B: a scanner opening the exact email URL first consumes nothing; the person then recovers", async ({
    browser,
    baseURL,
  }) => {
    const email = await createAccount("recover-scanned", "planner");
    const user = await freshPage(browser);
    await requestRecovery(user.page, email);
    const link = await recoveryLink(email, baseURL!);

    // The scanner follows the link (and its redirect) in its own cookie jar, renders it, never presses anything.
    const scanner = await freshPage(browser);
    await openLink(scanner.page, link);
    await scanner.context.close();

    await openLink(user.page, link);
    await pressContinue(user.page);
    await setNewPassword(user.page);
    await expect(user.page).toHaveURL(/\/app$/);
    await logOut(user.page);
    await expectLoginWorks(user.page, email, NEW_PASSWORD);
    await user.context.close();
  });

  test("C: three GETs of the same link leave it usable; the explicit POST then succeeds", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const email = await createAccount("recover-many-gets", "planner");
    await requestRecovery(page, email);
    const link = await recoveryLink(email, baseURL!);

    for (let i = 1; i <= 3; i++) {
      const prefetcher = await playwright.request.newContext();
      const response = await prefetcher.get(link, { maxRedirects: 0 });
      expect(response.status(), `GET ${i}`).toBe(303);
      expect(new URL(response.headers()["location"]!).pathname).toBe("/auth/recovery/confirm");
      // Following the redirect renders the page; still nothing consumed.
      expect((await prefetcher.get(link)).status(), `GET ${i} followed`).toBe(200);
      await prefetcher.dispose();
    }

    await openLink(page, link);
    await pressContinue(page);
    await setNewPassword(page);
    await expect(page).toHaveURL(/\/app$/);
  });

  test("D: requested in browser A, opened and completed in browser B", async ({ browser, baseURL }) => {
    const email = await createAccount("recover-cross", "couple");
    const a = await freshPage(browser);
    await requestRecovery(a.page, email);
    const link = await recoveryLink(email, baseURL!);
    await a.context.close();

    const b = await freshPage(browser);
    await openLink(b.page, link);
    await pressContinue(b.page);
    await setNewPassword(b.page);
    await expect(b.page).toHaveURL(/\/app$/);
    await logOut(b.page);
    await expectLoginWorks(b.page, email, NEW_PASSWORD);
    await b.context.close();
  });

  test("E: after a successful use, the same link fails safely everywhere and opens nothing", async ({
    browser,
    baseURL,
  }) => {
    const email = await createAccount("recover-replay", "planner");
    const first = await freshPage(browser);
    await requestRecovery(first.page, email);
    const link = await recoveryLink(email, baseURL!);
    await openLink(first.page, link);
    await pressContinue(first.page);
    await expect(first.page).toHaveURL(/\/reset-password$/);

    // Another browser replays it: the page asks again, but Continuar fails (already used).
    const replay = await freshPage(browser);
    await openLink(replay.page, link);
    await pressContinue(replay.page);
    await expect(replay.page).toHaveURL(/\/forgot-password\?error=link$/);
    await expect(formAlert(replay.page)).toHaveText(copy.forgotPassword.linkInvalid);
    expect((await replay.context.cookies()).some((c) => c.name === "lb_recovery_token")).toBe(false);
    await replay.page.goto("/reset-password");
    await expect(replay.page.getByRole("heading", { level: 1, name: copy.resetPassword.invalidTitle })).toBeVisible();
    await expect(replay.page.getByLabel(copy.resetPassword.newPassword, { exact: true })).toHaveCount(0);

    // The original browser too.
    await openLink(first.page, link);
    await pressContinue(first.page);
    await expect(first.page).toHaveURL(/\/forgot-password\?error=link$/);

    // A GET to the confirm page without a pending token: "no longer available".
    await replay.page.goto("/auth/recovery/confirm");
    await expect(replay.page.getByRole("heading", { level: 1, name: confirm.unavailableTitle })).toBeVisible();
    await replay.page.getByRole("link", { name: confirm.requestNew }).click();
    await expect(replay.page).toHaveURL(/\/forgot-password$/);
    await first.context.close();
    await replay.context.close();
  });

  test("F: a forged token in the query or the form never overrides the httpOnly one", async ({ browser, baseURL }) => {
    const victim = await createAccount("recover-forged-victim", "planner");
    const attacker = await createAccount("recover-forged-attacker", "planner");
    const { context, page } = await freshPage(browser);
    await requestRecovery(page, victim);
    const victimLink = await recoveryLink(victim, baseURL!);
    await requestRecovery(page, attacker);
    const forged = new URL(await recoveryLink(attacker, baseURL!)).searchParams.get("token_hash")!;

    // The query alone, without a pending cookie, unlocks nothing.
    const bare = await freshPage(browser);
    await bare.page.goto(`/auth/recovery/confirm?token_hash=${forged}`);
    await expect(bare.page.getByRole("heading", { level: 1, name: confirm.unavailableTitle })).toBeVisible();
    await bare.context.close();

    // A pending cookie (the victim's link) + a different token in the query AND injected into the form.
    await openLink(page, victimLink);
    await page.goto(`/auth/recovery/confirm?token_hash=${forged}&type=signup`);
    await page.evaluate((value) => {
      const form = document.querySelector("form");
      for (const [name, v] of [["token_hash", value], ["type", "signup"]] as const) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = v;
        form?.appendChild(input);
      }
    }, forged);
    await pressContinue(page);
    // Only the cookie's token was verified: the reset is for the victim's own account.
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByText(victim)).toBeVisible();
    await expect(page.getByText(attacker)).toHaveCount(0);
    await context.close();
  });

  test("G: an unknown address gets exactly the same answer and no email; an invalid one is refused locally", async ({ page }) => {
    const nobody = uniqueEmail("recover-nobody");
    await requestRecovery(page, nobody);
    // Give the local Auth server time to (not) deliver anything.
    await page.waitForTimeout(1500);
    expect(await countEmailsTo(nobody)).toBe(0);

    await page.goto("/forgot-password");
    await page.getByLabel(copy.fields.email).fill("no-es-un-correo");
    await page.getByRole("button", { name: copy.forgotPassword.submit }).click();
    await expect(page.getByText(copy.validation.emailInvalid)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: copy.forgotPassword.sentTitle })).toHaveCount(0);
  });

  test("an ordinary password session never opens the reset form", async ({ page }) => {
    const email = await createAccount("recover-ordinary", "planner");
    await logIn(page, email);
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { level: 1, name: copy.resetPassword.invalidTitle })).toBeVisible();
    await expect(page.getByLabel(copy.resetPassword.newPassword, { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: copy.resetPassword.requestNew }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});
