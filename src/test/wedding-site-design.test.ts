import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import {
  DEFAULT_WEDDING_SITE_THEME,
  getTheme,
  isWeddingSiteThemeKey,
  THEME_REGISTRY,
  WEDDING_SITE_THEME_KEYS,
  type WeddingSiteThemeKey,
} from "@/lib/wedding-site/design/themes";
import { SECTION_KINDS, type PublishedWeddingSite } from "@/lib/wedding-site/sections";

import { FIXTURE_ROW as row, siteFrom, THEME_FIXTURES } from "./fixtures/wedding-site-themes";

function render(content: PublishedWeddingSite, themeKey: string | null = null): string {
  return renderToStaticMarkup(createElement(WeddingSite, { site: content, design: resolveSiteDesign(themeKey) }));
}

/** Every class attribute value in the markup. */
function classValues(html: string): string[] {
  return [...html.matchAll(/\sclass="([^"]*)"/g)].map((m) => m[1]);
}

describe("theme registry", () => {
  it("contains Classic (the default), Editorial and Minimal, one definition per key", () => {
    expect(DEFAULT_WEDDING_SITE_THEME).toBe("classic");
    expect([...WEDDING_SITE_THEME_KEYS].sort()).toEqual(["classic", "editorial", "minimal"]);
    expect(Object.keys(THEME_REGISTRY).sort()).toEqual([...WEDDING_SITE_THEME_KEYS].sort());
    for (const key of WEDDING_SITE_THEME_KEYS) expect(THEME_REGISTRY[key].key).toBe(key);
  });

  it("recognizes only its own keys", () => {
    for (const key of WEDDING_SITE_THEME_KEYS) expect(isWeddingSiteThemeKey(key)).toBe(true);
    for (const value of ["", "Classic", "EDITORIAL", "romantic", "tropical", "minimal ", "__proto__", "toString", null, undefined, 1]) {
      expect(isWeddingSiteThemeKey(value)).toBe(false);
    }
  });

  it("no key or an unknown key is Classic, never an error", () => {
    for (const key of [null, undefined, "", "unknown", "romantic", "__proto__", "constructor", "<script>"]) {
      expect(getTheme(key).key).toBe("classic");
      expect(resolveSiteDesign(key)).toEqual(resolveSiteDesign("classic"));
    }
  });

  it("resolves Classic to the original layout", () => {
    expect(resolveSiteDesign(null)).toEqual({
      themeKey: "classic",
      palette: "app",
      typography: "system",
      headingScale: "regular",
      hero: "simple",
      width: "regular",
      density: "regular",
      alignment: "center",
      sectionStyle: "plain",
      ornament: "none",
    });
  });

  it("resolves each known key to its own design", () => {
    for (const key of WEDDING_SITE_THEME_KEYS) {
      const { themeKey, ...values } = resolveSiteDesign(key);
      const { key: definitionKey, ...definition } = THEME_REGISTRY[key];
      expect(themeKey).toBe(key);
      expect(themeKey).toBe(definitionKey);
      expect(values).toEqual(definition);
    }
    expect(resolveSiteDesign("editorial")).not.toEqual(resolveSiteDesign("minimal"));
  });

  it("a theme holds closed presentation values only, no free text", () => {
    // Every value is one short lowercase identifier: no CSS, class names,
    // markup, URLs or wedding data can hide in a theme definition.
    for (const theme of Object.values(THEME_REGISTRY)) {
      for (const value of Object.values(theme)) expect(value).toMatch(/^[a-z]+$/);
    }
  });
});

describe("theme identity", () => {
  const html = (key: WeddingSiteThemeKey) => render(THEME_FIXTURES.full, key);

  it("Classic draws with the app palette and sets no palette scope", () => {
    expect(html("classic")).not.toContain("data-site-palette");
    expect(html("classic")).not.toContain("public-site-ornament");
  });

  it("Editorial uses its ivory palette and its decorative rule, hidden from assistive technology", () => {
    expect(html("editorial")).toContain('data-site-palette="ivory"');
    expect(html("editorial")).toMatch(/<svg aria-hidden="true" focusable="false"[^>]*data-testid="public-site-ornament"/);
  });

  it("Minimal uses its mono palette and no ornament", () => {
    expect(html("minimal")).toContain('data-site-palette="mono"');
    expect(html("minimal")).not.toContain("public-site-ornament");
  });

  it("the themes draw the same content differently", () => {
    const [classic, editorial, minimal] = (["classic", "editorial", "minimal"] as const).map(html);
    expect(new Set([classic, editorial, minimal]).size).toBe(3);
    const text = (markup: string) => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");
    expect(text(editorial)).toBe(text(classic));
    expect(text(minimal)).toBe(text(classic));
  });
});

