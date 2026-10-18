import { expect, test } from "@playwright/test";

import { LEGAL_LINKS } from "../src/lib/legal/links";
import { MARKETING_LINKS } from "../src/lib/marketing/links";
import { WEDDING_SITE_THEME_KEYS } from "../src/lib/wedding-site/design/themes";
import { es } from "./support/flows";
import { loadEveryImage, measure } from "./support/marketing";

// Marketing Landing V1 (MKT-3): /parejas, the page for couples, and the
// marketing system around it (shared navigation, robots.txt). Static, public,
// not indexed yet; asking for access leads.

const copy = es.marketing;
const page$ = copy.couples;
const WIDTHS = [360, 390, 768, 1280] as const;
// ACCOUNT-01: only the two audience pages; `/` redirects to /planners.
const MARKETING_PAGES = [MARKETING_LINKS.PLANNERS, MARKETING_LINKS.COUPLES] as const;

test.describe("marketing /parejas", () => {
  test("one h1, noindex, access first, the planner switch, no dead links, five themes", async ({ page }) => {
    const response = await page.goto("/parejas");
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page$.hero.title);
    await expect(page).toHaveTitle(page$.metadata.title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", page$.metadata.description);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", page$.metadata.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:image"], meta[property="og:url"]')).toHaveCount(0);
    await expect(page.locator("main#contenido")).toHaveCount(1);

    // The hero: access first, then how it works (an anchor on this page), then the planner switch.
    const heroLinks = page.locator("#inicio").getByRole("link");
    await expect(heroLinks.nth(0)).toHaveText(copy.cta.access);
    await expect(heroLinks.nth(0)).toHaveAttribute("href", MARKETING_LINKS.ACCESS);
    await expect(heroLinks.nth(1)).toHaveText(copy.cta.howItWorks);
    await expect(heroLinks.nth(1)).toHaveAttribute("href", MARKETING_LINKS.HOW_IT_WORKS);
    await expect(heroLinks.nth(2)).toHaveAccessibleName(page$.hero.plannerLink);
    await expect(heroLinks.nth(2)).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
    await expect(page.locator("#como-funciona")).toHaveCount(1);
    for (const link of await page.locator("main").getByRole("link", { name: copy.cta.access }).all()) {
      await expect(link).toHaveAttribute("href", MARKETING_LINKS.ACCESS);
    }

    // Every link is a known destination: never self-signup.
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
    const known = new Set<string>(["#contenido", "#como-funciona", ...Object.values(MARKETING_LINKS), LEGAL_LINKS.TERMS, LEGAL_LINKS.REFUNDS, LEGAL_LINKS.PRIVACY]);
    expect(hrefs.filter((href) => !known.has(href))).toEqual([]);

    // Never the planners' multi-wedding screen.
    await expect(page.getByText("Mis bodas")).toHaveCount(0);

    // The five themes, named in text; every site render is hidden from assistive technology.
    const showcase = page.getByTestId("theme-showcase");
    await expect(page.getByTestId("theme-showcase-item")).toHaveCount(5);
    for (const key of WEDDING_SITE_THEME_KEYS) {
      await expect(showcase.getByRole("heading", { level: 3, name: es.site.themes[key].name })).toBeVisible();
    }
    await expect(page.locator('main [aria-hidden="true"][inert]')).toHaveCount(2 + 5);

    // Every product screenshot has Spanish alt text, and none repeats.
    const images = await page
      .locator("main img:not([data-lifestyle])")
      .evaluateAll((elements) => elements.map((img) => ({ alt: img.getAttribute("alt") ?? "", src: img.getAttribute("src") ?? "" })));
    expect(images.length).toBe(5);
    for (const { alt } of images) expect(alt.length).toBeGreaterThan(20);
    expect(new Set(images.map(({ src }) => src)).size).toBe(images.length);
  });

  test("the header and footer reach every marketing page, and no internal link is dead", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of MARKETING_PAGES) {
      await page.goto(path);
      const banner = page.getByRole("banner");
      const footer = page.getByRole("contentinfo");
      await expect(banner.getByRole("link", { name: copy.brand })).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
      for (const region of [banner, footer]) {
        await expect(region.getByRole("link", { name: copy.nav.planners })).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
        await expect(region.getByRole("link", { name: copy.nav.couples })).toHaveAttribute("href", MARKETING_LINKS.COUPLES);
        await expect(region.getByRole("link", { name: copy.nav.login })).toHaveAttribute("href", MARKETING_LINKS.LOGIN);
        await expect(region.getByRole("link", { name: copy.cta.demo })).toHaveAttribute("href", MARKETING_LINKS.DEMO);
      }

      // Every internal link resolves: pages answer 200, anchors exist where they point.
      const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
      for (const href of new Set(hrefs)) {
        if (href.startsWith("mailto:")) continue;
        const [pathname, hash] = href.split("#");
        if (pathname) expect((await request.get(pathname)).status(), `${path} → ${href}`).toBe(200);
        if (hash) {
          if (pathname && pathname !== path) await page.goto(pathname);
          await expect(page.locator(`#${hash}`), `${path} → ${href}`).toHaveCount(1);
          if (pathname && pathname !== path) await page.goto(path);
        }
      }
    }

    // Moving between the audience pages through the header.
    await page.goto("/");
    await expect(page).toHaveURL(/\/planners$/);
    await page.getByRole("banner").getByRole("link", { name: copy.nav.couples }).click();
    await expect(page).toHaveURL(/\/parejas$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page$.hero.title);
    await page.getByRole("banner").getByRole("link", { name: copy.nav.planners }).click();
    await expect(page).toHaveURL(/\/planners$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(copy.planners.hero.title);
    await page.getByRole("banner").getByRole("link", { name: copy.nav.couples }).click();
    await expect(page).toHaveURL(/\/parejas$/);
    await page.getByRole("banner").getByRole("link", { name: copy.brand }).click();
    await expect(page).toHaveURL(/\/planners$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(copy.planners.hero.title);
  });

  test("the FAQ opens and closes by keyboard, with a visible focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/parejas");
    const faq = page.getByTestId("faq-list");
    await expect(faq.locator("details")).toHaveCount(page$.faq.items.length);
    const summary = faq.locator("summary").first();
    const answer = faq.getByText(page$.faq.items[0].answer);
    await expect(answer).toBeHidden();
    await summary.focus();
    expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await expect(answer).toBeVisible();
    await page.keyboard.press("Space");
    await expect(answer).toBeHidden();
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
        await page.goto("/parejas");
        await loadEveryImage(page);
        const result = await measure(page);
        expect(result.scrolls, `${colorScheme} ${width}px: no horizontal scroll`).toBe(false);
        expect(result.lowContrast, `${colorScheme} ${width}px: WCAG AA text`).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`couples-${colorScheme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  });

  test("works without JavaScript: the story, the calls to action, the menu, the FAQ and the themes", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/parejas");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page$.hero.title);
    for (const title of [
      page$.checklist.title,
      page$.guests.title,
      page$.seating.title,
      page$.plan.title,
      page$.sites.title,
      page$.together.title,
      page$.closing.title,
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    await expect(page.locator("main").getByRole("link", { name: copy.cta.access }).first()).toHaveAttribute("href", MARKETING_LINKS.ACCESS);
    await page.getByRole("banner").locator("summary").click();
    await expect(page.getByRole("banner").getByRole("link", { name: copy.nav.planners })).toBeVisible();
    const faq = page.getByTestId("faq-list");
    await faq.locator("summary").first().click();
    await expect(faq.getByText(page$.faq.items[0].answer)).toBeVisible();
    await expect(page.getByTestId("theme-showcase-item")).toHaveCount(5);
    await context.close();
  });

  test("robots.txt keeps private surfaces out and names no sitemap or host", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("User-Agent: *");
    expect(body).toContain("Allow: /\n");
    for (const path of ["/app", "/auth", "/invite", "/rsvp", "/api"]) expect(body).toContain(`Disallow: ${path}\n`);
    expect(body).not.toMatch(/Disallow: \/(\n|$)|Disallow: \/boda|Disallow: \/parejas|Disallow: \/planners/);
    expect(body).not.toMatch(/Sitemap:|Host:|vercel\.app/);
    // No sitemap until the production domain is connected.
    expect((await request.get("/sitemap.xml")).status()).toBe(404);
  });
});
