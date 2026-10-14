import { expect, test } from "@playwright/test";

import { MARKETING_LINKS } from "../src/lib/marketing/links";
import { WEDDING_SITE_THEME_KEYS } from "../src/lib/wedding-site/design/themes";
import { es } from "./support/flows";
import { loadEveryImage, measure } from "./support/marketing";

// Marketing Landing V1 (MKT-1): the planner-first homepage. Static, public,
// not indexed yet; every call to action comes from the central links module.

const copy = es.marketing;
const WIDTHS = [360, 390, 768, 1280] as const;

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
    // MKT-3: the couples' question leads to their own page.
    await expect(main.getByRole("link", { name: copy.home.hero.couplesLink, exact: true })).toHaveAttribute("href", MARKETING_LINKS.COUPLES);
    // MKT-4A: the couple's site is the bridge to their page; the money section leads planners to theirs.
    await expect(main.getByRole("link", { name: copy.home.weddingSites.couplesLink })).toHaveAttribute("href", MARKETING_LINKS.COUPLES);
    await expect(main.getByRole("link", { name: copy.home.moneyDay.more })).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
    await expect(main.getByRole("link", { name: copy.cta.pilot })).toHaveAttribute("href", MARKETING_LINKS.PILOT);
    await expect(page.getByRole("banner").getByRole("link", { name: copy.nav.login })).toHaveAttribute("href", MARKETING_LINKS.LOGIN);

    // Every link on the page is a known destination: never self-signup.
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
    const alts = await page.locator("main img:not([data-lifestyle])").evaluateAll((images) => images.map((img) => img.getAttribute("alt") ?? ""));
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
    for (const name of [copy.brand, copy.nav.planners, copy.nav.couples, copy.nav.howItWorks, copy.nav.login, copy.cta.demo]) {
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
        await loadEveryImage(page);
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

// MKT-5: wedding photography and restrained motion, CSS only.
test.describe("marketing photography and motion", () => {
  const PAGES = ["/", "/planners", "/parejas"] as const;

  test("every photo used loads, and the invented-interface photo is never served", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of PAGES) {
      await page.goto(path);
      await loadEveryImage(page);
      const sources = await page
        .locator("main img[data-lifestyle]")
        .evaluateAll((images) => images.flatMap((img) => (img.getAttribute("srcset") ?? "").split(",").map((s) => s.trim().split(" ")[0])));
      expect(sources.length, path).toBeGreaterThan(0);
      for (const src of new Set(sources)) expect((await request.get(src)).status(), `${path} ${src}`).toBe(200);
      expect(await page.content()).not.toContain("product-context");
    }
    expect((await request.get("/marketing/lifestyle/product-context.png")).status()).toBe(404);
  });

  test("decorative photos stay out of the accessibility tree", async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      const exposed = await page
        .locator('main img[data-lifestyle][alt=""]')
        .evaluateAll((images) => images.filter((img) => !img.closest('[aria-hidden="true"]')).length);
      expect(exposed, path).toBe(0);
    }
  });

  test("prefers-reduced-motion removes every drift, float, reveal and hover movement", async ({ browser }) => {
    const motion = async (reducedMotion: "reduce" | "no-preference") => {
      const context = await browser.newContext({ reducedMotion, viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto("/parejas");
      const result = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        return {
          drift: style(".mkt-drift img").animationName,
          float: style(".mkt-float").animationName,
          zoom: style(".mkt-zoom img").transitionProperty,
          button: style("main a.inline-flex").transitionProperty,
        };
      });
      await context.close();
      return result;
    };
    const moving = await motion("no-preference");
    expect(moving.drift).toBe("mkt-drift");
    expect(moving.float).toBe("mkt-float");
    expect(moving.zoom).toContain("scale");
    expect(moving.button).toContain("translate");

    const still = await motion("reduce");
    expect(still).toEqual({ drift: "none", float: "none", zoom: expect.not.stringContaining("scale"), button: expect.not.stringContaining("translate") });
  });
});
