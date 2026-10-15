import { expect, test } from "@playwright/test";

import { MARKETING_LINKS } from "../src/lib/marketing/links";
import { es } from "./support/flows";
import { loadEveryImage } from "./support/marketing";

// Marketing Landing V1 (MKT-1) and ACCOUNT-01: the shared marketing shell.
// There are two landings, /planners and /parejas; `/` redirects to /planners.
// Static, public, not indexed yet; every call to action comes from the
// central links module.

const copy = es.marketing;

test.describe("marketing shell", () => {
  test("the header exposes exactly the two audiences, how it works and login; no generic homepage", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of [MARKETING_LINKS.PLANNERS, MARKETING_LINKS.COUPLES]) {
      await page.goto(path);
      const nav = page.getByRole("banner").getByRole("navigation", { name: copy.nav.label });
      const links = nav.locator("ul").first().getByRole("link");
      await expect(links).toHaveText([copy.nav.planners, copy.nav.couples, copy.nav.howItWorks, copy.nav.login, copy.cta.demo]);
      await expect(page.getByRole("banner").getByRole("link", { name: copy.brand })).toHaveAttribute("href", MARKETING_LINKS.PLANNERS);
      const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
      expect(hrefs, path).not.toContain("/");
      expect(hrefs, path).not.toContain("/signup");
    }
  });

  test("\"Cómo funciona\" scrolls to the current page's section, which shows both paths, its own audience first", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const [path, first, second] of [
      [MARKETING_LINKS.PLANNERS, "planner", "couple"],
      [MARKETING_LINKS.COUPLES, "couple", "planner"],
    ] as const) {
      await page.goto(path);
      await page.getByRole("banner").getByRole("link", { name: copy.nav.howItWorks }).click();
      await expect(page).toHaveURL(new RegExp(`${path}#como-funciona$`));
      const section = page.getByTestId("how-it-works");
      await expect(section).toBeInViewport();
      await expect(section.getByRole("heading", { level: 2 })).toHaveText(copy.howItWorks.title);
      await expect(section.locator("[data-audience]")).toHaveCount(2);
      await expect(section.locator("[data-audience]").nth(0)).toHaveAttribute("data-audience", first);
      await expect(section.locator("[data-audience]").nth(1)).toHaveAttribute("data-audience", second);
      for (const audience of [first, second]) {
        const steps = section.locator(`[data-audience="${audience}"] li`);
        await expect(steps).toHaveCount(4);
        await expect(steps).toContainText([...copy.howItWorks[audience].steps]);
      }
    }
  });

  test("keyboard: the skip link comes first and every header link is reachable with a visible focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MARKETING_LINKS.PLANNERS);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: copy.skipToContent });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#contenido$/);

    await page.goto(MARKETING_LINKS.PLANNERS);
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
    await page.goto(MARKETING_LINKS.PLANNERS);
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
});

// MKT-5: wedding photography and restrained motion, CSS only.
test.describe("marketing photography and motion", () => {
  const PAGES = ["/planners", "/parejas"] as const;

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
