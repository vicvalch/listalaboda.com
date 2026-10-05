import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import {
  addChecklistItem,
  checklistItem,
  createAccount,
  createInvite,
  createWedding,
  es,
  logIn,
} from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// LB-16 (ADR-009): a checklist item may be about one guest party of its own
// wedding. Navigation both ways, change, unlink, party deletion, tenant
// isolation, permissions and status independence. Names are fake fixtures.

const gw = es.checklist.guestWork;
const guests = es.guests;

const TRANSPORT = "Confirmar el transporte de invitados";
const HOTEL = "Reservar hotel para invitados";

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function openGuests(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/guests`);
  await expect(page.getByRole("heading", { level: 1, name: guests.title })).toBeVisible();
}

async function openChecklist(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}`);
  await expect(page.getByRole("heading", { level: 2, name: es.checklist.title })).toBeVisible();
}

function party(page: Page, label: string): Locator {
  return page
    .getByTestId("guest-party")
    .filter({ has: page.getByRole("heading", { level: 3, name: label, exact: true }) });
}

async function createParty(page: Page, label: string, names: string[]) {
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  await expect(party(page, label)).toBeVisible();
}

function relation(page: Page, title: string): Locator {
  return checklistItem(page, title).getByTestId("checklist-item-guest-work");
}

function related(page: Page, label: string): Locator {
  return party(page, label).getByTestId("party-related-items");
}

/** Opens "Vincular con invitados" / "Cambiar vínculo", picks the party and saves. */
async function linkTo(page: Page, title: string, label: string) {
  const row = checklistItem(page, title);
  const select = row.getByLabel(gw.selectLabel);
  if (!(await select.isVisible())) {
    await row.locator("summary").filter({ hasText: new RegExp(`^(${gw.open}|${gw.change})$`) }).click();
  }
  await select.selectOption({ label });
  await row.getByRole("button", { name: gw.submit }).click();
  await expect(row.getByRole("status").filter({ hasText: gw.saved })).toBeVisible();
  await expect(relation(page, title)).toHaveText(`${gw.label}: ${label} · ${gw.viewParty}`);
}

async function unlink(page: Page, title: string) {
  const row = checklistItem(page, title);
  if (!(await row.getByRole("button", { name: gw.remove }).isVisible())) {
    await row.locator("summary").filter({ hasText: new RegExp(`^${gw.change}$`) }).click();
  }
  await row.getByRole("button", { name: gw.remove }).click();
  await expect(relation(page, title)).toHaveCount(0);
}

async function db<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function itemRow(weddingId: string, title: string) {
  return db(async (client) => {
    const { rows } = await client.query<{
      id: string;
      status: string;
      guest_invitation_id: string | null;
      description: string | null;
    }>(
      "select id, status, guest_invitation_id, description from public.checklist_items where wedding_id = $1 and title = $2",
      [weddingId, title],
    );
    return rows;
  });
}

async function partyId(weddingId: string, label: string): Promise<string> {
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "select id from public.guest_invitations where wedding_id = $1 and label = $2",
      [weddingId, label],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("party missing");
    return id;
  });
}

/** One wedding with two parties and two custom items, set up through the real UI. */
async function setUp(page: Page, label: string) {
  await logIn(page, await createAccount(label));
  const weddingId = await createWedding(page, `Boda ${label}`, "2090-06-01");
  await addChecklistItem(page, { title: TRANSPORT, category: "invitations" });
  await addChecklistItem(page, { title: HOTEL });
  await openGuests(page, weddingId);
  await createParty(page, "Familia Pérez", ["Ana Pérez", "Carlos Pérez"]);
  await createParty(page, "Familia Gómez", ["Lucía Gómez"]);
  await openChecklist(page, weddingId);
  return weddingId;
}

