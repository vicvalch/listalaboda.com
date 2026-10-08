import { createHash, randomBytes } from "node:crypto";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { boardScale, droppedTablePosition, tableFootprint } from "../src/lib/seating/planner";
import type { Database } from "../src/lib/supabase/database.types";
import { createAccount, createWedding, es, formAlert, logIn } from "./support/flows";
import { E2E_PASSWORD } from "./support/identities";
import { readLocalSupabase } from "./support/local-supabase";

// LB-20 (ADR-013): the visual seating planner (`?view=plan`), a progressive
// enhancement over the LB-19 list: guest drops reuse seat/move/unseat, a
// table drag writes its position once, on drop. Desktop only; narrow screens
// keep the list. Names are fake fixtures; guest links are bearer credentials
// and are never printed. No email is sent anywhere here.

const seating = es.seating;
const planner = seating.planner;
const guests = es.guests;
const rsvp = es.rsvp;
const GUEST_LINK = /^http:\/\/localhost:\d+\/rsvp\/[A-Za-z0-9_-]{43}$/;

// ------------------------------------------------------------------ helpers

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function createParty(page: Page, label: string, names: string[]): Promise<string> {
  // A fresh form each time: no remount of the previous submission can race the typing.
  await page.reload();
  const section = page.getByRole("region", { name: guests.newParty.title });
  await section.getByLabel(guests.newParty.labelLabel).fill(label);
  await section.getByLabel(guests.newParty.namesLabel).fill(names.join("\n"));
  await section.getByRole("button", { name: guests.newParty.submit }).click();
  // The previous party's link may still be on screen: wait for THIS party first.
  await expect(
    page.getByTestId("guest-party").filter({ has: page.getByRole("heading", { level: 3, name: label, exact: true }) }),
  ).toBeVisible();
  const field = section.getByTestId("guest-link");
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(GUEST_LINK.test(url), "guest link has the expected shape (value redacted)").toBe(true);
  return url;
}

async function answerAs(browser: Browser, link: string, answers: Readonly<Record<string, boolean>>) {
  const guest = await freshPage(browser);
  try {
    await guest.page.goto(link);
    for (const [name, attending] of Object.entries(answers)) {
      await guest.page
        .getByRole("group", { name, exact: true })
        .getByRole("radio", { name: attending ? rsvp.yes : rsvp.no })
        .check();
    }
    await guest.page.getByRole("button", { name: rsvp.submit }).click();
    await expect(guest.page.getByText(rsvp.saved)).toBeVisible();
  } finally {
    await guest.context.close();
  }
}

function seatingPath(weddingId: string, view?: "plan") {
  return `/app/weddings/${weddingId}/seating${view ? "?view=plan" : ""}`;
}

async function createListTable(page: Page, name: string, capacity: number) {
  const section = page.getByRole("region", { name: seating.newTable.title });
  await section.getByLabel(seating.newTable.nameLabel).fill(name);
  await section.getByLabel(seating.newTable.capacityLabel).fill(String(capacity));
  await section.getByRole("button", { name: seating.newTable.submit }).click();
  await expect(section.getByRole("status")).toHaveText(seating.newTable.created);
  await expect(listTable(page, name)).toHaveCount(1);
}

function listTable(page: Page, name: string): Locator {
  return page
    .getByTestId("seating-table")
    .filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });
}

function board(page: Page): Locator {
  return page.getByTestId("planner-board");
}

function node(page: Page, tableName: string): Locator {
  return page.locator(`[data-testid="planner-table"][data-table-name="${tableName}"]`);
}

function pill(scope: Page | Locator, guestName: string): Locator {
  return scope.locator(`[data-testid="planner-guest"][data-guest-name="${guestName}"]`);
}

