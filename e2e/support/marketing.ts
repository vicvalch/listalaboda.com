import { expect, type Page } from "@playwright/test";

// Shared checks of the marketing pages (Marketing Landing V1).

/**
 * Scrolls through the page, as a reader would, so lazy screenshots load;
 * every rendered one must. An image not laid out at this width (`display:
 * none`, e.g. a wide-screen-only layer) is never fetched, by design.
 */
export async function loadEveryImage(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((done) => setTimeout(done, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  await expect
    .poll(() =>
      page
        .locator("main img")
        .evaluateAll((images) =>
          images
            .filter((img) => img.getClientRects().length > 0)
            .every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
}

/** Overflow and WCAG AA contrast of every element holding text, against its painted background. */
export async function measure(page: Page) {
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

