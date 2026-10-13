import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";

import { THEME_FIXTURES } from "./fixtures/wedding-site-themes";

/**
 * Markup snapshots of the non-Classic themes (ADR-019, CP2/CP3) for every theme
 * fixture. They pin each theme's markup and are the exact documents the E2E
 * visual check (`e2e/wedding-site-themes.spec.ts`) draws with the production
 * stylesheet. Unlike Classic's golden files, these follow deliberate design
 * changes: update them with `vitest -u` only when a theme's look is meant to
 * change, and review the screenshots.
 */
describe.each(["editorial", "minimal", "romantic", "tropical"] as const)("%s markup", (theme) => {
  it.each(Object.entries(THEME_FIXTURES))("%s", async (name, site) => {
    const html = renderToStaticMarkup(createElement(WeddingSite, { site, design: resolveSiteDesign(theme) }));
    await expect(html).toMatchFileSnapshot(`./__golden__/wedding-site-themes/${theme}-${name}.html`);
  });
});
