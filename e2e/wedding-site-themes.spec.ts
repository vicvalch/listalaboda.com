import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { WeddingSiteThemeKey } from "../src/lib/wedding-site/design/themes";
import { THEME_FIXTURES } from "../src/test/fixtures/wedding-site-themes";

// ADR-019 CP2: Editorial and Minimal exist in code only. Nothing in the app
// stores or selects a theme, so no route can draw them. Instead, this check
// takes the real `WeddingSite` markup for each fixture (rendered by Vitest
// into src/test/__golden__/wedding-site-themes/, which fails if the renderer's
// output and those files ever differ) and shows it in a page styled by the
// production build's own stylesheet, taken from a real /boda response.
// Nothing test-only ships with the app.

type Palette = { background: string; foreground: string; font: (family: string) => boolean };

const serif = (family: string) => family.startsWith("ui-serif, Georgia") && family.endsWith("serif");
const sans = (family: string) => !family.includes("Georgia") && family.includes("sans-serif");

const THEMES: Record<Exclude<WeddingSiteThemeKey, "classic">, Record<"light" | "dark", Palette>> = {
  editorial: {
    light: { background: "rgb(251, 248, 242)", foreground: "rgb(31, 27, 22)", font: serif },
    dark: { background: "rgb(21, 19, 15)", foreground: "rgb(237, 230, 217)", font: serif },
  },
  minimal: {
    light: { background: "rgb(255, 255, 255)", foreground: "rgb(17, 17, 17)", font: sans },
    dark: { background: "rgb(15, 15, 16)", foreground: "rgb(242, 242, 242)", font: sans },
  },
};

const WIDTHS = [360, 390, 1280] as const;

/** The production stylesheets, as absolute URLs, from a real public-site response. */
async function appStylesheets(page: Page): Promise<string[]> {
  await page.goto("/boda/tema-de-prueba-inexistente");
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => (link as HTMLLinkElement).href),
  );
  expect(hrefs.length, "the build serves a stylesheet").toBeGreaterThan(0);
  return hrefs;
}

/** The document the root layout produces, around the themed site's markup. */
function documentFor(stylesheets: string[], fixture: string, theme: WeddingSiteThemeKey): string {
  const body = readFileSync(resolve(process.cwd(), `src/test/__golden__/wedding-site-themes/${theme}-${fixture}.html`), "utf8");
  const links = stylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
  return (
    `<!doctype html><html lang="es" class="h-full antialiased"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${links}</head>` +
    `<body class="flex min-h-full flex-col">${body}</body></html>`
  );
}

for (const [theme, palettes] of Object.entries(THEMES) as Array<[keyof typeof THEMES, (typeof THEMES)["editorial"]]>) {
  test(`${theme}: every fixture fits 360, 390 and 1280 px in light and dark, with the theme's palette and type`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      // The stylesheets are read on their own page, so its app scripts can't
      // add requests to the themed pages below.
      const source = await context.newPage();
      const stylesheets = await appStylesheets(source);
      await source.close();
      const page = await context.newPage();
      // The page may load the app's own stylesheets and nothing else: no fonts,
      // images or scripts from anywhere, and nothing off this origin.
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        for (const [name, site] of Object.entries(THEME_FIXTURES)) {
          const label = `${theme} ${colorScheme} ${width}px ${name}`;
          await page.setContent(documentFor(stylesheets, name, theme), { waitUntil: "load" });

          await expect(page.getByRole("heading", { level: 1, name: site.name }), label).toBeVisible();
          const kinds = await page
            .locator('[data-testid="public-site-section"]')
            .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-kind")));
          expect(kinds, label).toEqual(site.sections.map((section) => section.kind));

          const layout = await page.evaluate(() => {
            const root = document.documentElement;
            const overflowing = [...document.querySelectorAll("main *")]
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.left < -0.5 || rect.right > root.clientWidth + 0.5);
              })
              .map((element) => element.tagName.toLowerCase());
            const main = document.querySelector("main") as HTMLElement;
            const h1 = document.querySelector("h1") as HTMLElement;
            return {
              scrolls: root.scrollWidth > root.clientWidth,
              overflowing,
              background: getComputedStyle(main).backgroundColor,
              foreground: getComputedStyle(h1).color,
              font: getComputedStyle(h1).fontFamily,
              fillsViewport: main.getBoundingClientRect().height >= window.innerHeight - 1,
            };
          });
          expect(layout.scrolls, `${label}: no horizontal scroll`).toBe(false);
          expect(layout.overflowing, `${label}: nothing sticks out of the screen`).toEqual([]);
          expect(layout.background, label).toBe(palettes[colorScheme].background);
          expect(layout.foreground, label).toBe(palettes[colorScheme].foreground);
          expect(palettes[colorScheme].font(layout.font), `${label}: ${layout.font}`).toBe(true);
          expect(layout.fillsViewport, `${label}: the theme's background covers the page`).toBe(true);

          await page.screenshot({ path: testInfo.outputPath(`${theme}-${colorScheme}-${width}-${name}.png`), fullPage: true });
        }
      }

      for (const url of requests) {
        expect(url.startsWith(`${baseURL}/_next/static/`), `only the app's static stylesheet: ${url}`).toBe(true);
        expect(url.endsWith(".css"), `only stylesheets: ${url}`).toBe(true);
      }
      await context.close();
    }
  });
}
