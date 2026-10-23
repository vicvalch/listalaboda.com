import { expect, type Locator, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/supabase/database.types";

import { es } from "../../src/lib/i18n/messages/es";
import { E2E_PASSWORD, uniqueEmail } from "./identities";
import { readLocalSupabase } from "./local-supabase";

export { es };

const WEDDING_PATH = /\/app\/weddings\/([0-9a-f-]{36})(?:\?.*)?$/;
const INVITE_URL = /^http:\/\/localhost:\d+\/invite\/[A-Za-z0-9_-]{43}$/;

/**
 * ACCOUNT-01 (ADR-020): every journey says which account it is. `null` = an
 * account that hasn't chosen yet (it meets the one-time choice on entry).
 */
export type E2EAccountType = "planner" | "couple" | null;

/**
 * Creates a confirmed account through normal sign-up against the local
 * stack (which auto-confirms; see supabase/config.toml), and chooses its
 * account type through the real `select_account_type` RPC as that account
 * (no superuser write). For journeys where the account must already exist
 * before the browser part starts.
 */
export async function createAccount(label: string, accountType: E2EAccountType): Promise<string> {
  const { apiUrl, publishableKey } = readLocalSupabase();
  const email = uniqueEmail(label);
  const client = createClient<Database>(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signUp({ email, password: E2E_PASSWORD });
  if (error || !data.session) {
    throw new Error(`Could not create local E2E account: ${error?.code ?? "no session"}`);
  }
  if (accountType) await chooseAccountType(client, accountType);
  return email;
}

/** The account's own choice, through the one write path (the client holds its session). */
export async function chooseAccountType(
  client: SupabaseClient<Database>,
  accountType: "planner" | "couple",
): Promise<void> {
  const { error } = await client.rpc("select_account_type", { requested: accountType });
  if (error) throw new Error(`Could not choose the E2E account type: ${error.code}`);
}

/** The one-time choice in the browser: pick a card, then confirm with the named button. */
export async function chooseAccountTypeInBrowser(page: Page, accountType: "planner" | "couple") {
  await expect(page).toHaveURL(/\/onboarding\/account-type(?:\?.*)?$/);
  await page.getByRole("radio", { name: es.accountType[accountType].label }).check();
  await page.getByRole("button", { name: es.accountType[accountType].submit }).click();
  await expect(page).not.toHaveURL(/\/onboarding\//);
}

/** The page's own alert (excludes Next's empty route announcer). */
export function formAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

export async function fillCredentials(page: Page, email: string, password = E2E_PASSWORD) {
  await page.getByLabel(es.auth.fields.email).fill(email);
  await page.getByLabel(es.auth.fields.password).fill(password);
}

export async function logIn(page: Page, email: string) {
  await page.goto("/login");
  await fillCredentials(page, email);
  await page.getByRole("button", { name: es.auth.login.submit }).click();
  // LB-24A: /app opens the only wedding directly (0 or 2+ stay on /app).
  // ACCOUNT-01: an account without a type lands on the one-time choice.
  await expect(page).toHaveURL(/\/(?:app(?:\/weddings\/[0-9a-f-]{36})?|onboarding\/account-type)$/);
}

export async function logOut(page: Page) {
  await page.getByRole("button", { name: es.app.nav.logout }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Creates a wedding from /app/weddings/new; returns its id from the URL. */
export async function createWedding(page: Page, name: string, date?: string): Promise<string> {
  await page.goto("/app/weddings/new");
  await page.getByLabel(es.weddingNew.nameLabel).fill(name);
  if (date) await page.getByLabel(es.weddingNew.dateLabel).fill(date);
  await page.getByRole("button", { name: es.weddingNew.submit }).click();
  await expect(page).toHaveURL(WEDDING_PATH);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const match = WEDDING_PATH.exec(page.url());
  if (!match) throw new Error("wedding id not found in URL");
  return match[1];
}

/**
 * Creates an invite on the current wedding page and returns the link. The
 * link is a bearer credential: assertions on it are redacted so a failure
 * never prints it.
 */
export async function createInvite(
  page: Page,
  role: "owner" | "collaborator",
  email?: string,
): Promise<string> {
  await page.getByRole("radio", { name: es.roles[role].label }).check();
  if (email) await page.getByLabel(es.invites.emailLabel).fill(email);
  await page.getByRole("button", { name: es.invites.submit }).click();
  const link = page.getByTestId("invite-link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(INVITE_URL.test(url), "invite link has the expected shape (value redacted)").toBe(true);
  return url;
}

export function weddingIdFromUrl(url: string): string | null {
  return WEDDING_PATH.exec(url)?.[1] ?? null;
}

// ---------------------------------------------------------------- checklist

/** The checklist row whose title is exactly `title`. */
export function checklistItem(page: Page, title: string) {
  return page
    .getByTestId("checklist-item")
    .filter({ has: page.getByText(title, { exact: true }) });
}

export function progressSummary(page: Page) {
  return page.getByTestId("checklist-progress-summary");
}

/** Owner action: creates the suggested checklist on the current wedding page. */
export async function initializeChecklist(page: Page) {
  await page.getByRole("button", { name: es.checklist.init.cta }).click();
  await expect(progressSummary(page)).toHaveText("0 de 38 completados");
}

type NewItem = {
  title: string;
  category?: string;
  timing?:
    | { mode: "absolute"; date: string }
    | { mode: "relative"; days: number; direction: "before" | "after" | "on" };
};

/** Fills a checklist item form (add or edit) inside `scope`. */
export async function fillItemForm(scope: Locator, item: NewItem) {
  const form = es.checklist.form;
  await scope.getByLabel(form.titleLabel, { exact: true }).fill(item.title);
  if (item.category) await scope.getByLabel(form.categoryLabel).selectOption(item.category);
  if (item.timing?.mode === "absolute") {
    await scope.getByRole("radio", { name: form.timingAbsolute }).check();
    await scope.getByLabel(form.dateLabel, { exact: true }).fill(item.timing.date);
  } else if (item.timing?.mode === "relative") {
    await scope.getByRole("radio", { name: form.timingRelative }).check();
    await scope.getByLabel(form.directionLabel).selectOption(item.timing.direction);
    if (item.timing.direction !== "on") {
      await scope.getByLabel(form.daysLabel).fill(String(item.timing.days));
    }
  }
}

/** Adds a custom item through "Agregar pendiente" and waits for it to appear. */
export async function addChecklistItem(page: Page, item: NewItem) {
  const section = page.getByRole("region", { name: es.checklist.form.addTitle });
  await fillItemForm(section, item);
  await section.getByRole("button", { name: es.checklist.form.submitAdd }).click();
  await expect(section.getByRole("status")).toHaveText(es.checklist.announcements.created);
  await expect(checklistItem(page, item.title)).toHaveCount(1);
}

/**
 * UX-01D: a text section's row in "Secciones del sitio" (on the site page),
 * with its editor behind "Editar" opened (left open if it already is).
 */
export async function siteSectionEditor(page: Page, kind: string): Promise<Locator> {
  const card = page.locator(`[data-testid="site-section"][data-kind="${kind}"]`);
  const details = card.getByTestId("site-section-editor");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
  return card;
}
