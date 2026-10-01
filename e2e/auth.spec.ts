import { expect, test } from "@playwright/test";

import {
  createAccount,
  createWedding,
  es,
  fillCredentials,
  formAlert,
  logIn,
  logOut,
} from "./support/flows";
import { uniqueEmail } from "./support/identities";

test.describe("authentication", () => {
  test("A: new owner signs up, sees the empty state, creates a wedding and owns it", async ({
    page,
  }) => {
    const email = uniqueEmail("new-owner");

    await page.goto("/");
    await page.getByRole("link", { name: es.home.signup }).click();
    await expect(page).toHaveURL(/\/signup$/);

    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.signup.submit }).click();

    // Local Supabase auto-confirms, so sign-up returns a session directly.
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: es.app.weddings.emptyTitle })).toBeVisible();

    await page.getByRole("link", { name: es.app.weddings.emptyCta }).click();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);

    await createWedding(page, "Boda de prueba E2E", "2027-06-12");
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.owner.label);
    await expect(page.getByText("12 de junio de 2027")).toBeVisible();
    await expect(page.getByRole("heading", { name: es.invites.title })).toBeVisible();

    // The wedding is listed on /app.
    await page.getByRole("link", { name: es.app.nav.myWeddings, exact: true }).click();
    await expect(page.getByRole("link", { name: /Boda de prueba E2E/ })).toBeVisible();
  });

  test("wedding form rejects a blank name with a Spanish field error", async ({ page }) => {
    await logIn(page, await createAccount("blank-name"));
    await page.goto("/app/weddings/new");
    await page.getByLabel(es.weddingNew.nameLabel).fill("   ");
    await page.getByRole("button", { name: es.weddingNew.submit }).click();
    await expect(page.getByText(es.weddingNew.validation.nameRequired)).toBeVisible();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);
  });

  test("B: an existing user logs in; wrong password gets a generic error", async ({ page }) => {
    const email = await createAccount("existing");

    await page.goto("/login");
    await fillCredentials(page, email, "wrong-password-123");
    await page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(formAlert(page)).toHaveText(es.auth.login.invalidCredentials);
    await expect(page).toHaveURL(/\/login$/);

    // Unknown accounts get exactly the same message (no enumeration).
    await page.goto("/login");
    await fillCredentials(page, uniqueEmail("nobody"), "wrong-password-123");
    await page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(formAlert(page)).toHaveText(es.auth.login.invalidCredentials);

    await logIn(page, email);
    await expect(page.getByRole("heading", { name: es.app.weddings.emptyTitle })).toBeVisible();

    // Signed-in users visiting /login or /signup go to /app.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/app$/);
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/app$/);
  });

  test("C: logout ends the session; /app requires login again, even via back", async ({
    page,
  }) => {
    await logIn(page, await createAccount("logout"));
    await logOut(page);

    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);

    await page.goBack();
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: es.app.nav.logout })).toHaveCount(0);
  });

  test("unauthenticated visitors are sent to login, keeping a safe destination", async ({
    page,
  }) => {
    await page.goto("/app/weddings/new");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fweddings%2Fnew$/);
  });

  test("an external next= is ignored after login", async ({ page }) => {
    const email = await createAccount("open-redirect");
    await page.goto("/login?next=https://evil.example/");
    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/app$/);
  });

  test("signing up with an already-registered email doesn't reveal it", async ({ page }) => {
    const email = await createAccount("taken");
    await page.goto("/signup");
    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.signup.submit }).click();
    await expect(page.getByRole("heading", { name: es.auth.signup.checkEmailTitle })).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test("the auth callback rejects a missing or bogus code safely", async ({ page }) => {
    await page.goto("/auth/callback?code=not-a-real-code&next=//evil.example");
    await expect(page).toHaveURL(/\/login\?error=callback$/);
    await expect(formAlert(page)).toHaveText(es.auth.login.callbackFailed);
  });
});
