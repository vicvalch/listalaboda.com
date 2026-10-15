import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { logIn } from "../support/flows";
import { seedMarketingFixture } from "./fixture";

/**
 * Captures the real product screens the marketing pages show (Marketing
 * Landing V1) from the fictional LOCAL fixture (`./fixture.ts`) into
 * `public/marketing/*.webp`. Run with `npm run marketing:capture`; review
 * the images before committing them, like golden files.
 *
 * Only the page's main content is captured: the app header (which shows the
 * signed-in account's address) is never in a shot. Before every capture a
 * privacy guard refuses the page if it contains anything that looks like an
 * email address, a phone number, a guest link or a token.
 */

const OUT = resolve(__dirname, "../../public/marketing");

test.setTimeout(10 * 60_000);

/** Refuses the page if its main content could expose anything private. */
async function privacyGuard(page: Page, name: string) {
  const main = page.locator("main");
  const text = await main.innerText();
  expect(text, `${name}: no email address`).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  // Phone shapes (+506 8888 8888, 8888-8888), not amounts like 4.500.000.
  expect(text, `${name}: no phone number`).not.toMatch(/\+\d{3}|\b\d{4}[\s-]\d{4}\b/);
  expect(text, `${name}: no token-like value`).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  const links = await main.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  expect(links.filter((href) => /\/rsvp\/|mailto:|tel:/.test(href)), `${name}: no guest, mail or phone links`).toEqual([]);
}

/** Hides development-only overlays so they never land in a shot. */
async function hideDevChrome(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal, [data-nextjs-toast] { display: none !important; }" });
}

/** PNG → WebP inside Chromium (no image dependency), written to public/marketing. */
async function saveWebp(page: Page, png: Buffer, file: string) {
  const webp = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", 0.86).split(",")[1];
  }, png.toString("base64"));
  writeFileSync(resolve(OUT, file), Buffer.from(webp, "base64"));
}

type Crop =
  /** The top of an element, at most `maxHeight` CSS px. */
  | Readonly<{ kind: "element"; selector: string; maxHeight: number }>
  /** The page column (`main`'s width) from an element's top, `height` CSS px down. */
  | Readonly<{ kind: "from"; selector: string; height: number }>
  /** The whole visual seating planner: the rail, the board and the details panel. */
  | Readonly<{ kind: "planner" }>
  /** A close-up of some tables of the planner (by name), for phones. */
  | Readonly<{ kind: "tables"; names: readonly string[] }>
  /** A run of consecutive Cronograma entries, `from` (inclusive) to `to` (exclusive), with what lies between them. */
  | Readonly<{ kind: "entries"; from: number; to: number }>;

async function shoot(page: Page, crop: Crop): Promise<Buffer> {
  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox();
    if (!found) throw new Error(`${selector} not found`);
    return found;
  };
  let clip: { x: number; y: number; width: number; height: number };
  if (crop.kind === "element") {
    const b = await box(crop.selector);
    clip = { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, crop.maxHeight) };
  } else if (crop.kind === "from") {
    const [main, start] = [await box("main"), await box(crop.selector)];
    const content = await page.evaluate(() => document.documentElement.scrollHeight);
    clip = { x: main.x, y: start.y - 8, width: main.width, height: Math.min(crop.height, content - start.y + 8) };
  } else if (crop.kind === "entries") {
    const entries = page.locator('[data-testid="timeline-entry"]');
    const [first, last] = [await entries.nth(crop.from).boundingBox(), await entries.nth(crop.to - 1).boundingBox()];
    if (!first || !last) throw new Error(`timeline entries ${crop.from}–${crop.to} not found`);
    const margin = 12;
    const main = await box("main");
    clip = { x: main.x, y: first.y - margin, width: main.width, height: last.y + last.height - first.y + 2 * margin };
  } else if (crop.kind === "tables") {
    const tables = page.locator(crop.names.map((name) => `[data-testid="planner-table"][data-table-name="${name}"]`).join(", "));
    const boxes = await tables.evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY };
      }),
    );
    if (boxes.length !== crop.names.length) throw new Error(`expected tables ${crop.names.join(", ")}`);
    const margin = 36;
    const left = Math.min(...boxes.map((b) => b.x)) - margin;
    const top = Math.min(...boxes.map((b) => b.y)) - margin;
    clip = {
      x: left,
      y: top,
      width: Math.max(...boxes.map((b) => b.right)) + margin - left,
      height: Math.max(...boxes.map((b) => b.bottom)) + margin - top,
    };
  } else {
    const parts = [
      await box('[data-testid="planner-rail"]'),
      await box('[data-testid="planner-board"]'),
      await box('[data-testid="planner-inspector"]'),
    ];
    const margin = 16;
    const left = Math.min(...parts.map((p) => p.x)) - margin;
    const top = Math.min(...parts.map((p) => p.y)) - margin;
    const right = Math.max(...parts.map((p) => p.x + p.width)) + margin;
    const bottom = parts[1].y + parts[1].height + margin;
    clip = { x: left, y: top, width: right - left, height: bottom - top };
  }
  return page.screenshot({ fullPage: true, clip });
}