/** Puts an element in the middle of the viewport, away from the edges where dragging auto-scrolls. */
async function centerOn(locator: Locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

function rail(page: Page): Locator {
  return page.getByTestId("planner-rail");
}

function message(page: Page): Locator {
  return page.getByTestId("planner-message");
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real pointer drag: press, pass the activation distance, glide, release. */
async function pointerDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, beforeRelease?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  if (beforeRelease) await beforeRelease();
  await page.mouse.up();
}

async function dragGuest(page: Page, guestName: string, target: Locator) {
  // The rail and the board start at the same height: show both from the top.
  await rail(page).evaluate((element) => element.scrollIntoView({ block: "start" }));
  const source = pill(page, guestName).first();
  await pointerDrag(page, await center(source), await center(target));
}

/** Counts the Server Action POSTs the page sends (Next marks them with a `next-action` header). */
function countActions(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) count += 1;
  });
  return () => count;
}

async function position(locator: Locator) {
  return {
    x: Number(await locator.getAttribute("data-x")),
    y: Number(await locator.getAttribute("data-y")),
  };
}

async function dbTable(weddingId: string, name: string) {
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ capacity: number; shape: string; layout_x: number | null; layout_y: number | null }>(
      "select capacity, shape::text as shape, layout_x, layout_y from public.seating_tables where wedding_id = $1 and name = $2",
      [weddingId, name],
    );
    return rows[0];
  } finally {
    await db.end();
  }
}

async function expectSummary(
  page: Page,
  values: Readonly<{ confirmed: number; seated: number; unseated: number; capacity: number }>,
) {
  for (const [key, value] of Object.entries(values)) {
    await expect(page.getByTestId(`seating-summary-${key}`).locator("dd")).toHaveText(String(value));
  }
}

async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
}

// ---------------------------------------------------------------- desktop

