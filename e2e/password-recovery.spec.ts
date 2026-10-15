import { expect, test, type Page } from "@playwright/test";

import { chooseAccountTypeInBrowser, createAccount, es, fillCredentials, formAlert, logIn, logOut } from "./support/flows";
import { E2E_PASSWORD, uniqueEmail } from "./support/identities";
import { authLinkIn, countEmailsTo, latestEmailTextTo } from "./support/mailpit";

// AUTH-RECOVERY-01: real Supabase Auth recovery against the LOCAL stack. The
// local Auth server's email lands in its Mailpit (never a provider); the
// test opens the link it contains, exactly as a person would.

const copy = es.auth;
const NEW_PASSWORD = "local-only-nueva-clave-e2e";

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

/** The recovery email's link; it returns to this app's callback, continuing to the reset page. */
async function recoveryLink(email: string, baseURL: string): Promise<string> {
  const link = authLinkIn(await latestEmailTextTo(email));
  expect(link.searchParams.get("type")).toBe("recovery");
  expect(link.searchParams.get("redirect_to")).toBe(`${baseURL}/auth/callback?next=%2Freset-password`);
  return link.toString();
}

async function setNewPassword(page: Page, password = NEW_PASSWORD) {
  await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).fill(password);
  await page.getByLabel(copy.resetPassword.confirmPassword, { exact: true }).fill(password);
  await page.getByRole("button", { name: copy.resetPassword.submit }).click();
}

test.describe("password recovery", () => {
  test("A: an untyped account recovers, meets the type choice, and only the new password works", async ({ page, baseURL }) => {
    const email = await createAccount("recover-untyped", null);
    await requestRecovery(page, email);

    await page.goto(await recoveryLink(email, baseURL!));
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole("heading", { level: 1, name: copy.resetPassword.title })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // A mismatch shows as soon as the second field is left, and blocks the submit.
    await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel(copy.resetPassword.confirmPassword, { exact: true }).fill(`${NEW_PASSWORD}-x`);
    await page.getByLabel(copy.resetPassword.newPassword, { exact: true }).focus();
    await expect(page.getByText(copy.validation.passwordMismatch)).toBeVisible();
    await page.getByRole("button", { name: copy.resetPassword.submit }).click();
    await expect(page).toHaveURL(/\/reset-password$/);

    await setNewPassword(page);
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    await chooseAccountTypeInBrowser(page, "planner");
    await expect(page).toHaveURL(/\/app$/);
    await logOut(page);

    await fillCredentials(page, email, E2E_PASSWORD);
    await page.getByRole("button", { name: copy.login.submit }).click();
    await expect(formAlert(page)).toHaveText(copy.login.invalidCredentials);

    await page.goto("/login");
    await fillCredentials(page, email, NEW_PASSWORD);
    await page.getByRole("button", { name: copy.login.submit }).click();
    await expect(page).toHaveURL(/\/app$/);
  });

  for (const type of ["planner", "couple"] as const) {
    test(`B: a ${type} goes to the role-aware /app entry after the reset`, async ({ page, baseURL }) => {
      const email = await createAccount(`recover-${type}`, type);
      await requestRecovery(page, email);
      await page.goto(await recoveryLink(email, baseURL!));
      await setNewPassword(page);
      await expect(page).toHaveURL(/\/app$/);
      await logOut(page);
      await page.goto("/login");
      await fillCredentials(page, email, NEW_PASSWORD);
      await page.getByRole("button", { name: copy.login.submit }).click();
      await expect(page).toHaveURL(/\/app$/);
    });
  }

  test("C: an unknown address gets exactly the same answer and no email; an invalid one is refused locally", async ({ page }) => {
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

  test("D: a link opened in another browser, a reused link and a normal session never unlock the form", async ({
    page,
    browser,
    baseURL,
  }) => {
    const email = await createAccount("recover-guarded", "planner");
    await requestRecovery(page, email);
    const link = await recoveryLink(email, baseURL!);

    // Another browser has no PKCE verifier for this request.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(link);
    await expect(otherPage).toHaveURL(/\/forgot-password\?error=link(?:#.*)?$/);
    await expect(formAlert(otherPage)).toHaveText(copy.forgotPassword.linkInvalid);
    await other.close();

    // That attempt consumed the one-time link: the requesting browser can't reuse it.
    await page.goto(link);
    await expect(page).toHaveURL(/\/forgot-password\?error=link(?:#.*)?$/);

    // An ordinary signed-in session is not a recovery session.
    await logIn(page, email);
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { level: 1, name: copy.resetPassword.invalidTitle })).toBeVisible();
    await expect(page.getByLabel(copy.resetPassword.newPassword, { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: copy.resetPassword.requestNew }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});
