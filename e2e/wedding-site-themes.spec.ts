import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { THEME_REGISTRY, type WeddingSiteThemeKey } from "../src/lib/wedding-site/design/themes";
import { CUSTOMIZATION_FIXTURES } from "../src/test/fixtures/wedding-site-customizations";
import { THEME_FIXTURES } from "../src/test/fixtures/wedding-site-themes";

// ADR-019 CP2/CP3: the non-Classic themes exist in code only. Nothing in the app
// stores or selects a theme, so no route can draw them. Instead, this check
// takes the real `WeddingSite` markup for each fixture (rendered by Vitest
// into src/test/__golden__/wedding-site-themes/, which fails if the renderer's
// output and those files ever differ) and shows it in a page styled by the
// production build's own stylesheet, taken from a real /boda response.
// Nothing test-only ships with the app. CP6 adds the customized designs
// (src/test/__golden__/wedding-site-customized/), checked the same way.

/** Page background, the couple's name color and the section text color. */
type Palette = { background: string; name: string; text: string };
type Family = (family: string) => boolean;
type ThemeExpectation = {
  /** Fonts of the name (and section headings) and of the section text. */
  heading: Family;
  body: Family;
  italicHeading: boolean;
  light: Palette;
  dark: Palette;
};

const serif: Family = (family) => family.startsWith("ui-serif, Georgia") && family.endsWith("serif");
const sans: Family = (family) => !family.includes("Georgia") && family.includes("sans-serif");

const THEMES: Record<Exclude<WeddingSiteThemeKey, "classic">, ThemeExpectation> = {
  editorial: {
    heading: serif,
    body: serif,
    italicHeading: false,
    light: { background: "rgb(251, 248, 242)", name: "rgb(31, 27, 22)", text: "rgb(31, 27, 22)" },
    dark: { background: "rgb(21, 19, 15)", name: "rgb(237, 230, 217)", text: "rgb(237, 230, 217)" },
  },
  minimal: {
    heading: sans,
    body: sans,
    italicHeading: false,
    light: { background: "rgb(255, 255, 255)", name: "rgb(17, 17, 17)", text: "rgb(17, 17, 17)" },
    dark: { background: "rgb(15, 15, 16)", name: "rgb(242, 242, 242)", text: "rgb(242, 242, 242)" },
  },
  romantic: {
    heading: serif,
    body: serif,
    italicHeading: true,
    light: { background: "rgb(250, 245, 241)", name: "rgb(43, 29, 31)", text: "rgb(43, 29, 31)" },
    dark: { background: "rgb(28, 21, 23)", name: "rgb(242, 232, 229)", text: "rgb(242, 232, 229)" },
  },
  tropical: {
    heading: serif,
    body: sans,
    italicHeading: false,
    // The name sits on the green band, in the band's text color.
    light: { background: "rgb(245, 239, 227)", name: "rgb(245, 239, 227)", text: "rgb(31, 42, 36)" },
    dark: { background: "rgb(17, 24, 20)", name: "rgb(235, 231, 218)", text: "rgb(235, 231, 218)" },
  },
};

const WIDTHS = [360, 390, 768, 1280] as const;

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
  return wrapDocument(stylesheets, `wedding-site-themes/${theme}-${fixture}.html`);
}

/** A snapshot file (under src/test/__golden__/) inside the root layout's document. */
function wrapDocument(stylesheets: string[], snapshot: string): string {
  const body = readFileSync(resolve(process.cwd(), `src/test/__golden__/${snapshot}`), "utf8");
  const links = stylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
  return (
    `<!doctype html><html lang="es" class="h-full antialiased"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${links}</head>` +
    `<body class="flex min-h-full flex-col">${body}</body></html>`
  );
}