test.describe("visual seating planner (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("drag guests between the rail and tables, move and reshape a table, refuse a full table", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await logIn(page, await createAccount("lb20-owner"));
    const weddingId = await createWedding(page, "Boda de prueba Plano", "2090-06-01");

    await page.goto(`/app/weddings/${weddingId}/guests`);
    const perez = await createParty(page, "Familia Pérez", ["Ana Pérez", "Carlos Pérez", "Lucía Pérez"]);
    await createParty(page, "Familia Gómez", ["Marta Gómez", "Pablo Gómez"]);
    await createParty(page, "Amigos", ["Sofía Ruiz"]);
    await answerAs(browser, perez, { "Ana Pérez": true, "Carlos Pérez": true, "Lucía Pérez": false });

    await page.goto(seatingPath(weddingId));
    await createListTable(page, "Mesa 1", 2);
    await createListTable(page, "Mesa 2", 4);
    await createListTable(page, "Mesa 3", 2);

    // List stays the default; "Plano" opens the planner on the same route.
    const toggle = page.getByRole("navigation", { name: seating.view.label });
    await expect(toggle.getByRole("link", { name: seating.view.list })).toHaveAttribute("aria-current", "page");
    await toggle.getByRole("link", { name: seating.view.plan }).click();
    await expect(page).toHaveURL(new RegExp(`/seating\\?view=plan$`));
    await expect(rail(page)).toBeVisible();
    await expect(board(page)).toBeVisible();
    await expect(page.getByTestId("planner-inspector")).toBeVisible();
    await expect(node(page, "Mesa 1")).toHaveAttribute("data-placed", "derived");
    // A declined guest who isn't seated can't be dragged anywhere.
    await rail(page).locator("summary", { hasText: planner.rail.declined }).click();
    await expect(pill(rail(page), "Lucía Pérez")).not.toHaveAttribute("aria-roledescription", /.+/);

    // Rail → table (attending): seatGuestAction.
    await dragGuest(page, "Ana Pérez", node(page, "Mesa 1"));
    await expect(pill(node(page, "Mesa 1"), "Ana Pérez")).toBeVisible();
    await expect(message(page)).toHaveText("Ana Pérez ahora está en Mesa 1.");
    await expect(node(page, "Mesa 1").getByTestId("planner-table-occupancy")).toHaveText("1 / 2");

    // Rail → table (pending): seatable too.
    await dragGuest(page, "Marta Gómez", node(page, "Mesa 2"));
    await expect(pill(node(page, "Mesa 2"), "Marta Gómez")).toBeVisible();
    await expect(pill(node(page, "Mesa 2"), "Marta Gómez")).toHaveAttribute(
      "aria-label",
      "Marta Gómez — Mesa 2, sin responder",
    );

    // Table A → table B: moveGuestAction.
    await dragGuest(page, "Ana Pérez", node(page, "Mesa 2"));
    await expect(pill(node(page, "Mesa 2"), "Ana Pérez")).toBeVisible();
    await expect(pill(node(page, "Mesa 1"), "Ana Pérez")).toHaveCount(0);
    await expect(node(page, "Mesa 2").getByTestId("planner-table-occupancy")).toHaveText("2 / 4");
    await expect(node(page, "Mesa 1").getByTestId("planner-table-occupancy")).toHaveText("0 / 2");

    // Table → rail: unseatGuestAction.
    await dragGuest(page, "Ana Pérez", rail(page));
    await expect(pill(rail(page), "Ana Pérez")).toBeVisible();
    await expect(message(page)).toHaveText("Ana Pérez ya no tiene mesa.");
    await page.reload();
    await expect(pill(rail(page), "Ana Pérez")).toBeVisible();
    await expect(pill(node(page, "Mesa 2"), "Marta Gómez")).toBeVisible();

    // Move Mesa 3 by its handle: nothing is written while dragging, exactly once on drop.
    const actions = countActions(page);
    const mesa3 = node(page, "Mesa 3");
    await centerOn(mesa3);
    const start = await position(mesa3);
    const boardWidth = (await board(page).boundingBox())!.width;
    const handle = mesa3.getByTestId("planner-table-handle");
    await expect(handle).toHaveAttribute("aria-label", "Mover Mesa 3");
    const from = await center(handle);
    const delta = { x: 157, y: 131 };
    await pointerDrag(page, from, { x: from.x + delta.x, y: from.y + delta.y }, async () => {
      await page.waitForTimeout(300);
      expect(actions(), "no write while the table is being dragged").toBe(0);
    });
    await expect(message(page)).toHaveText("Mesa 3 movida.");
    expect(actions(), "one write per completed table drag").toBe(1);
    const expected = droppedTablePosition(start, delta, boardScale(boardWidth), tableFootprint("round", 2));
    expect(expected).not.toEqual(start);
    await expect(mesa3).toHaveAttribute("data-x", String(expected.x));
    await expect(mesa3).toHaveAttribute("data-y", String(expected.y));

    await page.reload();
    await expect(node(page, "Mesa 3")).toHaveAttribute("data-placed", "stored");
    expect(await position(node(page, "Mesa 3"))).toEqual(expected);
    expect(await dbTable(weddingId, "Mesa 3")).toEqual({
      capacity: 2,
      shape: "round",
      layout_x: expected.x,
      layout_y: expected.y,
    });
    // The other tables were never written just because the planner opened.
    expect(await dbTable(weddingId, "Mesa 1")).toMatchObject({ layout_x: null, layout_y: null });

    // Select Mesa 3 and make it rectangular in the inspector: shape only.
    await node(page, "Mesa 3").getByRole("button", { name: "Mesa 3", exact: true }).click();
    const inspector = page.getByTestId("planner-inspector");
    await expect(inspector.getByTestId("planner-inspector-table")).toBeVisible();
    await inspector.getByLabel(seating.newTable.shapeLabel).selectOption({ label: seating.shapes.rectangle });
    await inspector.getByRole("button", { name: seating.editTable.submit }).click();
    await expect(node(page, "Mesa 3")).toHaveAttribute("data-shape", "rectangle");
    await page.reload();
    await expect(node(page, "Mesa 3")).toHaveAttribute("data-shape", "rectangle");
    expect(await dbTable(weddingId, "Mesa 3")).toEqual({
      capacity: 2,
      shape: "rectangle",
      layout_x: expected.x,
      layout_y: expected.y,
    });

    // Fill Mesa 1, then a known-full drop is refused before any request.
    await dragGuest(page, "Ana Pérez", node(page, "Mesa 1"));
    await expect(pill(node(page, "Mesa 1"), "Ana Pérez")).toBeVisible();
    await dragGuest(page, "Carlos Pérez", node(page, "Mesa 1"));
    await expect(pill(node(page, "Mesa 1"), "Carlos Pérez")).toBeVisible();
    await expect(node(page, "Mesa 1").getByTestId("planner-table-full")).toHaveText(planner.full);
    await expect(page.getByRole("group", { name: "Mesa 1: 2 de 2 lugares, llena" })).toBeVisible();
    // The full table's handle, name and guests stay operable (no inherited aria-disabled).
    await expect(node(page, "Mesa 1").getByRole("button", { name: "Mesa 1", exact: true })).toBeEnabled();
    const beforeRefusal = actions();
    await dragGuest(page, "Pablo Gómez", node(page, "Mesa 1"));
    await expect(message(page)).toContainText(planner.tableFull);
    await expect(message(page)).toContainText("No se pudo asignar a Pablo Gómez porque Mesa 1 está llena.");
    await expect(pill(rail(page), "Pablo Gómez")).toBeVisible();
    await expect(node(page, "Mesa 1").getByTestId("planner-table-occupancy")).toHaveText("2 / 2");
    expect(actions(), "a known-full drop sends nothing").toBe(beforeRefusal);

    // A table that filled up in another tab: the database refuses, the
    // optimistic drop rolls back and the fresh data shows why.
    const other = await page.context().newPage();
    await other.goto(seatingPath(weddingId));
    await other.getByLabel("Mover a Marta Gómez a", { exact: true }).selectOption({ label: "Mesa 3" });
    await other.getByRole("button", { name: "Mover a Marta Gómez", exact: true }).click();
    await expect(listTable(other, "Mesa 3").getByTestId("seating-table-occupancy")).toHaveText("1 / 2");
    await other.getByLabel("Mesa para Pablo Gómez", { exact: true }).selectOption({ label: "Mesa 3" });
    await other.getByRole("button", { name: "Asignar a Pablo Gómez", exact: true }).click();
    await expect(listTable(other, "Mesa 3").getByTestId("seating-table-occupancy")).toHaveText("2 / 2");
    await other.close();

    // This page still believes Mesa 3 is empty.
    await expect(node(page, "Mesa 3").getByTestId("planner-table-occupancy")).toHaveText("0 / 2");
    await dragGuest(page, "Sofía Ruiz", node(page, "Mesa 3"));
    await expect(message(page)).toContainText(planner.tableFull);
    await expect(pill(rail(page), "Sofía Ruiz")).toBeVisible();
    await expect(pill(node(page, "Mesa 3"), "Sofía Ruiz")).toHaveCount(0);
    await expect(node(page, "Mesa 3").getByTestId("planner-table-occupancy")).toHaveText("2 / 2");

    // The summary agrees with the plan.
    await page.reload();
    await expectSummary(page, { confirmed: 2, seated: 4, unseated: 0, capacity: 8 });
    await expect(formAlert(page)).toHaveCount(0);
  });

  test("keyboard: move a table one grid step, and seat a guest through the inspector", async ({ page }) => {
    await logIn(page, await createAccount("lb20-keyboard"));
    const weddingId = await createWedding(page, "Boda teclado Plano", "2090-06-01");
    await page.goto(`/app/weddings/${weddingId}/guests`);
    await createParty(page, "Familia Núñez", ["Nora Núñez"]);
    await page.goto(seatingPath(weddingId));
    await createListTable(page, "Mesa K", 4);

    await page.goto(seatingPath(weddingId, "plan"));
    const mesa = node(page, "Mesa K");
    const before = await position(mesa);
    const handle = mesa.getByRole("button", { name: "Mover Mesa K" });
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await expect(message(page)).toHaveText("Moviendo Mesa K.");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(message(page)).toHaveText("Mesa K movida.");

    await page.reload();
    await expect(node(page, "Mesa K")).toHaveAttribute("data-placed", "stored");
    expect(await position(node(page, "Mesa K"))).toEqual({ x: before.x + 20, y: before.y });
    expect(await dbTable(weddingId, "Mesa K")).toMatchObject({ layout_x: before.x + 20, layout_y: before.y });

    // No pointer drag needed: select the guest with the keyboard, then use the form.
    const nora = pill(rail(page), "Nora Núñez");
    await expect(nora).toHaveAttribute("aria-label", "Nora Núñez — sin mesa, sin responder");
    await nora.focus();
    await page.keyboard.press("Enter");
    const inspector = page.getByTestId("planner-inspector-guest");
    await expect(inspector.getByRole("heading", { name: "Nora Núñez" })).toBeVisible();
    await inspector.getByLabel("Mesa para Nora Núñez", { exact: true }).selectOption({ label: "Mesa K" });
    await inspector.getByRole("button", { name: "Asignar a Nora Núñez", exact: true }).click();
    await expect(pill(node(page, "Mesa K"), "Nora Núñez")).toBeVisible();
    await expect(inspector.getByText("Mesa actual: Mesa K")).toBeVisible();
  });

  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1920, height: 1080 },
  ]) {
    test(`the planner page has no horizontal overflow at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await logIn(page, await createAccount(`lb20-width-${viewport.width}`));
      const weddingId = await createWedding(page, "Boda ancho Plano");
      await page.goto(seatingPath(weddingId));
      await createListTable(page, "Mesa ancha", 50);
      await page.goto(seatingPath(weddingId, "plan"));
      await expect(board(page)).toBeVisible();
      await noHorizontalOverflow(page);
      // The workspace is wider than the shell's content column, and stays inside the viewport.
      const workspace = (await page.getByTestId("planner-workspace").boundingBox())!;
      expect(workspace.x).toBeGreaterThanOrEqual(0);
      expect(workspace.x + workspace.width).toBeLessThanOrEqual(viewport.width);
    });
  }
});

// ------------------------------------------------------------------ mobile

test.describe("visual seating planner (narrow screens)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the list keeps every operation; ?view=plan shows a notice, never the board", async ({ page }) => {
    await logIn(page, await createAccount("lb20-mobile"));
    const weddingId = await createWedding(page, "Boda móvil Plano");
    await page.goto(`/app/weddings/${weddingId}/guests`);
    await createParty(page, "Familia Ríos", ["Iván Ríos", "Eva Ríos"]);

    await page.goto(seatingPath(weddingId));
    await expect(page.getByRole("link", { name: seating.view.plan })).toHaveCount(0);
    await createListTable(page, "Mesa A", 2);
    await createListTable(page, "Mesa B", 2);

    await page.getByLabel("Mesa para Iván Ríos", { exact: true }).selectOption({ label: "Mesa A" });
    await page.getByRole("button", { name: "Asignar a Iván Ríos", exact: true }).click();
    await expect(listTable(page, "Mesa A").getByTestId("seating-table-occupancy")).toHaveText("1 / 2");
    await page.getByLabel("Mover a Iván Ríos a", { exact: true }).selectOption({ label: "Mesa B" });
    await page.getByRole("button", { name: "Mover a Iván Ríos", exact: true }).click();
    await expect(listTable(page, "Mesa B").getByTestId("seating-table-occupancy")).toHaveText("1 / 2");
    await page.getByRole("button", { name: "Quitar de mesa a Iván Ríos", exact: true }).click();
    await expect(listTable(page, "Mesa B").getByTestId("seating-table-occupancy")).toHaveText("0 / 2");
    await noHorizontalOverflow(page);

    await page.goto(seatingPath(weddingId, "plan"));
    const notice = page.getByTestId("planner-unavailable");
    await expect(notice).toContainText(planner.unavailable);
    await expect(board(page)).toHaveCount(0);
    await expect(rail(page)).toHaveCount(0);
    await expect(page.getByTestId("planner-table")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await notice.getByRole("link", { name: planner.backToList }).click();
    await expect(page).toHaveURL(new RegExp(`/app/weddings/${weddingId}/seating$`));
    await expect(listTable(page, "Mesa A")).toBeVisible();
  });
});

// ------------------------------------------------------------- performance

test.describe("visual seating planner (50 tables, 250 guests)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("stays responsive and writes once per completed drag", async ({ page }) => {
    test.setTimeout(240_000);
    const email = await createAccount("lb20-perf");
    await logIn(page, email);
    const weddingId = await createWedding(page, "Boda grande Plano");

    // Fixtures through the member's own RLS-bound client (no privileged path).
    const { apiUrl, publishableKey } = readLocalSupabase();
    const member = createClient<Database>(apiUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await member.auth.signInWithPassword({ email, password: E2E_PASSWORD });
    expect(signInError).toBeNull();
    const { data: tables, error: tableError } = await member
      .from("seating_tables")
      .insert(
        Array.from({ length: 50 }, (_, i) => ({
          wedding_id: weddingId,
          name: `Mesa ${i + 1}`,
          capacity: 8,
          shape: i % 3 === 0 ? ("rectangle" as const) : ("round" as const),
        })),
      )
      .select("id, name");
    expect(tableError).toBeNull();
    const guestIds: string[] = [];
    for (let p = 0; p < 50; p += 1) {
      const part = (n: number) => randomBytes(n).toString("base64url");
      const { data: partyId, error } = await member.rpc("create_guest_invitation", {
        target_wedding_id: weddingId,
        party_label: `Grupo ${p + 1}`,
        invitation_token_hash: createHash("sha256").update(part(32)).digest("hex"),
        invitation_token_ciphertext: `v1.${part(12)}.${part(43)}.${part(16)}`,
        guest_names: Array.from({ length: 5 }, (_, g) => `Persona ${p + 1}-${g + 1}`),
      });
      expect(error).toBeNull();
      const { data: rows } = await member.from("guests").select("id").eq("guest_invitation_id", partyId!).order("created_at");
      guestIds.push(...(rows ?? []).map((r) => r.id));
    }
    expect(guestIds).toHaveLength(250);
    // 3 people at each table (150 seated, 100 in the rail).
    const { error: seatError } = await member.from("seating_assignments").insert(
      guestIds.slice(0, 150).map((guestId, i) => ({
        guest_id: guestId,
        wedding_id: weddingId,
        seating_table_id: tables![Math.floor(i / 3)]!.id,
      })),
    );
    expect(seatError).toBeNull();

    const opened = Date.now();
    await page.goto(seatingPath(weddingId, "plan"));
    await expect(page.getByTestId("planner-table")).toHaveCount(50);
    await expect(rail(page).getByTestId("planner-guest")).toHaveCount(100);
    test.info().annotations.push({ type: "planner-open-ms", description: String(Date.now() - opened) });

    // A table drag across the board.
    const actions = countActions(page);
    await centerOn(node(page, "Mesa 1"));
    const handle = node(page, "Mesa 1").getByTestId("planner-table-handle");
    const from = await center(handle);
    const dragStarted = Date.now();
    await pointerDrag(page, from, { x: from.x + 300, y: from.y + 150 }, async () => {
      expect(actions(), "no write while dragging").toBe(0);
    });
    await expect(message(page)).toHaveText("Mesa 1 movida.");
    test.info().annotations.push({ type: "table-drag-ms", description: String(Date.now() - dragStarted) });
    expect(actions()).toBe(1);

    // A guest drag from the top of the rail into a table.
    await page.evaluate(() => window.scrollTo(0, 0));
    const target = node(page, "Mesa 5");
    const guestStarted = Date.now();
    await dragGuest(page, "Persona 31-1", target);
    // Four people now: the node lists three names and "+1"; the rail lost one.
    await expect(target.getByTestId("planner-table-occupancy")).toHaveText("4 / 8");
    await expect(rail(page).getByTestId("planner-guest")).toHaveCount(99);
    test.info().annotations.push({ type: "guest-drag-ms", description: String(Date.now() - guestStarted) });
    expect(actions()).toBe(2);
    expect(Date.now() - dragStarted, "two drags complete well within the budget").toBeLessThan(15_000);
  });
});
