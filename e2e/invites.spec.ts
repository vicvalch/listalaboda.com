import { expect, test, type Browser } from "@playwright/test";

import {
  createAccount,
  createInvite,
  createWedding,
  es,
  fillCredentials,
  logIn,
  logOut,
  weddingIdFromUrl,
} from "./support/flows";
import { uniqueEmail } from "./support/identities";

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe("membership invites", () => {
  test("D+E: collaborator invite survives a logged-out sign-up and joins the same wedding", async ({
    browser,
  }) => {
    // D: owner creates a collaborator invite and gets a copyable link.
    const { context, page } = await freshPage(browser);
    await logIn(page, await createAccount("owner-d"));
    const weddingId = await createWedding(page, "Boda con colaboradora");
    const inviteUrl = await createInvite(page, "collaborator");
    // Scoped: the wedding page also shows checklist "Pendiente" labels.
    await expect(
      page
        .getByRole("region", { name: es.invites.title })
        .getByText(es.invites.status.pending, { exact: true }),
    ).toBeVisible();
    await logOut(page);

    // E: the same browser, now logged out, opens the link.
    await page.goto(inviteUrl);
    // The token leaves the URL at once (moved to an httpOnly cookie).
    await expect(page).toHaveURL(/\/login\?next=%2Finvite%2Fcontinue$/);
    await expect(page.getByText(es.auth.invitePending)).toBeVisible();
    const handoff = (await context.cookies()).find((c) => c.name === "lb_membership_invite");
    expect(handoff?.httpOnly).toBe(true);
    expect(handoff?.path).toBe("/");
    expect(handoff?.sameSite).toBe("Lax");
    // Not readable from page JavaScript.
    expect(await page.evaluate(() => document.cookie)).not.toContain("lb_membership_invite");

    // New recipient signs up from the login page; the invite is preserved.
    await page.getByRole("link", { name: es.auth.login.createAccount }).click();
    await expect(page).toHaveURL(/\/signup\?next=%2Finvite%2Fcontinue$/);
    await fillCredentials(page, uniqueEmail("recipient-e"));
    await page.getByRole("button", { name: es.auth.signup.submit }).click();

    await expect(page).toHaveURL(/\/invite\/continue$/);
    await page.getByRole("button", { name: es.inviteAccept.submit }).click();

    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));
    await expect(page.getByText(es.wedding.joined)).toBeVisible();
    await expect(page.getByTestId("wedding-role")).toHaveText(es.roles.collaborator.label);
    // Collaborators can't invite.
    await expect(page.getByRole("heading", { name: es.invites.title })).toHaveCount(0);
    await expect(page.getByText(es.invites.collaboratorNote)).toBeVisible();
    // The handoff cookie is gone.
    expect((await context.cookies()).some((c) => c.name === "lb_membership_invite")).toBe(false);

    // The link is single-use.
    await page.goto(inviteUrl);
    await page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(page.getByRole("heading", { name: es.inviteInvalid.title })).toBeVisible();

    await context.close();
  });

  test("F: an owner invite makes the recipient a co-owner (existing account, login)", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("owner-f"));
    const weddingId = await createWedding(owner.page, "Boda de dos organizadores");
    const inviteUrl = await createInvite(owner.page, "owner");

    const recipientEmail = await createAccount("partner-f");
    const recipient = await freshPage(browser);
    await recipient.page.goto(inviteUrl);
    await expect(recipient.page).toHaveURL(/\/login\?next=%2Finvite%2Fcontinue$/);
    await fillCredentials(recipient.page, recipientEmail);
    await recipient.page.getByRole("button", { name: es.auth.login.submit }).click();
    await expect(recipient.page).toHaveURL(/\/invite\/continue$/);
    await recipient.page.getByRole("button", { name: es.inviteAccept.submit }).click();

    await expect(recipient.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}`));
    await expect(recipient.page.getByTestId("wedding-role")).toHaveText(es.roles.owner.label);
    // A co-owner can invite too.
    await expect(recipient.page.getByRole("heading", { name: es.invites.title })).toBeVisible();

    // The original owner sees the invite as accepted.
    await owner.page.reload();
    await expect(owner.page.getByText(es.invites.status.accepted, { exact: true })).toBeVisible();

    await owner.context.close();
    await recipient.context.close();
  });

  test("a signed-in recipient accepts directly; a member reopening a link is told so", async ({
    browser,
  }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("owner-direct"));
    const weddingId = await createWedding(owner.page, "Boda de acceso directo");
    const inviteUrl = await createInvite(owner.page, "collaborator");

    // The owner opens their own link: already a member, nothing changes.
    await owner.page.goto(inviteUrl);
    await owner.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(owner.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=existing$`));
    await expect(owner.page.getByText(es.wedding.alreadyMember)).toBeVisible();
    await expect(owner.page.getByTestId("wedding-role")).toHaveText(es.roles.owner.label);

    // The invite is still pending and usable by someone else.
    const recipient = await freshPage(browser);
    await logIn(recipient.page, await createAccount("direct"));
    await recipient.page.goto(inviteUrl);
    await expect(recipient.page).toHaveURL(/\/invite\/continue$/);
    await recipient.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(recipient.page.getByTestId("wedding-role")).toHaveText(
      es.roles.collaborator.label,
    );

    await owner.context.close();
    await recipient.context.close();
  });

  test("an email-bound invite can't be used by a different account", async ({ browser }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("owner-bound"));
    await createWedding(owner.page, "Boda con invitación personal");
    const intended = uniqueEmail("intended");
    const inviteUrl = await createInvite(owner.page, "collaborator", intended);

    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("someone-else"));
    await other.page.goto(inviteUrl);
    await other.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(other.page.getByRole("heading", { name: es.inviteInvalid.title })).toBeVisible();
    // Nothing about whom the invite was for is revealed.
    await expect(other.page.getByText(intended)).toHaveCount(0);

    await owner.context.close();
    await other.context.close();
  });

  test("a revoked invite is invalid", async ({ browser }) => {
    const owner = await freshPage(browser);
    await logIn(owner.page, await createAccount("owner-revoke"));
    await createWedding(owner.page, "Boda con invitación cancelada");
    const inviteUrl = await createInvite(owner.page, "collaborator");
    await owner.page.getByRole("button", { name: es.invites.revoke }).click();
    await expect(owner.page.getByText(es.invites.status.revoked, { exact: true })).toBeVisible();

    const recipient = await freshPage(browser);
    await logIn(recipient.page, await createAccount("late"));
    await recipient.page.goto(inviteUrl);
    await recipient.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(
      recipient.page.getByRole("heading", { name: es.inviteInvalid.title }),
    ).toBeVisible();

    await owner.context.close();
    await recipient.context.close();
  });

  test("G: an outsider gets the same 404 for another couple's wedding as for none", async ({
    browser,
  }) => {
    const ownerB = await freshPage(browser);
    await logIn(ownerB.page, await createAccount("owner-b"));
    const weddingB = await createWedding(ownerB.page, "Boda privada B");

    const ownerA = await freshPage(browser);
    await logIn(ownerA.page, await createAccount("owner-a"));
    await createWedding(ownerA.page, "Boda A");

    const response = await ownerA.page.goto(`/app/weddings/${weddingB}`);
    expect(response?.status()).toBe(404);
    await expect(ownerA.page.getByRole("heading", { name: es.notFound.title })).toBeVisible();
    await expect(ownerA.page.getByText("Boda privada B")).toHaveCount(0);

    const missing = await ownerA.page.goto("/app/weddings/00000000-0000-4000-8000-000000000000");
    expect(missing?.status()).toBe(404);
    const malformed = await ownerA.page.goto("/app/weddings/not-a-uuid");
    expect(malformed?.status()).toBe(404);

    expect(weddingIdFromUrl(ownerA.page.url())).toBeNull();
    await ownerA.context.close();
    await ownerB.context.close();
  });

  test("H: a malformed invite link shows the generic invalid state", async ({ page }) => {
    await page.goto("/invite/not-a-real-token");
    await expect(page).toHaveURL(/\/invite\/continue$/);
    await expect(page.getByRole("heading", { name: es.inviteInvalid.title })).toBeVisible();
    await expect(page.getByText("not-a-real-token")).toHaveCount(0);
    await expect(page.getByRole("link", { name: es.common.login })).toBeVisible();
  });

  test("H: a well-formed but unknown token is equally invalid", async ({ page }) => {
    await logIn(page, await createAccount("unknown-token"));
    await page.goto(`/invite/${"A".repeat(43)}`);
    await page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(page.getByRole("heading", { name: es.inviteInvalid.title })).toBeVisible();
    await expect(page.getByRole("link", { name: es.common.goToMyWeddings })).toBeVisible();
  });
});