for (const [theme, expected] of Object.entries(THEMES) as Array<[keyof typeof THEMES, ThemeExpectation]>) {
  test(`${theme}: every fixture fits 360, 390, 768 and 1280 px in light and dark, readable and with the theme's palette and type`, async ({
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
          // Heading outline: the couple, then one heading per section; decorations add none.
          await expect(page.getByRole("heading"), label).toHaveCount(1 + site.sections.length);
          await expect(page.getByRole("heading", { level: 2 }), label).toHaveCount(site.sections.length);
          const kinds = await page
            .locator('[data-testid="public-site-section"]')
            .evaluateAll((sections) => sections.map((section) => section.getAttribute("data-kind")));
          expect(kinds, label).toEqual(site.sections.map((section) => section.kind));

          const layout = await measureLayout(page);
          expect(layout.scrolls, `${label}: no horizontal scroll`).toBe(false);
          expect(layout.overflowing, `${label}: nothing sticks out of the screen`).toEqual([]);
          expect(layout.background, label).toBe(expected[colorScheme].background);
          expect(layout.name, label).toBe(expected[colorScheme].name);
          expect(layout.text, label).toBe(expected[colorScheme].text);
          expect(expected.heading(layout.headingFont), `${label}: ${layout.headingFont}`).toBe(true);
          expect(expected.body(layout.bodyFont), `${label}: ${layout.bodyFont}`).toBe(true);
          expect(layout.headingStyle, label).toBe(expected.italicHeading ? "italic" : "normal");
          expect(layout.lowContrast, `${label}: every text meets WCAG AA (4.5:1)`).toEqual([]);
          expect(layout.unselectable, `${label}: text stays selectable`).toBe(0);
          expect(layout.decorationsExposed, `${label}: ornaments are hidden from assistive technology`).toBe(0);
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

/** What the checks read from a drawn site: overflow, colors, fonts, contrast, decorations. */
async function measureLayout(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const overflowing = [...document.querySelectorAll("main *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -0.5 || rect.right > root.clientWidth + 0.5);
      })
      .map((element) => element.tagName.toLowerCase());
    const main = document.querySelector("main") as HTMLElement;
    const h1 = document.querySelector("h1") as HTMLElement;
    const body = document.querySelector('[data-testid="public-site-section"] p') as HTMLElement;

    // WCAG contrast of every element that holds text, against the
    // nearest painted background behind it.
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
      return [255, 255, 255];
    };
    const lowContrast = [...document.querySelectorAll("main *")]
      .filter((element) => [...element.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
      .map((element) => {
        const [a, b] = [luminance(rgb(getComputedStyle(element).color)), luminance(backgroundOf(element))];
        return { element: element.tagName.toLowerCase(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ element, ratio }) => `${element} ${ratio.toFixed(2)}`);

    const textElements = [...document.querySelectorAll("main h1, main h2, main p, main time")];
    return {
      scrolls: root.scrollWidth > root.clientWidth,
      overflowing,
      background: getComputedStyle(main).backgroundColor,
      name: getComputedStyle(h1).color,
      text: getComputedStyle(body).color,
      headingFont: getComputedStyle(h1).fontFamily,
      headingStyle: getComputedStyle(h1).fontStyle,
      bodyFont: getComputedStyle(body).fontFamily,
      lowContrast,
      unselectable: textElements.filter((element) => getComputedStyle(element).userSelect === "none").length,
      decorationsExposed: [...document.querySelectorAll("main svg")].filter(
        (svg) => svg.getAttribute("aria-hidden") !== "true",
      ).length,
      fillsViewport: main.getBoundingClientRect().height >= window.innerHeight - 1,
    };
  });
}

// ADR-019 CP6: customized designs (every palette preset, and each theme with
// the last option of every field), same document, same checks: no overflow,
// WCAG AA text in light and dark, hidden decorations, the palette's scope.
for (const fixture of CUSTOMIZATION_FIXTURES) {
  test(`customized ${fixture.name}: fits 360, 390, 768 and 1280 px in light and dark, readable`, async ({ browser }, testInfo) => {
    const palette = fixture.overrides.palette ?? THEME_REGISTRY[fixture.theme].palette;
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const source = await context.newPage();
      const stylesheets = await appStylesheets(source);
      await source.close();
      const page = await context.newPage();
      for (const width of WIDTHS) {
        const label = `${fixture.name} ${colorScheme} ${width}px`;
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(wrapDocument(stylesheets, `wedding-site-customized/${fixture.name}.html`), { waitUntil: "load" });
        await expect(page.getByRole("heading", { level: 1, name: THEME_FIXTURES.full.name }), label).toBeVisible();
        if (palette === "app") await expect(page.locator("main"), label).not.toHaveAttribute("data-site-palette", /.*/);
        else await expect(page.locator("main"), label).toHaveAttribute("data-site-palette", palette);
        const layout = await measureLayout(page);
        expect(layout.scrolls, `${label}: no horizontal scroll`).toBe(false);
        expect(layout.overflowing, `${label}: nothing sticks out of the screen`).toEqual([]);
        expect(layout.lowContrast, `${label}: every text meets WCAG AA (4.5:1)`).toEqual([]);
        expect(layout.decorationsExposed, `${label}: ornaments are hidden from assistive technology`).toBe(0);
        if (palette !== "app") expect(layout.fillsViewport, `${label}: the palette's background covers the page`).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${fixture.name}-${colorScheme}-${width}.png`), fullPage: true });
      }
      await context.close();
    }
  });
}
