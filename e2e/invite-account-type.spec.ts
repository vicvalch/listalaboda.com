import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";

import { createAccount, createInvite, createWedding, es, fillCredentials, logIn, logOut } from "./support/flows";
import { uniqueEmail } from "./support/identities";
import { readLocalSupabase } from "./support/local-supabase";

// SIT-01: an invite decides the role in ONE wedding, never the account type.
// An untyped invitee enters the wedding it has just joined, without the
// one-time choice, and stays untyped; the normal /app entry still asks.

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function withDb<T>(run: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** The stored account type (null = no row: not chosen). Local assertion only. */
async function accountTypeOf(email: string): Promise<string | null> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ account_type: string | null }>(
      `select ua.account_type::text as account_type
         from auth.users u left join public.user_accounts ua on ua.user_id = u.id
        where u.email = $1`,
      [email],
    );
    if (rows.length !== 1) throw new Error("expected exactly one local account");
    return rows[0]!.account_type;
  });
}

/** LOCAL fixture: moves a membership's creation back, as if the person joined long ago. */
async function ageMembership(email: string, weddingId: string, minutes: number) {
  await withDb((db) =>
    db.query(
      `update public.wedding_memberships m
          set created_at = now() - make_interval(mins => $3)
         from auth.users u
        where u.id = m.user_id and u.email = $1 and m.wedding_id = $2`,
      [email, weddingId, minutes],
    ),
  );
}

async function ownerWithInvite(browser: Browser, label: string, role: "owner" | "collaborator" = "collaborator") {
  const owner = await freshPage(browser);
  await logIn(owner.page, await createAccount(`${label}-owner`, "couple"));
  const weddingId = await createWedding(owner.page, `Boda ${label}`);
  const inviteUrl = await createInvite(owner.page, role);
  await owner.context.close();
  return { weddingId, inviteUrl };
}

async function acceptFromContinue(page: Page) {
  await expect(page).toHaveURL(/\/invite\/continue$/);
  await page.getByRole("button", { name: es.inviteAccept.submit }).click();
}

const onboardingHeading = (page: Page) => page.getByRole("heading", { level: 1, name: es.accountType.title });

test.describe("invite completion without the account-type choice", () => {
  test("A: a new untyped invitee joins and enters the wedding; the normal entry still asks later", async ({ browser }) => {
    const { weddingId, inviteUrl } = await ownerWithInvite(browser, "sit-a");
    const { context, page } = await freshPage(browser);
    const email = uniqueEmail("sit-a-invitee");

    await page.goto(inviteUrl);
    await expect(page).toHaveURL(/\/login\?next=%2Finvite%2Fcontinue$/);
    await page.getByRole("link", { name: es.auth.login.createAccount }).click();
    await expect(page).toHaveURL(/\/signup\?next=%2Finvite%2Fcontinue$/);
    await fillCredentials(page, email);
    await page.getByRole("button", { name: es.auth.signup.submit }).click();
    await acceptFromContinue(page);

    // Straight into the wedding, with exactly the invited role; no type question.
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await expect(page.getByText(es.wedding.joined)).toBeVisible();
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);
    await expect(onboardingHeading(page)).toHaveCount(0);
    // Its sections too (client navigation inside the wedding).
    await page.getByRole("link", { name: es.guests.navLink }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/guests$`));
    await expect(onboardingHeading(page)).toHaveCount(0);
    // A full reload of the wedding as well.
    await page.goto(`/app/weddings/${weddingId}`);
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);

    // Nothing was inferred or written.
    expect(await accountTypeOf(email)).toBeNull();

    // Normal navigation to /app → the one-time choice.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    await expect(onboardingHeading(page)).toBeVisible();

    // Logged out and in again: the normal entry asks.
    await page.goto(`/app/weddings/${weddingId}`);
    await logOut(page);
    await logIn(page, email);
    await expect(page).toHaveURL(/\/onboarding\/account-type$/);
    expect(await accountTypeOf(email)).toBeNull();
    await context.close();
  });

  for (const type of ["planner", "couple"] as const) {
    test(`B/C: a ${type} accepts and enters the wedding, type unchanged`, async ({ browser }) => {
      const { weddingId, inviteUrl } = await ownerWithInvite(browser, `sit-${type}`);
      const email = await createAccount(`sit-${type}-invitee`, type);
      const { context, page } = await freshPage(browser);
      await logIn(page, email);
      if (type === "couple") {
        // A couple with their own wedding may still join another one as a collaborator.
        await createWedding(page, "Nuestra propia boda");
      }
      await page.goto(inviteUrl);
      await acceptFromContinue(page);
      await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
      await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);
      await expect(onboardingHeading(page)).toHaveCount(0);
      expect(await accountTypeOf(email)).toBe(type);
      await context.close();
    });
  }

  test("an owner invite keeps its role for an untyped invitee", async ({ browser }) => {
    const { weddingId, inviteUrl } = await ownerWithInvite(browser, "sit-owner", "owner");
    const email = await createAccount("sit-owner-invitee", null);
    const { context, page } = await freshPage(browser);
    await logIn(page, email);
    await page.goto(inviteUrl);
    await acceptFromContinue(page);
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.owner.label);
    expect(await accountTypeOf(email)).toBeNull();
    await context.close();
  });

  test("D: query flags never skip the choice; the exception is only the just-joined wedding", async ({ browser }) => {
    const joinedWedding = await ownerWithInvite(browser, "sit-d1");
    const otherWedding = await ownerWithInvite(browser, "sit-d2");
    const email = await createAccount("sit-d-invitee", null);
    const { context, page } = await freshPage(browser);
    await logIn(page, email);

    // Not a member: any joined/skip-style query → the choice, carrying the path.
    const forged = `/app/weddings/${otherWedding.weddingId}?joined=new&invite=true&skipOnboarding=true`;
    await page.goto(forged);
    await expect(page).toHaveURL(new RegExp(`/onboarding/account-type\\?next=${encodeURIComponent(forged).replace(/[?]/g, "\\?")}$`));

    // Joined one wedding: only that one opens; creation and the list still ask.
    await page.goto(joinedWedding.inviteUrl);
    await acceptFromContinue(page);
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${joinedWedding.weddingId}\\?joined=new$`));
    await page.goto("/app/weddings/new");
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=%2Fapp%2Fweddings%2Fnew$/);
    await page.goto(`/app/weddings/${otherWedding.weddingId}?joined=existing`);
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=/);

    // After the window, the same wedding (any flag) asks too.
    await ageMembership(email, joinedWedding.weddingId, 31);
    await page.goto(`/app/weddings/${joinedWedding.weddingId}?joined=new`);
    await expect(page).toHaveURL(/\/onboarding\/account-type\?next=/);
    await expect(onboardingHeading(page)).toBeVisible();
    expect(await accountTypeOf(email)).toBeNull();
    await context.close();
  });
});
