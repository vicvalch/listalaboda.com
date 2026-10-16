import { expect, test } from "@playwright/test";

import { MARKETING_LINKS } from "../src/lib/marketing/links";
import { WEDDING_SITE_THEME_KEYS } from "../src/lib/wedding-site/design/themes";
import { es } from "./support/flows";
import { loadEveryImage, measure } from "./support/marketing";

// Marketing Landing V1 (MKT-2): /planners, the deeper page for wedding
// planners. Static, public, not indexed yet; the pilot leads.

const copy = es.marketing;
const page$ = copy.planners;
const WIDTHS = [360, 390, 768, 1280] as const;

test.describe("marketing /planners", () => {
  test("one h1, noindex, pilot first, planner links, no dead links, five themes", async ({ page }) => {
    const response = await page.goto("/planners");
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page$.hero.title);
    await expect(page).toHaveTitle(page$.metadata.title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", page$.metadata.description);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator("main#contenido")).toHaveCount(1);

    // The hero's calls to action: the pilot first, then the demo, from the central links.
    const hero = page.locator("#inicio");
    const heroLinks = hero.getByRole("link");
    await expect(heroLinks.nth(0)).toHaveText(copy.cta.pilot);
    await expect(heroLinks.nth(0)).toHaveAttribute("href", MARKETING_LINKS.PILOT);
    await expect(heroLinks.nth(1)).toHaveText(copy.cta.demo);
    await expect(heroLinks.nth(1)).toHaveAttribute("href", MARKETING_LINKS.DEMO);
    for (const link of await page.locator("main").getByRole("link", { name: copy.cta.pilot }).all()) {
      await expect(link).toHaveAttribute("href", MARKETING_LINKS.PILOT);
    }

    // Header and footer point at both audience pages; the couples page only from there (MKT-3).
    for (const region of [page.getByRole("banner"), page.getByRole("contentinfo")]) {
      await expect(region.getByRole("link", { name: copy.nav.planners })).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
      await expect(region.getByRole("link", { name: copy.nav.couples })).toHaveAttribute("href", MARKETING_LINKS.COUPLES);
    }
    await expect(page.locator(`main a[href="${MARKETING_LINKS.COUPLES}"]`)).toHaveCount(0);

    // Every link is a known destination: never self-signup.
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
    const known = new Set<string>(["/", "#contenido", ...Object.values(MARKETING_LINKS)]);
    expect(hrefs.filter((href) => !known.has(href))).toEqual([]);

    // The five themes, named in text; renders hidden from assistive technology.
    const showcase = page.getByTestId("theme-showcase");
    await expect(page.getByTestId("theme-showcase-item")).toHaveCount(5);
    for (const key of WEDDING_SITE_THEME_KEYS) {
      await expect(showcase.getByRole("heading", { level: 3, name: es.site.themes[key].name })).toBeVisible();
    }
    await expect(showcase.locator('[aria-hidden="true"][inert]')).toHaveCount(5);

    // Every product screenshot has Spanish alt text.
    const alts = await page.locator("main img:not([data-lifestyle])").evaluateAll((images) => images.map((img) => img.getAttribute("alt") ?? ""));
    expect(alts.length).toBe(9);
    for (const alt of alts) expect(alt.length).toBeGreaterThan(20);
  });

  test("the FAQ opens and closes by keyboard, with a visible focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/planners");
    const faq = page.getByTestId("faq-list");
    await expect(faq.locator("details")).toHaveCount(page$.faq.items.length);
    const first = page$.faq.items[0];
    const summary = faq.locator("summary").first();
    const answer = faq.getByText(first.answer);
    await expect(answer).toBeHidden();
    await summary.focus();
    expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await expect(answer).toBeVisible();
    await page.keyboard.press("Space");
    await expect(answer).toBeHidden();
    // Tab moves to the next question.
    await page.keyboard.press("Tab");
    await expect(faq.locator("summary").nth(1)).toBeFocused();
  });

  test("fits 360, 390, 768 and 1280 px in light and dark, with AA text everywhere", async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/planners");
        await loadEveryImage(page);
        const result = await measure(page);
        expect(result.scrolls, `${colorScheme} ${width}px: no horizontal scroll`).toBe(false);
        expect(result.lowContrast, `${colorScheme} ${width}px: WCAG AA text`).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`planners-${colorScheme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  });

  test("works without JavaScript: the story, the calls to action, the FAQ and the themes", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/planners");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page$.hero.title);
    for (const title of [page$.guestsSeating.title, page$.money.title, page$.timeline.title, page$.weddingDay.title, page$.collaboration.title, page$.sites.title]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    await expect(page.locator("main").getByRole("link", { name: copy.cta.pilot }).first()).toHaveAttribute("href", MARKETING_LINKS.PILOT);
    const faq = page.getByTestId("faq-list");
    await faq.locator("summary").first().click();
    await expect(faq.getByText(page$.faq.items[0].answer)).toBeVisible();
    await expect(page.getByTestId("theme-showcase-item")).toHaveCount(5);
    await context.close();
  });
});