test("captures the marketing product screenshots from the fictional fixture", async ({ browser }, testInfo) => {
  const { email, mainWeddingId } = await seedMarketingFixture();
  const wedding = `/app/weddings/${mainWeddingId}`;
  const encoder = await (await browser.newContext()).newPage();

  // A party with a mix of answers (two attending, one pending).
  const party = '[id^="party-"]:has(h3:text-is("Amigos de la U"))';
  // The wedding home's checklist progress, followed by "Lo próximo".
  const checklist = '[data-testid="checklist-progress"]';

  // Twice the CSS pixels, so the shots stay sharp at their displayed size.
  const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  await logIn(page, email);
  // The booked caterer with a paid deposit and two upcoming installments (MKT-2).
  await page.goto(`${wedding}/vendors`);
  const caterer = await page.getByRole("link", { name: "Sabores del Valle" }).first().getAttribute("href");
  if (!caterer) throw new Error("the fixture caterer is missing");

  const allShots: ReadonlyArray<{ file: string; path: string; width: number; crop: Crop; media?: "print" }> = [
    // The hero: the page title and what needs attention across weddings.
    { file: "mis-bodas.webp", path: "/app?all=1", width: 1280, crop: { kind: "element", selector: "main", maxHeight: 600 } },
    { file: "mis-bodas-mobile.webp", path: "/app?all=1", width: 390, crop: { kind: "element", selector: "main", maxHeight: 860 } },
    // One wedding's card: its own attention items and facts.
    { file: "wedding-card.webp", path: "/app?all=1", width: 1280, crop: { kind: "element", selector: '[data-testid="wedding-card"]', maxHeight: 700 } },
    { file: "guests.webp", path: `${wedding}/guests`, width: 1280, crop: { kind: "from", selector: party, height: 448 } },
    { file: "guests-mobile.webp", path: `${wedding}/guests`, width: 390, crop: { kind: "from", selector: party, height: 640 } },
    { file: "seating.webp", path: `${wedding}/seating?view=plan`, width: 1920, crop: { kind: "planner" } },
    { file: "seating-mobile.webp", path: `${wedding}/seating?view=plan`, width: 1920, crop: { kind: "tables", names: ["Mesa 2", "Mesa 3"] } },
    { file: "budget.webp", path: `${wedding}/budget`, width: 1280, crop: { kind: "from", selector: '[data-testid="budget-currency-CRC"]', height: 900 } },
    { file: "budget-mobile.webp", path: `${wedding}/budget`, width: 390, crop: { kind: "from", selector: '[data-testid="budget-currency-CRC"]', height: 820 } },
    { file: "timeline-mobile.webp", path: `${wedding}/timeline`, width: 390, crop: { kind: "from", selector: '[data-testid="timeline-overview"]', height: 820 } },
    // A vendor's payments: what was agreed, paid and still due, installment by installment.
    { file: "vendor-payments.webp", path: caterer, width: 1280, crop: { kind: "element", selector: '[data-testid="vendor-payments"]', maxHeight: 1100 } },
    { file: "vendor-payments-mobile.webp", path: caterer, width: 390, crop: { kind: "element", selector: '[data-testid="vendor-payments"]', maxHeight: 1300 } },
    // The Cronograma as the product prints it (its own print styles: no edit buttons), in three runs of the day.
    { file: "timeline-print-1.webp", path: `${wedding}/timeline`, width: 390, media: "print", crop: { kind: "entries", from: 0, to: 3 } },
    { file: "timeline-print-2.webp", path: `${wedding}/timeline`, width: 390, media: "print", crop: { kind: "entries", from: 3, to: 6 } },
    { file: "timeline-print-3.webp", path: `${wedding}/timeline`, width: 390, media: "print", crop: { kind: "entries", from: 6, to: 9 } },
    // The wedding's home (MKT-3): the checklist's progress and "Lo próximo".
    { file: "checklist.webp", path: wedding, width: 1280, crop: { kind: "from", selector: checklist, height: 410 } },
    { file: "checklist-mobile.webp", path: wedding, width: 390, crop: { kind: "from", selector: checklist, height: 482 } },
  ];
  // `MARKETING_CAPTURE_ONLY=checklist,guests` re-captures only the files whose
  // names start with those words: a WebP re-encode never matches the approved
  // bytes, so untouched shots are left alone.
  const only = (process.env.MARKETING_CAPTURE_ONLY ?? "").split(",").map((word) => word.trim()).filter(Boolean);
  const shots = only.length ? allShots.filter((shot) => only.some((word) => shot.file.startsWith(word))) : allShots;
  if (shots.length === 0) throw new Error(`MARKETING_CAPTURE_ONLY matches no shot: ${only.join(", ")}`);

  for (const shot of shots) {
    await page.emulateMedia({ media: shot.media ?? "screen" });
    await page.setViewportSize({ width: shot.width, height: 900 });
    await page.goto(shot.path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).toBeVisible();
    await hideDevChrome(page);
    await privacyGuard(page, shot.file);
    await saveWebp(encoder, await shoot(page, shot.crop), shot.file);
    // A full-page reference next to the test results, to review the crop (never published).
    await page.screenshot({ path: testInfo.outputPath(shot.file.replace(".webp", "-page.png")), fullPage: true });
  }
  await context.close();
});