describe.each(WEDDING_SITE_THEME_KEYS)("%s renderer", (key) => {
  const FULL = THEME_FIXTURES.full;

  it("shows the name, the date and the city", () => {
    const html = render(FULL, key);
    expect(html).toMatch(/Sofía &amp; Andrés<\/h1>/);
    expect(html).toContain('<time dateTime="2027-02-14">14 de febrero de 2027</time>');
    expect(html).toContain("San José");
  });

  it("leaves out the details line when there is no date and no city", () => {
    const html = render(siteFrom([row({ wedding_date: null, wedding_city: null })]), key);
    expect(html).not.toContain("public-site-details");
    expect(html).not.toContain("<time");
  });

  it("shows the city alone when there is no date", () => {
    const html = render(THEME_FIXTURES["no-date"], key);
    expect(html).not.toContain("<time");
    expect(html).toMatch(/data-testid="public-site-details"><span><span>San José<\/span><\/span><\/p>/);
  });

  it("shows exactly the published sections, in the canonical order", () => {
    const html = render(FULL, key);
    const kinds = [...html.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual([...SECTION_KINDS]);
    expect(html).toContain("Nuestra historia");
    expect(html).toContain("15:00 Ceremonia\n17:00 Recepción\n23:00 Cierre");
    // Each section is named by its own heading.
    for (const kind of SECTION_KINDS) {
      expect(html).toContain(`aria-labelledby="public-${kind}-title"`);
      expect(html).toContain(`id="public-${kind}-title"`);
    }
  });

  it("never shows a section that isn't published or has nothing to show", () => {
    // The public read returns only visible sections; a body-less one (other
    // than RSVP) is dropped by the DTO and never reaches the renderer.
    const html = render(
      siteFrom([row({ section_kind: "ceremony", section_body: null }), row({ section_kind: "faq", section_body: "Sí." })]),
      key,
    );
    expect(html).not.toContain('data-kind="ceremony"');
    expect(html).not.toContain('data-kind="reception"');
    expect(html).toContain('data-kind="faq"');
  });

  it("keeps long names, long cities and multi-line text whole", () => {
    expect(render(THEME_FIXTURES["long-name"], key)).toContain(
      "Maximiliano Fernández-Altamirano &amp; Guadalupe Villalobos-Quesada</h1>",
    );
    expect(render(THEME_FIXTURES["long-city"], key)).toContain(
      "Santa María de los Ángeles de Monteverde, Puntarenas, Costa Rica",
    );
    expect(render(THEME_FIXTURES.multiline, key)).toContain("23:30 Cierre\n\nPor favor, llega con tiempo");
  });

  it("keeps HTML-looking user text as escaped text", () => {
    const html = render(
      siteFrom([
        row({
          wedding_name: '<img src=x onerror="alert(1)">',
          wedding_city: "<b>San José</b>",
          section_kind: "intro",
          section_title: "<script>alert(2)</script>",
          section_body: '</p><iframe src="https://evil.example"></iframe>',
        }),
      ]),
      key,
    );
    expect(html).not.toMatch(/<(img|script|iframe|b)[\s>]/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;San José&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;/p&gt;&lt;iframe");
  });

  it("never turns user text into classes, styles or attributes", () => {
    const injected = 'bg-red-500 " style="color:red" class="x';
    const html = render(
      siteFrom([
        row({
          wedding_name: injected,
          wedding_city: "[color:red] hidden",
          section_kind: "intro",
          section_title: "font-serif",
          section_body: 'data-site-palette="mono"',
        }),
      ]),
      key,
    );
    for (const value of classValues(html)) {
      expect(value).not.toMatch(/bg-red-500|color:red|hidden|"/);
    }
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain("bg-red-500 &quot; style=&quot;color:red&quot; class=&quot;x</h1>");
    expect(html.match(/\sdata-site-palette=/g)?.length ?? 0).toBe(key === "classic" ? 0 : 1);
  });

  it("the RSVP section is guidance only: no RSVP link, form or guest data", () => {
    const html = render(FULL, key);
    expect(html).toContain("usa el enlace personal que recibiste con tu invitación");
    expect(html).not.toContain("/rsvp");
    expect(html).not.toMatch(/<(form|input|button|select|textarea)[\s>]/);
  });

  it("adds no links, external assets, scripts, frames or inline styles", () => {
    const html = render(FULL, key);
    expect(html).not.toMatch(/<(a|link|script|iframe|img|style|object|embed|use|image|foreignObject)[\s>]/);
    expect(html).not.toMatch(/\s(href|src|srcset|style|xlink:href|on[a-z]+)=/);
    expect(html).not.toContain("http");
    expect(html).not.toContain("url(");
  });
});
