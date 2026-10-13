import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";

import { CUSTOMIZATION_FIXTURES } from "./fixtures/wedding-site-customizations";
import { THEME_FIXTURES } from "./fixtures/wedding-site-themes";

/**
 * Markup snapshots of customized designs (ADR-019, CP6) on the full fixture:
 * every palette preset and each theme's all-alternatives design. They are
 * the exact documents the E2E visual check (`e2e/wedding-site-themes.spec.ts`)
 * draws with the production stylesheet. Update with `vitest -u` only when a
 * customized look is meant to change, and review the screenshots.
 */
describe("customized markup", () => {
  it.each(CUSTOMIZATION_FIXTURES.map((fixture) => [fixture.name, fixture] as const))("%s", async (name, fixture) => {
    const html = renderToStaticMarkup(
      createElement(WeddingSite, { site: THEME_FIXTURES.full, design: resolveSiteDesign(fixture.theme, fixture.overrides) }),
    );
    await expect(html).toMatchFileSnapshot(`./__golden__/wedding-site-customized/${name}.html`);
  });
});
