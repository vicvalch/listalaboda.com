import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  chooseAccountTypeInBrowser,
  createAccount,
  createWedding,
  es,
  fillCredentials,
  formAlert,
  logIn,
  logOut,
} from "./support/flows";
import { E2E_PASSWORD } from "./support/identities";
import { readLocalSupabase } from "./support/local-supabase";
import { measure } from "./support/marketing";
import { createAccountWithId, seedWedding } from "./support/overview";

// ACCOUNT-01 (ADR-020): one account = one type, chosen once after signing in.
// Synthetic local accounts only (fake @example.test addresses, no email sent).

const copy = es.accountType;
const ONBOARDING = /\/onboarding\/account-type(?:\?.*)?$/;
const WEDDING_URL = (id: string) => new RegExp(`/app/weddings/${id}$`);

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function headerNav(page: Page) {
  return page.getByRole("navigation", { name: es.app.nav.label });
}

/** The account's own API session: what a crafted request could try outside the UI. */
async function apiAs(email: string) {
  const { apiUrl, publishableKey } = readLocalSupabase();
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: E2E_PASSWORD });
  if (error) throw new Error(`sign-in failed: ${error.code}`);
  return client;
}

async function storedAccountType(email: string): Promise<string | null> {
  const client = await apiAs(email);
  const { data } = await client.from("user_accounts").select("account_type").maybeSingle();
  return data?.account_type ?? null;
}

