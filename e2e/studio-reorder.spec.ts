import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

const frame = (page: Page) => page.frameLocator('[data-testid="studio-canvas"]');
const order = (page: Page) => frame(page).locator("[data-reorder-block]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-reorder-block")));
async function fixture(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await logIn(page, await createAccount("studio-reorder", "couple"));
  const wedding = await createWedding(page, "Boda orden atómico");
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    // Synthetic records test composition and membership; byte delivery has its own photo suite.
    for (const title of ["Primero", "Segundo", "Tercero"]) {
      const result = await db.query<{ id: string }>("insert into public.wedding_site_photo_blocks(wedding_id,kind,variant,title,body,is_visible) values ($1,'photo_text','image_start',$2,'Texto guardado',true) returning id", [wedding, title]);
      const id = result.rows[0]!.id;
      ids.push(id);
      await db.query("insert into public.wedding_photos(wedding_id,block_id,state,width,height,bytes,alt_text) values ($1,$2,'ready',1600,100,100,$3)", [wedding, id, title]);
    }
    await db.query("insert into public.wedding_publications(wedding_id,slug,published_at) values ($1,$2,now())", [wedding, `orden-${wedding}`]);
  } finally { await db.end(); }
  await page.goto(`/app/weddings/${wedding}/site/studio`);
  await expect(frame(page).locator("[data-reorder-block]")).toHaveCount(3);
  return { wedding, ids };
}
async function drag(page: Page, source: Locator, target: Locator, cancel = false) {
  await source.scrollIntoViewIfNeeded();
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error("drag element missing");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 75), { steps: 12 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
function block(page: Page, id: string) { return frame(page).locator(`[data-reorder-block="${id}"]`); }

test("same-slot drag persists, preserves selection and unsaved text, and agrees with reload/preview/public", async ({ page }) => {
  const { wedding, ids } = await fixture(page);
  await frame(page).locator(`[data-studio-target="block:${ids[2]}"]`).getByRole("button").first().click();
  const panel = page.getByTestId("studio-panel");
  await panel.getByLabel(es.site.photos.blocks.bodyLabel).fill("Borrador sin guardar");
  await drag(page, block(page, ids[2]!).getByTestId("studio-drag-handle"), block(page, ids[0]!));
  await expect(page.getByTestId("studio-announcer")).toHaveText(es.site.studio.reorder.saved);
  await expect.poll(() => order(page)).toEqual([ids[2], ids[0], ids[1]]);
  await expect(panel).toHaveAttribute("data-target", `block:${ids[2]}`);
  await expect(panel.getByLabel(es.site.photos.blocks.bodyLabel)).toHaveValue("Borrador sin guardar");
  // Explicitly save the draft before leaving; reordering itself must not have saved it.
  const db = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await db.connect();
  try { expect((await db.query("select body from public.wedding_site_photo_blocks where id=$1", [ids[2]])).rows[0].body).toBe("Texto guardado"); }
  finally { await db.end(); }
  await panel.getByRole("button", { name: es.site.photos.blocks.save }).click();
  await expect(panel.getByTestId("studio-panel-status")).toHaveText(es.site.photos.blocks.saved);
  await page.reload();
  await expect.poll(() => order(page)).toEqual([ids[2], ids[0], ids[1]]);
  for (const path of [`/app/weddings/${wedding}/site/preview`, `/boda/orden-${wedding}`]) {
    await page.goto(path);
    await expect(page.getByTestId("site-photo")).toHaveCount(3);
    expect(await page.getByTestId("site-photo").evaluateAll((images) => images.map((n) => n.getAttribute("alt")))).toEqual(["Tercero", "Primero", "Segundo"]);
  }
});

test("cancel, invalid fixed-section drop and no-op never send a mutation; keyboard/tap controls reorder", async ({ page }) => {
  const { ids } = await fixture(page);
  let writes = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.headers()["next-action"]) writes++; });
  const handle = block(page, ids[2]!).getByTestId("studio-drag-handle");
  await drag(page, handle, block(page, ids[0]!), true);
  await expect.poll(() => order(page)).toEqual(ids);
  await drag(page, handle, frame(page).locator('[data-studio-target="section:intro"]'));
  await expect.poll(() => order(page)).toEqual(ids);
  await drag(page, block(page, ids[0]!).getByTestId("studio-drag-handle"), block(page, ids[1]!));
  await expect.poll(() => order(page)).toEqual(ids);
  expect(writes).toBe(0);
  await frame(page).locator(`[data-studio-target="block:${ids[2]}"]`).getByRole("button").first().click();
  const before = page.getByRole("button", { name: es.site.studio.panel.block.moveBefore, exact: true });
  await before.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual([ids[0], ids[2], ids[1]]);
  await page.getByRole("button", { name: es.site.studio.devices.mobile, exact: true }).click();
  await before.click();
  await expect.poll(() => order(page)).toEqual([ids[2], ids[0], ids[1]]);
  await expect(before).toBeDisabled();
});

test("a lost mutation response reconciles committed order without replaying", async ({ page }) => {
  const { ids } = await fixture(page);
  let intercepted = false;
  await page.route("**/site/studio", async (route) => {
    if (!intercepted && route.request().method() === "POST" && route.request().headers()["next-action"]) {
      intercepted = true;
      await route.fetch(); // Server commits; the browser never receives that response.
      await route.abort("failed");
    } else await route.continue();
  });
  await drag(page, block(page, ids[2]!).getByTestId("studio-drag-handle"), block(page, ids[0]!));
  await expect.poll(() => order(page)).toEqual([ids[2], ids[0], ids[1]]);
  await expect(page.getByTestId("studio-announcer")).toHaveText(es.site.studio.reorder.failed);
  expect(intercepted).toBe(true);
});
