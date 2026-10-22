import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import sharp from "sharp";

import { createAccount, createWedding, es, logIn } from "./support/flows";
import { readLocalSupabase } from "./support/local-supabase";

// UX-01B (ADR-022): wedding-site photos end to end, with the server flag on
// (playwright.config.ts) and generated fixtures only (no real photographs):
// upload with progress, EXIF/GPS removal, alt text, cover, member preview,
// publication-gated public delivery, unpublish, blocks and keyboard
// reordering, deletion, quota messages, and an outsider's 404.

const site = es.site;
const photos = es.site.photos;

function uniqueSlug(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

/** A generated "phone photo": noise, landscape, with EXIF camera and GPS data. */
async function phoneJpeg(seed: number, width = 2400, height = 1600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761 + seed * 97) % 251;
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 88 })
    .withExif({
      IFD0: { Make: "FixtureCam", Model: "E2E" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "9/1 56/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "84/1 5/1 0/1" },
    })
    .toBuffer();
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

async function openPhotos(page: Page, weddingId: string) {
  await page.goto(`/app/weddings/${weddingId}/site`);
  const card = page.getByTestId("site-photos-card");
  await expect(card).toContainText(photos.disclosure);
  await card.getByRole("link", { name: photos.manage }).click();
  await expect(page.getByRole("heading", { level: 1, name: photos.title })).toBeVisible();
}

async function upload(page: Page, files: Array<{ name: string; buffer: Buffer }>) {
  await page.getByTestId("photo-upload-input").setInputFiles(
    files.map((file) => ({ name: file.name, mimeType: "image/jpeg", buffer: file.buffer })),
  );
  await page.getByRole("button", { name: photos.upload.button }).click();
  await expect(page.getByText(photos.upload.allDone)).toBeVisible({ timeout: 60_000 });
}

function libraryCards(page: Page) {
  return page.getByTestId("library-photo");
}

async function describePhoto(page: Page, index: number, alt: string, caption = "") {
  const card = libraryCards(page).nth(index);
  await card.getByLabel(photos.library.altLabel).fill(alt);
  if (caption) await card.getByLabel(photos.library.captionLabel).fill(caption);
  await card.getByRole("button", { name: photos.library.save }).click();
  await expect(card.getByTestId("photo-form-result").filter({ hasText: photos.library.saved })).toBeVisible();
  await expect(page.getByTestId("photo-announcer")).toHaveText(photos.library.saved);
}

async function publishWithIntro(page: Page, weddingId: string, slug: string) {
  await page.goto(`/app/weddings/${weddingId}/site`);
  const intro = page.locator('[data-testid="site-section"][data-kind="intro"]');
  await intro.getByLabel(site.sections.bodyLabel).fill("Nos casamos y queremos compartirlo.");
  await intro.getByLabel(site.sections.visibleLabel).setChecked(true);
  await intro.getByRole("button", { name: site.sections.submit }).click();
  await expect(intro.getByRole("status")).toHaveText(site.sections.saved);
  await page.getByLabel(site.slug.label, { exact: true }).fill(slug);
  await page.getByRole("button", { name: site.slug.submit }).click();
  await expect(page.getByText(site.slug.saved)).toBeVisible();
  await page.getByRole("button", { name: site.publish.submit }).click();
  await expect(page.getByText(site.publish.done)).toBeVisible();
}

test.describe("wedding-site photos", () => {
  test("upload, describe, cover, preview, publish, unpublish and delete", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await logIn(page, await createAccount("ux01b-couple", "couple"));
    const weddingId = await createWedding(page, "Boda con fotos");
    await openPhotos(page, weddingId);
    await expect(page.getByTestId("photo-count")).toHaveText("0 de 20 fotos");

    // Upload: the status list shows each file and ends "Lista".
    await upload(page, [{ name: "portada.jpg", buffer: await phoneJpeg(1) }]);
    await expect(page.getByTestId("photo-upload-status")).toContainText(photos.upload.done);
    await expect(page.getByTestId("photo-count")).toHaveText("1 de 20 fotos");
    await expect(libraryCards(page)).toHaveCount(1);
    await expect(page.getByTestId("photo-missing-alt")).toBeVisible();

    // The stored renditions are WebP without EXIF or GPS (read through the member route).
    const thumb = libraryCards(page).first().locator("img");
    const src = await thumb.getAttribute("src");
    expect(src).toMatch(/\/site\/photos\/[0-9a-f-]{36}\/640$/);
    const memberResponse = await page.request.get(src!);
    expect(memberResponse.status()).toBe(200);
    expect(memberResponse.headers()["content-type"]).toBe("image/webp");
    expect(memberResponse.headers()["cache-control"]).toBe("private, no-store");
    const stored = await memberResponse.body();
    for (const marker of ["Exif", "FixtureCam", "GPS"]) expect(stored.includes(Buffer.from(marker))).toBe(false);
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["webp", 640, 427, undefined]);
    const photoId = /photos\/([0-9a-f-]{36})\/640$/.exec(src!)![1];

    // Describe it, make it the cover, show the cover.
    await describePhoto(page, 0, "Ana y Luis frente al mar", "Puntarenas, 2026");
    await libraryCards(page).first().getByRole("button", { name: photos.library.useAsCover }).click();
    await expect(page.getByTestId("photo-announcer")).toHaveText(photos.library.coverSet);
    const cover = page.getByTestId("photos-cover");
    await expect(cover.locator("img")).toHaveAttribute("alt", "Ana y Luis frente al mar");
    await cover.getByLabel(photos.cover.visibleLabel).check();
    await cover.getByRole("button", { name: photos.cover.save }).click();
    await expect(page.getByTestId("photo-announcer")).toHaveText(photos.cover.saved);

    // Member preview shows it before anything is published.
    await page.goto(`/app/weddings/${weddingId}/site/preview`);
    const previewCover = page.getByTestId("site-preview").getByTestId("site-cover").locator("img");
    await expect(previewCover).toHaveAttribute("alt", "Ana y Luis frente al mar");
    await expect(previewCover).toHaveAttribute("src", `/app/weddings/${weddingId}/site/photos/${photoId}/1600`);
    await expect(page.getByTestId("site-preview")).toContainText("Puntarenas, 2026");

    // Not public yet: the public photo URL is a 404 even with a guessed slug.
    const slug = uniqueSlug("fotos");
    expect((await page.request.get(`/boda/${slug}/fotos/${photoId}/640`)).status()).toBe(404);

    // Publish: guests see the cover through the gated public route.
    await publishWithIntro(page, weddingId, slug);
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(`/boda/${slug}`);
    const publicCover = guestPage.getByTestId("site-cover").locator("img");
    await expect(publicCover).toHaveAttribute("src", `/boda/${slug}/fotos/${photoId}/1600`);
    await expect(publicCover).toHaveAttribute("alt", "Ana y Luis frente al mar");
    await expect(publicCover).toHaveAttribute("width", "1600");
    await expect(publicCover).toHaveAttribute("height", "1067");
    await expect.poll(() => publicCover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const publicResponse = await guestPage.request.get(`/boda/${slug}/fotos/${photoId}/640`);
    expect(publicResponse.status()).toBe(200);
    expect(publicResponse.headers()["cache-control"]).toBe("public, max-age=600");
    expect(publicResponse.headers()["vercel-cache-tag"]).toBe(`lb-photo-${photoId}`);
    expect(publicResponse.headers()["set-cookie"]).toBeUndefined();
    expect((await guestPage.request.get(`/boda/${slug}/fotos/${photoId}/640?v=1`)).status()).toBe(404);
    // An anonymous visitor can't use the member route.
    expect((await guestPage.request.get(`/app/weddings/${weddingId}/site/photos/${photoId}/640`)).status()).not.toBe(200);

    // Unpublish: the next uncached request is a 404.
    await page.goto(`/app/weddings/${weddingId}/site`);
    await page.getByRole("button", { name: site.unpublish.open }).click();
    await page.getByRole("button", { name: site.unpublish.confirmButton }).click();
    await expect(page.getByText(site.unpublish.done)).toBeVisible();
    expect((await guestPage.request.get(`/boda/${slug}/fotos/${photoId}/640`)).status()).toBe(404);
    await guest.close();

    // Delete: objects and row are gone; the member route is a 404 too.
    await openPhotos(page, weddingId);
    const card = libraryCards(page).first();
    await card.getByRole("button", { name: photos.library.delete }).click();
    await card.getByRole("button", { name: photos.library.delete }).click();
    await expect(libraryCards(page)).toHaveCount(0);
    await expect(page.getByTestId("photo-count")).toHaveText("0 de 20 fotos");
    expect((await page.request.get(src!)).status()).toBe(404);
    const objects = await withDb((db) =>
      db.query("select name from storage.objects where bucket_id = 'wedding-photos' and name like $1", [`${photoId}/%`]),
    );
    expect(objects.rows).toEqual([]);
  });

  test("gallery and carousel blocks, keyboard reordering and quota messages", async ({ page }) => {
    test.setTimeout(240_000);
    await logIn(page, await createAccount("ux01b-blocks", "couple"));
    const weddingId = await createWedding(page, "Boda con galería");
    await openPhotos(page, weddingId);

    await upload(page, [
      { name: "uno.jpg", buffer: await phoneJpeg(2, 1800, 1200) },
      { name: "dos.jpg", buffer: await phoneJpeg(3, 1200, 1800) },
    ]);
    await expect(libraryCards(page)).toHaveCount(2);
    await describePhoto(page, 0, "Primera foto");
    await describePhoto(page, 1, "Segunda foto");

    // A carousel after the ceremony section, with both photos.
    const create = page.getByTestId("photo-block-create");
    const carouselForm = create.locator("li").filter({ hasText: photos.blocks.kinds.carousel });
    await carouselForm.getByLabel(photos.blocks.anchorLabel).selectOption("ceremony");
    await carouselForm.getByRole("button", { name: `${photos.blocks.create}: ${photos.blocks.kinds.carousel}` }).click();
    await expect(page.getByTestId("photo-block")).toHaveCount(1);
    for (const index of [0, 1]) {
      const photoCard = libraryCards(page).nth(index);
      await photoCard.getByRole("button", { name: photos.library.addToButton }).click();
      await expect(page.getByTestId("photo-announcer")).toHaveText(photos.library.added);
    }
    const block = page.getByTestId("photo-block");
    await expect(block.locator("ol img")).toHaveCount(2);
    await block.getByLabel(photos.blocks.visibleLabel).check();
    await block.getByRole("button", { name: photos.blocks.save }).click();
    await expect(page.getByTestId("photo-announcer")).toHaveText(photos.blocks.saved);

    // Keyboard reordering: "Mover antes" on the second photo, announced with its new position.
    const second = block.locator("ol > li").nth(1);
    const moveBefore = second.getByRole("button", { name: /Mover «Foto 2/ }).first();
    await moveBefore.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("photo-announcer")).toHaveText(/a la posición 1 de 2/);
    await expect(block.locator("ol > li").first().locator("img")).toHaveAttribute("alt", "Segunda foto");

    // The preview draws the carousel without script, with its position text.
    await page.goto(`/app/weddings/${weddingId}/site/preview`);
    const carousel = page.getByTestId("site-preview").getByTestId("site-photo-block-carousel");
    await expect(carousel.getByRole("list", { name: es.publicSite.photos.carousel })).toBeVisible();
    await expect(carousel).toContainText("Foto 1 de 2");
    await expect(carousel.locator("img").first()).toHaveAttribute("alt", "Segunda foto");
    await expect(carousel.locator("img").first()).toHaveAttribute("loading", "lazy");

    // Quota messages come from the server.
    await withDb((db) =>
      db.query(
        "insert into private.wedding_photo_upload_days (wedding_id, day, uploads) values ($1, (now() at time zone 'utc')::date, 60) on conflict (wedding_id, day) do update set uploads = 60",
        [weddingId],
      ),
    );
    await openPhotos(page, weddingId);
    await upload(page, [{ name: "tres.jpg", buffer: await phoneJpeg(4, 1000, 800) }]);
    await expect(page.getByTestId("photo-upload-status")).toContainText(photos.errors.dailyLimit);
    // Too small and the wrong type are refused in the browser.
    await page.getByTestId("photo-upload-input").setInputFiles({
      name: "nota.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("no es una foto"),
    });
    await page.getByRole("button", { name: photos.upload.button }).click();
    await expect(page.getByTestId("photo-upload-status")).toContainText(photos.errors.unsupported);
  });

  test("an outsider gets 404 for the editor and the photos", async ({ page, browser }) => {
    await logIn(page, await createAccount("ux01b-owner", "couple"));
    const weddingId = await createWedding(page, "Boda privada");
    await openPhotos(page, weddingId);
    await upload(page, [{ name: "privada.jpg", buffer: await phoneJpeg(5, 1200, 900) }]);
    const src = await libraryCards(page).first().locator("img").getAttribute("src");

    const other = await browser.newContext();
    const outsider = await other.newPage();
    await logIn(outsider, await createAccount("ux01b-outsider", "couple"));
    const editor = await outsider.goto(`/app/weddings/${weddingId}/site/photos`);
    expect(editor?.status()).toBe(404);
    expect((await outsider.request.get(src!)).status()).toBe(404);
    const forged = await outsider.request.post(`/app/weddings/${weddingId}/site/photos/upload`, {
      headers: { origin: new URL(outsider.url()).origin },
      multipart: { photo: { name: "x.jpg", mimeType: "image/jpeg", buffer: await phoneJpeg(6, 800, 700) } },
    });
    expect(forged.status()).toBe(404);
    expect(await forged.json()).toEqual({ ok: false, reason: "not_found" });
    const crossSite = await outsider.request.post(`/app/weddings/${weddingId}/site/photos/upload`, {
      headers: { origin: "https://evil.example" },
      multipart: { photo: { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff]) } },
    });
    expect(crossSite.status()).toBe(403);
    await other.close();
  });
});