test.describe("checklist ↔ guest work", () => {
  test("A/B: link from the checklist, go to the party, and come back to the item", async ({ page }) => {
    const weddingId = await setUp(page, "lb16-nav");

    // Unlinked items are ordinary: no relation line, no warning.
    await expect(relation(page, TRANSPORT)).toHaveCount(0);
    await expect(checklistItem(page, TRANSPORT).locator("summary", { hasText: gw.open })).toBeVisible();

    await linkTo(page, TRANSPORT, "Familia Pérez");
    await page.reload();
    await expect(relation(page, TRANSPORT)).toHaveText(`${gw.label}: Familia Pérez · ${gw.viewParty}`);
    await expect(relation(page, HOTEL)).toHaveCount(0);

    // Checklist → party: a derived route with an anchor, no token, no query string.
    const perez = await partyId(weddingId, "Familia Pérez");
    const viewParty = relation(page, TRANSPORT).getByRole("link", { name: `${gw.viewParty}: Familia Pérez` });
    await expect(viewParty).toHaveAttribute("href", `/app/weddings/${weddingId}/guests#party-${perez}`);
    await viewParty.click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/guests#party-${perez}$`));
    const card = page.locator(`#party-${perez}`);
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("Familia Pérez");
    await expect(card).toBeInViewport();

    // Party → item: only that party shows it, with the item's current status.
    await expect(related(page, "Familia Pérez").getByRole("listitem")).toHaveText([
      `${TRANSPORT} · ${es.checklist.status.pending}`,
    ]);
    await expect(related(page, "Familia Gómez")).toHaveCount(0);
    const [item] = await itemRow(weddingId, TRANSPORT);
    await related(page, "Familia Pérez").getByRole("link", { name: TRANSPORT }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}#item-${item?.id}$`));
    const row = page.locator(`#item-${item?.id}`);
    await expect(row.locator("p[id$='-title']")).toHaveText(TRANSPORT);
    await expect(row).toBeInViewport();

    // Nothing capability-like on the checklist: no RSVP link, no token.
    expect(await page.content()).not.toMatch(/\/rsvp\//);
  });

  test("C/D/H: change the party, then unlink; status and content never move", async ({ page }) => {
    const weddingId = await setUp(page, "lb16-change");
    const row = checklistItem(page, TRANSPORT);

    // H: a done item stays done through link, change and unlink.
    await row.getByRole("checkbox", { name: TRANSPORT }).click();
    await expect(row).toHaveAttribute("data-status", "done");
    const [before] = await itemRow(weddingId, TRANSPORT);

    await linkTo(page, TRANSPORT, "Familia Pérez");
    await expect(row).toHaveAttribute("data-status", "done");
    await linkTo(page, TRANSPORT, "Familia Gómez");
    await expect(row).toHaveAttribute("data-status", "done");

    // C: exactly one party shows it now.
    const gomez = await partyId(weddingId, "Familia Gómez");
    await expect(relation(page, TRANSPORT).getByRole("link")).toHaveAttribute(
      "href",
      `/app/weddings/${weddingId}/guests#party-${gomez}`,
    );
    const rows = await itemRow(weddingId, TRANSPORT);
    expect(rows).toEqual([{ ...before, guest_invitation_id: gomez }]);
    await openGuests(page, weddingId);
    await expect(related(page, "Familia Pérez")).toHaveCount(0);
    await expect(related(page, "Familia Gómez").getByRole("listitem")).toHaveText([
      `${TRANSPORT} · ${es.checklist.status.done}`,
    ]);

    // A pending item linked to the same party stays pending.
    await openChecklist(page, weddingId);
    await linkTo(page, HOTEL, "Familia Gómez");
    await expect(checklistItem(page, HOTEL)).toHaveAttribute("data-status", "pending");

    // D: unlink — the item, its status and the party all remain.
    await unlink(page, TRANSPORT);
    await expect(row).toHaveAttribute("data-status", "done");
    expect(await itemRow(weddingId, TRANSPORT)).toEqual([{ ...before, guest_invitation_id: null }]);
    await page.reload();
    await expect(relation(page, TRANSPORT)).toHaveCount(0);
    await expect(row.locator("summary", { hasText: gw.open })).toBeVisible();

    await openGuests(page, weddingId);
    await expect(party(page, "Familia Gómez")).toBeVisible();
    await expect(related(page, "Familia Gómez").getByRole("listitem")).toHaveText([
      `${HOTEL} · ${es.checklist.status.pending}`,
    ]);
    await expect(related(page, "Familia Pérez")).toHaveCount(0);
  });

  test("E: deleting the party keeps the item and shows it unlinked (no broken link)", async ({ page }) => {
    const weddingId = await setUp(page, "lb16-delete");
    await linkTo(page, TRANSPORT, "Familia Pérez");
    const row = checklistItem(page, TRANSPORT);
    await row.getByRole("checkbox", { name: TRANSPORT }).click();
    await expect(row).toHaveAttribute("data-status", "done");

    await openGuests(page, weddingId);
    const card = party(page, "Familia Pérez");
    await card.getByRole("button", { name: guests.deleteParty.open }).click();
    await expect(card.getByText(guests.deleteParty.confirmBody)).toBeVisible();
    await card.getByRole("button", { name: guests.deleteParty.confirmButton }).click();
    await expect(page.getByText(guests.deleteParty.done)).toBeVisible();

    await openChecklist(page, weddingId);
    await expect(row).toHaveAttribute("data-status", "done");
    await expect(relation(page, TRANSPORT)).toHaveCount(0);
    await expect(row.getByRole("link", { name: new RegExp(gw.viewParty) })).toHaveCount(0);
    const [item] = await itemRow(weddingId, TRANSPORT);
    expect(item).toMatchObject({ status: "done", guest_invitation_id: null });
    // The remaining party is still offered; the deleted one isn't.
    await row.locator("summary", { hasText: gw.open }).click();
    await expect(row.getByLabel(gw.selectLabel).locator("option")).toHaveText([gw.choose, "Familia Gómez"]);
  });

  test("F: a forged party of another wedding is refused and reveals nothing", async ({ page, browser }) => {
    // Wedding B, with its own party, belongs to someone else.
    const other = await freshPage(browser);
    await logIn(other.page, await createAccount("lb16-other"));
    const weddingB = await createWedding(other.page, "Boda ajena lb16", "2090-07-01");
    await openGuests(other.page, weddingB);
    await createParty(other.page, "Familia Secreta", ["Persona Secreta"]);
    const foreign = await partyId(weddingB, "Familia Secreta");
    await other.context.close();

    const weddingA = await setUp(page, "lb16-forge");
    const row = checklistItem(page, TRANSPORT);
    await row.locator("summary", { hasText: gw.open }).click();
    // Tamper with the real form: inject wedding B's party id as an option.
    await row.getByLabel(gw.selectLabel).evaluate((select, id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = "forjado";
      select.appendChild(option);
      (select as HTMLSelectElement).value = id;
    }, foreign);
    await row.getByRole("button", { name: gw.submit }).click();
    await expect(row.getByRole("alert")).toHaveText(gw.invalidParty);
    await expect(page.getByText("Familia Secreta")).toHaveCount(0);
    expect(await itemRow(weddingA, TRANSPORT)).toMatchObject([{ guest_invitation_id: null }]);

    // And wedding B stays a 404 for this member.
    const denied = await page.goto(`/app/weddings/${weddingB}/guests`);
    expect(denied?.status()).toBe(404);
  });

  test("G: a collaborator links and unlinks like any checklist edit; an outsider can't reach it", async ({
    page,
    browser,
  }) => {
    const weddingId = await setUp(page, "lb16-owner");
    const inviteUrl = await createInvite(page, "collaborator");

    const collab = await freshPage(browser);
    await logIn(collab.page, await createAccount("lb16-collab"));
    await collab.page.goto(inviteUrl);
    await collab.page.getByRole("button", { name: es.inviteAccept.submit }).click();
    await expect(collab.page).toHaveURL(new RegExp(`/app/weddings/${weddingId}\\?joined=new$`));

    await linkTo(collab.page, HOTEL, "Familia Gómez");
    await openChecklist(page, weddingId);
    await expect(relation(page, HOTEL)).toHaveText(`${gw.label}: Familia Gómez · ${gw.viewParty}`);
    await unlink(collab.page, HOTEL);
    expect(await itemRow(weddingId, HOTEL)).toMatchObject([{ guest_invitation_id: null, status: "pending" }]);

    const outsider = await freshPage(browser);
    await logIn(outsider.page, await createAccount("lb16-outsider"));
    const denied = await outsider.page.goto(`/app/weddings/${weddingId}`);
    expect(denied?.status()).toBe(404);
    await expect(outsider.page.getByText(TRANSPORT)).toHaveCount(0);
    await expect(outsider.page.getByText("Familia Gómez")).toHaveCount(0);
  });
});
