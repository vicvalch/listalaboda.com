import { expect, test, type Page } from "@playwright/test";

import { MARKETING_LINKS } from "../src/lib/marketing/links";
import { WEDDING_SITE_THEME_KEYS } from "../src/lib/wedding-site/design/themes";
import { es } from "./support/flows";

// Marketing Landing V1 (MKT-1): the planner-first homepage. Static, public,
// not indexed yet; every call to action comes from the central links module.

const copy = es.marketing;
const WIDTHS = [360, 390, 768, 1280] as const;

/** Overflow and WCAG AA contrast of every element holding text, against its painted background. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const backgroundOf = (element: Element | null): number[] => {
      for (let node = element; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length === 3 || (color.length === 4 && color[3] > 0)) return color;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !element.closest('[aria-hidden="true"], .sr-only');
    };
    const lowContrast = [...document.querySelectorAll("body *")]
      .filter((element) => visible(element) && [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
      .map((element) => {
        const [a, b] = [luminance(rgb(getComputedStyle(element).color)), luminance(backgroundOf(element))];
        return { text: element.textContent?.trim().slice(0, 40), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ text, ratio }) => `${text} ${ratio.toFixed(2)}`);
    return { scrolls: root.scrollWidth > root.clientWidth, lowContrast };
  });
}

test.describe("marketing homepage", () => {
  test("one h1, landmarks, noindex, centralized calls to action, the five themes, no dead links", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(copy.home.hero.title);
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: copy.nav.label })).toHaveCount(1);
    await expect(page.locator("main#contenido")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(page).toHaveTitle(copy.home.metadata.title);

    // Not indexed while the production domain isn't connected; no canonical yet.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

    // Calls to action point at the central destinations.
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: copy.cta.demo }).first()).toHaveAttribute("href", MARKETING_LINKS.DEMO);
    await expect(main.getByRole("link", { name: copy.cta.howItWorks })).toHaveAttribute("href", MARKETING_LINKS.HOW_IT_WORKS);
    await expect(main.getByRole("link", { name: copy.cta.access })).toHaveAttribute("href", MARKETING_LINKS.ACCESS);
    await expect(main.getByRole("link", { name: copy.cta.pilot })).toHaveAttribute("href", MARKETING_LINKS.PILOT);
    await expect(page.getByRole("banner").getByRole("link", { name: copy.nav.login })).toHaveAttribute("href", MARKETING_LINKS.LOGIN);

    // Every link on the page is a known destination: no dead /planners, /parejas or self-signup.
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
    const known = new Set<string>(["/", "#contenido", ...Object.values(MARKETING_LINKS)]);
    expect(hrefs.filter((href) => !known.has(href))).toEqual([]);

    // The in-page anchors exist.
    await expect(page.locator("#como-funciona")).toHaveCount(1);
    await expect(page.locator("#sitios-de-boda")).toHaveCount(1);

    // The five themes, named in text; their renders are hidden from assistive technology.
    const showcase = page.getByTestId("theme-showcase");
    for (const key of WEDDING_SITE_THEME_KEYS) {
      await expect(showcase.getByRole("heading", { level: 3, name: es.site.themes[key].name })).toBeVisible();
    }
    await expect(showcase.locator('[aria-hidden="true"][inert]')).toHaveCount(5);

    // Every product screenshot has Spanish alt text.
    const alts = await page.locator("main img").evaluateAll((images) => images.map((img) => img.getAttribute("alt") ?? ""));
    expect(alts.length).toBeGreaterThanOrEqual(6);
    for (const alt of alts) expect(alt.length).toBeGreaterThan(20);
  });

  test("keyboard: the skip link comes first and every header link is reachable with a visible focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: copy.skipToContent });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#contenido$/);

    await page.goto("/");
    await page.keyboard.press("Tab"); // skip link
    for (const name of [copy.brand, copy.nav.howItWorks, copy.nav.weddingSites, copy.nav.login, copy.cta.demo]) {
      await page.keyboard.press("Tab");
      const focused = page.getByRole("banner").getByRole("link", { name, exact: true });
      await expect(focused).toBeFocused();
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    }
  });

  test("phone menu: a native disclosure, operable by keyboard, with the same links", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const menu = page.getByRole("banner").locator("summary");
    await expect(menu).toHaveText(new RegExp(copy.nav.menu));
    const login = page.getByRole("banner").getByRole("link", { name: copy.nav.login });
    await expect(login).toBeHidden();
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(login).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: copy.cta.demo })).toHaveAttribute("href", MARKETING_LINKS.DEMO);
    await page.keyboard.press("Enter");
    await expect(login).toBeHidden();
  });

  test("fits 360, 390, 768 and 1280 px in light and dark, with AA text everywhere", async ({ browser }, testInfo) => {
    // Eight full-page renders and screenshots.
    test.setTimeout(180_000);
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        // Scroll through, as a reader would, so lazy screenshots load; all of them must.
        await page.evaluate(async () => {
          for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
            window.scrollTo(0, y);
            await new Promise((done) => setTimeout(done, 40));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForLoadState("networkidle");
        await expect
          .poll(() => page.locator("main img").evaluateAll((images) => images.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)))
          .toBe(true);
        const result = await measure(page);
        expect(result.scrolls, `${colorScheme} ${width}px: no horizontal scroll`).toBe(false);
        expect(result.lowContrast, `${colorScheme} ${width}px: WCAG AA text`).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`home-${colorScheme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  });

  test("ships no page-specific client JavaScript: the menu and the showcase work without it", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(copy.home.hero.title);
    await page.getByRole("banner").locator("summary").click();
    await expect(page.getByRole("banner").getByRole("link", { name: copy.nav.login })).toBeVisible();
    await expect(page.getByTestId("theme-showcase-item")).toHaveCount(5);
    await context.close();
  });
});