test.describe("account type onboarding", () => {
  test("A: a new account meets the choice right after signing in; choosing a card alone saves nothing", async ({ page }) => {
    const email = await createAccount("acct-new", null);
    await logIn(page, email);
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    await expect(page.getByRole("heading", { level: 1, name: copy.title })).toBeVisible();
    const radios = page.getByRole("radio");
    await expect(radios).toHaveCount(2);
    for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
    await expect(page.getByText(copy.warning)).toBeVisible();

    // Nothing preselected: the generic button refuses, and no type is stored.
    await page.getByRole("button", { name: copy.submit, exact: true }).click();
    await expect(page.getByText(copy.required)).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);

    // A card click only selects (the button names the choice); leaving saves nothing.
    await page.getByRole("radio", { name: copy.couple.label }).check();
    await expect(page.getByRole("button", { name: copy.couple.submit })).toBeVisible();
    await page.getByRole("radio", { name: copy.planner.label }).check();
    await expect(page.getByRole("button", { name: copy.planner.submit })).toBeVisible();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    expect(await storedAccountType(email)).toBeNull();
  });

  test("B + D: planner → Mis bodas; never asked again, can't become a couple, returning login goes straight in", async ({ page }) => {
    const email = await createAccount("acct-planner", null);
    await logIn(page, email);
    await chooseAccountTypeInBrowser(page, "planner");
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: es.app.weddings.emptyTitle })).toBeVisible();
    await expect(headerNav(page).getByRole("link", { name: es.app.nav.myWeddings })).toBeVisible();
    await expect(headerNav(page).getByRole("link", { name: es.app.nav.createWedding })).toBeVisible();

    // The choice page is gone for this account.
    await page.goto("/onboarding/account-type");
    await expect(page).toHaveURL(/\/app$/);

    // Nor can a crafted request switch it.
    const { error } = await (await apiAs(email)).rpc("select_account_type", { requested: "couple" });
    expect(error?.message).toBe("account_type_already_selected");
    expect(await storedAccountType(email)).toBe("planner");

    // Planners keep creating weddings.
    const first = await createWedding(page, "Boda cliente uno");
    const second = await createWedding(page, "Boda cliente dos");
    expect(first).not.toBe(second);

    // D: a returning planner signs in without the question.
    await logOut(page);
    await logIn(page, email);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByTestId("wedding-card")).toHaveCount(2);
  });

  test("C + E: couple → their own wedding; one wedding only, never asked again, returning login opens it", async ({ page }) => {
    const email = await createAccount("acct-couple", null);
    await logIn(page, email);
    await chooseAccountTypeInBrowser(page, "couple");
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: es.app.weddings.couple.emptyTitle })).toBeVisible();
    // No portfolio: no "Mis bodas", no "Crear boda" in the header.
    await expect(headerNav(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: es.app.nav.myWeddings })).toHaveCount(0);

    await page.getByRole("link", { name: es.app.weddings.couple.emptyCta }).click();
    await expect(page).toHaveURL(/\/app\/weddings\/new$/);
    const weddingId = await createWedding(page, "Boda de Ana y Luis", "2090-06-01");
    await expect(page.getByRole("link", { name: es.wedding.backToWeddings })).toHaveCount(0);

    // /app is the wedding now; asking for the list changes nothing.
    await page.goto("/app");
    await expect(page).toHaveURL(WEDDING_URL(weddingId));
    await page.goto("/app?all=1");
    await expect(page).toHaveURL(WEDDING_URL(weddingId));

    // No second wedding through the normal flow (the page sends them home).
    await page.goto("/app/weddings/new");
    await expect(page).toHaveURL(WEDDING_URL(weddingId));

    // Never asked again; a crafted switch is refused.
    await page.goto("/onboarding/account-type");
    await expect(page).toHaveURL(WEDDING_URL(weddingId));
    const { error } = await (await apiAs(email)).rpc("select_account_type", { requested: "planner" });
    expect(error?.message).toBe("account_type_already_selected");
    expect(await storedAccountType(email)).toBe("couple");

    // E: a returning couple signs in straight into their wedding.
    await logOut(page);
    await logIn(page, email);
    await expect(page).toHaveURL(WEDDING_URL(weddingId));
  });

  test("a couple's create form, opened before their first wedding existed, is refused on submit", async ({ browser }) => {
    const email = await createAccount("acct-couple-race", "couple");
    const tabA = await freshPage(browser);
    const tabB = await freshPage(browser);
    await logIn(tabA.page, email);
    await logIn(tabB.page, email);
    await tabB.page.goto("/app/weddings/new");
    await createWedding(tabA.page, "Boda primera");

    await tabB.page.getByLabel(es.weddingNew.nameLabel).fill("Boda segunda");
    await tabB.page.getByRole("button", { name: es.weddingNew.submit }).click();
    await expect(formAlert(tabB.page)).toHaveText(es.app.weddings.couple.createBlocked);
    await expect(tabB.page).toHaveURL(/\/app\/weddings\/new$/);

    await tabA.context.close();
    await tabB.context.close();
  });

  test("H: an untyped account can't skip the choice through a deep link, and continues there afterwards", async ({ browser }) => {
    // A fake planner flag in user_metadata never decides the type.
    const me = await createAccountWithId("acct-deep", null, { account_type: "planner", planner: true });
    const weddingId = await seedWedding({ name: "Boda heredada", members: [{ userId: me.id, role: "owner" }] });
    const { context, page } = await freshPage(browser);

    // Signed out, a deep link goes to login and keeps the destination...
    await page.goto(`/app/weddings/${weddingId}/guests`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await fillCredentials(page, me.email);
    await page.getByRole("button", { name: es.auth.login.submit }).click();
    // ...then to the choice (not the guest list), still carrying it.
    await expect(page).toHaveURL(
      new RegExp(`/onboarding/account-type\\?next=${encodeURIComponent(`/app/weddings/${weddingId}/guests`)}$`),
    );

    // Every other /app URL leads to the same place.
    for (const path of ["/app", "/app?all=1", "/app/weddings/new", `/app/weddings/${weddingId}`, `/app/weddings/${weddingId}/budget`]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(ONBOARDING);
    }

    await page.goto(`/onboarding/account-type?next=${encodeURIComponent(`/app/weddings/${weddingId}/guests`)}`);
    await chooseAccountTypeInBrowser(page, "couple");
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/guests$`));
    await context.close();
  });

  test("legacy: an existing account in several weddings chooses couple and keeps every wedding", async ({ page }) => {
    const me = await createAccountWithId("acct-legacy", null);
    const a = await seedWedding({ name: "Boda heredada A", date: "2090-03-01", members: [{ userId: me.id, role: "owner" }] });
    const b = await seedWedding({ name: "Boda heredada B", date: null, members: [{ userId: me.id, role: "collaborator" }] });
    await logIn(page, me.email);
    await chooseAccountTypeInBrowser(page, "couple");

    await expect(page).toHaveURL(/\/app$/);
    const legacy = page.getByTestId("couple-legacy-weddings");
    await expect(legacy.getByText(es.app.weddings.couple.legacyBody)).toBeVisible();
    await expect(legacy.getByRole("link")).toHaveText(["Boda heredada A", "Boda heredada B"]);
    await expect(page.getByRole("link", { name: es.app.weddings.createAnother })).toHaveCount(0);
    await expect(page.getByTestId("global-attention")).toHaveCount(0);

    // Each wedding still opens; nothing was deleted or moved; no new wedding offered.
    await legacy.getByRole("link", { name: "Boda heredada B" }).click();
    await expect(page).toHaveURL(WEDDING_URL(b));
    await page.goto(`/app/weddings/${a}`);
    await expect(page.getByRole("heading", { level: 1, name: "Boda heredada A" })).toBeVisible();
    await page.goto("/app/weddings/new");
    await expect(page).toHaveURL(/\/app$/);
  });

  test("signed out, the choice page asks to log in first", async ({ page }) => {
    await page.goto("/onboarding/account-type");
    await expect(page).toHaveURL(/\/login\?next=%2Fonboarding%2Faccount-type$/);
  });

  test("F: / redirects to the planner landing", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/planners$/);
  });
});

test.describe("account type onboarding: layout", () => {
  test("fits 360, 390, 768 and 1280 px in light and dark, with AA text and a keyboard path", async ({ browser }) => {
    test.setTimeout(120_000);
    const email = await createAccount("acct-layout", null);
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await logIn(page, email);
      for (const width of [360, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/onboarding/account-type");
        const result = await measure(page);
        expect(result.scrolls, `${colorScheme} ${width}px: no horizontal scroll`).toBe(false);
        expect(result.lowContrast, `${colorScheme} ${width}px: WCAG AA text`).toEqual([]);
      }
      // Keyboard: choose with the arrow keys, confirm with Enter on the named button.
      await page.getByRole("radio", { name: copy.planner.label }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("radio", { name: copy.planner.label })).toBeChecked();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("radio", { name: copy.couple.label })).toBeChecked();
      await expect(page.getByRole("button", { name: copy.couple.submit })).toBeVisible();
      await context.close();
    }
    expect(await storedAccountType(email)).toBeNull();
  });
});
