import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import sharp from "sharp";

import { createAccount, createWedding, es, logIn } from "./support/flows";

// STUDIO-01: ListaLaBoda Studio end to end, with the photo flag on
// (playwright.config.ts) and generated images only (no real photographs).
// The acceptance scenario: open Studio → add a carousel → choose photos →
// see it on the page, without leaving the editor; then it persists.

const site = es.site;
const studio = es.site.studio;

/** A generated landscape: a soft gradient, no people. */
async function landscape(seed: number, width = 1800, height = 1200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${seed * 67},55%,62%)"/><stop offset="1" stop-color="hsl(${seed * 67 + 40},45%,32%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

function canvas(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="studio-canvas"]');
}

async function openStudio(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/site`);
  await page.getByTestId("open-studio").click();
  await expect(page.getByTestId("studio")).toBeVisible();
  await expect(canvas(page).getByTestId("public-site")).toBeVisible();
}

/** The canvas's elements, top to bottom: `cover`, `section:<kind>`, `block:<kind>`. */
async function canvasOrder(page: Page): Promise<string[]> {
  return canvas(page)
    .locator("[data-studio-target]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const key = (node as HTMLElement).dataset.studioTarget ?? "";
        if (!key.startsWith("block:")) return key;
        const kind = node.querySelector<HTMLElement>("[data-testid^='site-photo-block-']")?.dataset.testid?.replace("site-photo-block-", "");
        return `block:${kind ?? "empty"}`;
      }),
    );
}

test.describe("ListaLaBoda Studio", () => {
  test("edit a text section live, add a carousel with photos, see it on the page, reload", async ({ page }) => {
    test.setTimeout(240_000);
    await logIn(page, await createAccount("studio-couple", "couple"));
    const weddingId = await createWedding(page, "Ana y Luis");
    await openStudio(page, weddingId);

    // The real site in the canvas: the couple's names, in their theme; empty sections are placeholders.
    await expect(canvas(page).getByRole("heading", { name: "Ana y Luis" })).toBeVisible();
    expect(await canvasOrder(page)).toEqual(["cover", "section:intro", "section:ceremony", "section:reception", "section:schedule", "section:dress_code", "section:faq", "section:rsvp"]);
    await expect(page.getByTestId("studio-panel-empty")).toBeVisible();

    // Select the introduction ON THE CANVAS and type: the canvas shows it before saving.
    await canvas(page).locator('[data-studio-target="section:intro"] button').click();
    const panel = page.getByTestId("studio-panel");
    await expect(panel).toHaveAttribute("data-target", "section:intro");
    await panel.getByLabel(site.sections.bodyLabel).fill("Nos casamos frente al mar.");
    await expect(canvas(page).getByText("Nos casamos frente al mar.")).toBeVisible();
    await expect(canvas(page).locator('[data-studio-target="section:intro"]')).toContainText(studio.canvas.unsaved);
    await panel.getByLabel(site.sections.visibleLabel).check();
    await panel.getByRole("button", { name: site.sections.submit }).click();
    await expect(panel.getByTestId("studio-panel-status")).toHaveText(site.sections.saved);
    await expect(panel.getByTestId("site-section-visibility")).toHaveText(site.sections.shown);
    await expect(canvas(page).locator('[data-studio-target="section:intro"]')).not.toContainText(studio.canvas.unsaved);

    // Add a carousel from the left palette, right after the ceremony.
    await page.getByTestId("studio-element-carousel").click();
    await expect(page.getByTestId("studio-insert-banner")).toBeVisible();
    await canvas(page).locator('[data-testid="studio-insert"][data-anchor="ceremony"]').click();
    await expect(panel).toHaveAttribute("data-block-kind", "carousel");
    await expect(panel.getByTestId("studio-choose-photos")).toBeVisible();
    await expect(page.getByTestId("studio-insert-banner")).toHaveCount(0);
    expect((await canvasOrder(page)).slice(2, 4)).toEqual(["section:ceremony", "block:empty"]);

    // No photos yet: upload inside Studio, then choose them from the library picker.
    await panel.getByTestId("photo-upload-input").setInputFiles(
      await Promise.all([1, 2].map(async (seed) => ({ name: `paisaje-${seed}.jpg`, mimeType: "image/jpeg", buffer: await landscape(seed) }))),
    );
    await panel.getByRole("button", { name: site.photos.upload.button }).click();
    await expect(panel.getByText(site.photos.upload.allDone)).toBeVisible({ timeout: 60_000 });
    const picker = panel.getByTestId("studio-photo-picker");
    await expect(picker.locator("li")).toHaveCount(2);
    for (const item of await picker.locator("li label").all()) await item.click();
    await picker.getByRole("button", { name: "Agregar 2 fotos" }).click();
    await expect(page.getByTestId("studio-announcer")).toHaveText("Agregamos 2 fotos.");

    // The carousel, with the real images, on the page, still hidden.
    const carousel = canvas(page).getByTestId("site-photo-block-carousel");
    await expect(carousel.locator("img")).toHaveCount(2);
    await expect.poll(() => carousel.locator("img").first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(carousel).toContainText("Foto 1 de 2");
    await expect(panel.getByTestId("studio-block-visibility")).toHaveText(site.sections.hidden);

    // Describe both photos, then show the carousel.
    const photos = panel.getByTestId("studio-block-photo");
    for (const [index, alt] of ["Atardecer de prueba", "Bosque de prueba"].entries()) {
      await photos.nth(index).getByLabel(site.photos.library.altLabel).fill(alt);
      await photos.nth(index).getByRole("button", { name: site.photos.library.save }).click();
      await expect(page.getByTestId("studio-announcer")).toHaveText(site.photos.library.saved);
    }
    await expect(carousel.locator("img").first()).toHaveAttribute("alt", "Atardecer de prueba");
    await panel.getByLabel(site.photos.blocks.visibleLabel).check();
    await panel.getByRole("button", { name: site.photos.blocks.save }).click();
    await expect(panel.getByTestId("studio-panel-status")).toHaveText(site.photos.blocks.saved);
    await expect(panel.getByTestId("studio-block-visibility")).toHaveText(site.sections.shown);

    // Phone width: a real 390 px viewport, nothing overflows.
    await page.getByRole("button", { name: studio.devices.mobile }).click();
    await expect(page.getByTestId("studio-canvas")).toHaveCSS("width", "390px");
    expect(
      await canvas(page).locator("body").evaluate((body) => body.ownerDocument.documentElement.scrollWidth <= body.ownerDocument.defaultView!.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: studio.devices.desktop }).click();

    // Reload: everything persisted, in place.
    await page.reload();
    await expect(canvas(page).getByTestId("public-site")).toBeVisible();
    expect((await canvasOrder(page)).slice(1, 4)).toEqual(["section:intro", "section:ceremony", "block:carousel"]);
    await expect(canvas(page).getByText("Nos casamos frente al mar.")).toBeVisible();
    await expect(canvas(page).getByTestId("site-photo-block-carousel").locator("img")).toHaveCount(2);

    // The member preview (the existing workflow) draws the same.
    await page.goto(`/app/weddings/${weddingId}/site/preview`);
    await expect(page.getByTestId("site-preview").getByTestId("site-photo-block-carousel").locator("img")).toHaveCount(2);
  });

  test("a second wedding's Studio never offers the first wedding's photos; outsiders get 404", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await logIn(page, await createAccount("studio-planner", "planner"));
    const first = await createWedding(page, "Boda Uno");
    const second = await createWedding(page, "Boda Dos");

    await page.goto(`/app/weddings/${first}/site/photos`);
    await page.getByTestId("photo-upload-input").setInputFiles({ name: "uno.jpg", mimeType: "image/jpeg", buffer: await landscape(3) });
    await page.getByRole("button", { name: site.photos.upload.button }).click();
    await expect(page.getByText(site.photos.upload.allDone)).toBeVisible({ timeout: 60_000 });

    await openStudio(page, second);
    await page.getByTestId("studio-element-gallery").click();
    await canvas(page).locator('[data-testid="studio-insert"][data-anchor="top"]').click();
    const panel = page.getByTestId("studio-panel");
    await expect(panel).toHaveAttribute("data-block-kind", "gallery");
    await expect(panel.getByText(studio.panel.block.pickEmpty)).toBeVisible();
    await expect(panel.getByTestId("studio-photo-picker")).toHaveCount(0);

    const other = await browser.newContext();
    const outsider = await other.newPage();
    await logIn(outsider, await createAccount("studio-outsider", "couple"));
    expect((await outsider.goto(`/app/weddings/${first}/site/studio`))?.status()).toBe(404);
    await other.close();
  });
});
