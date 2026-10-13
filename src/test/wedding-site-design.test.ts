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
} from "@/lib/wedding-site/design/themes";
import {
  SECTION_KINDS,
  toPublishedSite,
  type PublishedSiteRow,
  type PublishedWeddingSite,
} from "@/lib/wedding-site/sections";

function row(overrides: Partial<PublishedSiteRow>): PublishedSiteRow {
  return {
    wedding_name: "Sofía & Andrés",
    wedding_date: "2027-02-14",
    wedding_city: "San José",
    section_kind: null,
    section_title: null,
    section_body: null,
    ...overrides,
  };
}

function site(rows: PublishedSiteRow[]): PublishedWeddingSite {
  const built = toPublishedSite("sofia-y-andres", rows);
  if (!built) throw new Error("fixture has no rows");
  return built;
}

function render(content: PublishedWeddingSite, themeKey: string | null = null): string {
  return renderToStaticMarkup(createElement(WeddingSite, { site: content, design: resolveSiteDesign(themeKey) }));
}

describe("theme registry", () => {
  it("contains Classic, the default, and one definition per key", () => {
    expect(DEFAULT_WEDDING_SITE_THEME).toBe("classic");
    expect(Object.keys(THEME_REGISTRY).sort()).toEqual([...WEDDING_SITE_THEME_KEYS].sort());
    for (const key of WEDDING_SITE_THEME_KEYS) expect(THEME_REGISTRY[key].key).toBe(key);
  });

  it("recognizes only its own keys", () => {
    expect(isWeddingSiteThemeKey("classic")).toBe(true);
    for (const value of ["", "Classic", "editorial", "classic ", "__proto__", "toString", null, undefined, 1]) {
      expect(isWeddingSiteThemeKey(value)).toBe(false);
    }
  });

  it("no key or an unknown key is Classic, never an error", () => {
    for (const key of [null, undefined, "", "unknown", "__proto__", "constructor", "<script>"]) {
      expect(getTheme(key).key).toBe("classic");
      expect(resolveSiteDesign(key)).toEqual(resolveSiteDesign("classic"));
    }
  });

  it("resolves Classic to the original layout", () => {
    expect(resolveSiteDesign(null)).toEqual({
      themeKey: "classic",
      hero: "centered",
      width: "regular",
      sectionStyle: "plain",
    });
  });

  it("a theme holds closed presentation values only, no free text", () => {
    // Every value is one short lowercase identifier: no CSS, class names,
    // markup, URLs or wedding data can hide in a theme definition.
    for (const theme of Object.values(THEME_REGISTRY)) {
      for (const value of Object.values(theme)) expect(value).toMatch(/^[a-z]+$/);
    }
  });
});

describe("Classic renderer", () => {
  const FULL = site([
    row({ section_kind: "intro", section_title: "Nuestra historia", section_body: "Nos conocimos.\nY aquí estamos." }),
    row({ section_kind: "ceremony", section_body: "Iglesia de La Merced." }),
    row({ section_kind: "faq", section_body: "¿Niños? Sí." }),
    row({ section_kind: "rsvp", section_body: null }),
  ]);

  it("shows the name, the date and the city", () => {
    const html = render(FULL);
    expect(html).toContain("Sofía &amp; Andrés</h1>");
    expect(html).toContain('<time dateTime="2027-02-14">14 de febrero de 2027</time>');
    expect(html).toContain("San José");
  });

  it("leaves out the details line when there is no date and no city", () => {
    const html = render(site([row({ wedding_date: null, wedding_city: null })]));
    expect(html).not.toContain("public-site-details");
    expect(html).not.toContain("<time");
  });

  it("shows exactly the published sections, in the canonical order", () => {
    const html = render(FULL);
    const kinds = [...html.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["intro", "ceremony", "faq", "rsvp"]);
    expect(kinds).toEqual(SECTION_KINDS.filter((kind) => kinds.includes(kind)));
    expect(html).toContain("Nuestra historia");
    expect(html).toContain("Nos conocimos.\nY aquí estamos.");
  });

  it("never shows a section that isn't published or has nothing to show", () => {
    // The public read returns only visible sections; a body-less one (other
    // than RSVP) is dropped by the DTO and never reaches the renderer.
    const html = render(site([row({ section_kind: "ceremony", section_body: null }), row({ section_kind: "faq", section_body: "Sí." })]));
    expect(html).not.toContain('data-kind="ceremony"');
    expect(html).not.toContain('data-kind="reception"');
    expect(html).toContain('data-kind="faq"');
  });

  it("keeps HTML-looking user text as escaped text", () => {
    const html = render(
      site([
        row({
          wedding_name: '<img src=x onerror="alert(1)">',
          wedding_city: "<b>San José</b>",
          section_kind: "intro",
          section_title: "<script>alert(2)</script>",
          section_body: '</p><iframe src="https://evil.example"></iframe>',
        }),
      ]),
    );
    expect(html).not.toMatch(/<(img|script|iframe|b)[\s>]/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;/p&gt;&lt;iframe");
  });

  it("the RSVP section is guidance only: no RSVP link, form or guest data", () => {
    const html = render(FULL);
    expect(html).toContain("usa el enlace personal que recibiste con tu invitación");
    expect(html).not.toContain("/rsvp");
    expect(html).not.toMatch(/<(form|input|button|select|textarea)[\s>]/);
  });

  it("the design adds no links, external assets, scripts or inline styles", () => {
    const html = render(FULL);
    expect(html).not.toMatch(/<(a|link|script|iframe|img|style|object|embed)[\s>]/);
    expect(html).not.toMatch(/\s(href|src|style|on[a-z]+)=/);
    expect(html).not.toContain("http");
  });
});
