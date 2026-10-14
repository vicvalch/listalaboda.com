import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The marketing pages never touch Supabase, a session or the database: any
// import of those modules fails this file outright.
vi.mock("@supabase/supabase-js", () => {
  throw new Error("marketing must not import supabase-js");
});
vi.mock("@supabase/ssr", () => {
  throw new Error("marketing must not import @supabase/ssr");
});
vi.mock("@/lib/supabase/server", () => {
  throw new Error("marketing must not read a session");
});
vi.mock("next/headers", () => {
  throw new Error("marketing must not read cookies or headers");
});

const { FaqList } = await import("@/components/marketing/FaqList");
const { MarketingFooter } = await import("@/components/marketing/MarketingFooter");
const { MarketingHeader } = await import("@/components/marketing/MarketingHeader");
const { Section } = await import("@/components/marketing/Section");
const { ThemeShowcase } = await import("@/components/marketing/ThemeShowcase");
const { getMessages } = await import("@/lib/i18n");
const { MARKETING_CONTACT_EMAIL, MARKETING_LINKS } = await import("@/lib/marketing/links");
const { SHOWCASE_SITE } = await import("@/lib/marketing/showcase");
const { WEDDING_SITE_THEME_KEYS } = await import("@/lib/wedding-site/design/themes");
// Importing the page itself proves its whole module graph stays clear of the mocks above.
const { default: PlannersPage, metadata: plannersMetadata } = await import("@/app/(marketing)/planners/page");

const render = (element: ReactElement) => renderToStaticMarkup(element);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
const copy = getMessages();

describe("marketing links (MKT-1)", () => {
  it("are the approved destinations, in one place", () => {
    expect(MARKETING_LINKS).toEqual({
      LOGIN: "/login",
      DEMO: "mailto:vicvalch@onchainfest.xyz?subject=Solicitud%20de%20demo%20-%20listalaboda.com",
      PILOT: "mailto:vicvalch@onchainfest.xyz?subject=Aplicaci%C3%B3n%20al%20pilot%20-%20listalaboda.com",
      ACCESS: "mailto:vicvalch@onchainfest.xyz?subject=Solicitud%20de%20acceso%20-%20listalaboda.com",
      CONTACT: "mailto:vicvalch@onchainfest.xyz",
      HOW_IT_WORKS: "/#como-funciona",
      WEDDING_SITES: "/#sitios-de-boda",
      PLANNERS: "/planners",
    });
    expect(MARKETING_CONTACT_EMAIL).toBe("vicvalch@onchainfest.xyz");
  });

  it("never send anyone to self-signup yet (LB-26)", () => {
    expect(Object.values(MARKETING_LINKS)).not.toContain("/signup");
  });
});

describe("marketing shell", () => {
  const allowed = new Set<string>(["/", ...Object.values(MARKETING_LINKS)]);

  it("the header links only to existing destinations, with a labelled nav and a native phone menu", () => {
    const html = render(createElement(MarketingHeader));
    expect(html).toMatch(/^<header/);
    expect(html).toContain(`<nav aria-label="${copy.marketing.nav.label}">`);
    expect(html).toContain("<details");
    expect(html).toContain(`<summary`);
    for (const href of hrefs(html)) expect(allowed.has(href), href).toBe(true);
    expect(hrefs(html)).toContain(MARKETING_LINKS.DEMO);
    expect(hrefs(html)).toContain(MARKETING_LINKS.LOGIN);
    expect(hrefs(html)).toContain(MARKETING_LINKS.PLANNERS);
    // The couples page doesn't exist yet (MKT-3): never a dead link.
    expect(html).not.toMatch(/\/parejas|\/signup/);
  });

  it("the footer links only to existing destinations and shows the contact address", () => {
    const html = render(createElement(MarketingFooter));
    expect(html).toMatch(/^<footer/);
    for (const href of hrefs(html)) expect(allowed.has(href), href).toBe(true);
    expect(html).toContain(`>${MARKETING_CONTACT_EMAIL}<`);
    expect(hrefs(html)).toContain(MARKETING_LINKS.PLANNERS);
    expect(html).not.toMatch(/\/parejas|\/signup/);
  });
});

describe("Section", () => {
  it("renders its heading at the requested level, labelled by it, with actions after the text", () => {
    const html = render(
      createElement(Section, {
        id: "demo",
        eyebrow: "Eyebrow",
        title: "Título",
        headingLevel: 1,
        body: ["Uno", "Dos"],
        actions: createElement("a", { href: "#x" }, "Acción"),
      }),
    );
    expect(html).toContain('<section id="demo" aria-labelledby="demo-titulo"');
    expect(html).toMatch(/<h1 id="demo-titulo"[^>]*>Título<\/h1>/);
    expect(html.indexOf("Dos")).toBeLessThan(html.indexOf("Acción"));
  });

  it("keeps the text first in reading order even when the visual leads on wide screens", () => {
    const html = render(
      createElement(Section, { title: "Texto", headingLevel: 3, layout: "visual-first", visual: createElement("span", null, "Visual") }),
    );
    expect(html.indexOf("Texto")).toBeLessThan(html.indexOf("Visual"));
    expect(html).toContain("lg:order-first");
  });
});

describe("ThemeShowcase", () => {
  const html = render(createElement(ThemeShowcase, { label: "Estilos" }));

  it("draws exactly the five themes with the real renderer, names and descriptions as real text", () => {
    const items = [...html.matchAll(/data-testid="theme-showcase-item" data-theme="(\w+)"/g)].map((m) => m[1]);
    expect(items).toEqual([...WEDDING_SITE_THEME_KEYS]);
    for (const key of WEDDING_SITE_THEME_KEYS) {
      expect(html).toContain(`>${copy.site.themes[key].name}</h3>`);
      expect(html).toContain(copy.site.themes[key].description);
    }
    // The real renderer: the public site's own markup, once per theme.
    expect(html.match(/data-testid="public-site"/g)).toHaveLength(5);
  });

  it("keeps every render decorative and inert, inside a focusable labelled region", () => {
    expect(html.match(/aria-hidden="true" inert=""/g)).toHaveLength(5);
    expect(html).toMatch(/^<div role="region" aria-label="Estilos" tabindex="0"/);
    // Nothing focusable inside the decorative renders.
    expect(html).not.toMatch(/<a |<button|<input/);
  });

  it("uses only fictional content: no contacts, links, tokens or ids", () => {
    expect(SHOWCASE_SITE.name).toBe("Mariana & Tomás");
    expect(JSON.stringify(SHOWCASE_SITE)).not.toMatch(/@|https?:|\/rsvp|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(html).not.toMatch(/href=|@[a-z]/);
  });
});

describe("FaqList (MKT-2)", () => {
  const items = [
    { question: "¿Uno?", answer: "Respuesta uno." },
    { question: "¿Dos?", answer: "Respuesta dos." },
  ];
  const html = render(createElement(FaqList, { items }));

  it("is one native disclosure per question, closed by default, with no script or button", () => {
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html.match(/<summary/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).not.toMatch(/<script|<button|onclick/i);
  });

  it("keeps question and answer as real text, the open/closed marker hidden from assistive technology", () => {
    for (const item of items) {
      expect(html).toContain(`<span>${item.question}</span>`);
      expect(html).toContain(item.answer);
    }
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(4);
  });
});

describe("/planners (MKT-2)", () => {
  const page = copy.marketing.planners;
  const html = render(createElement(PlannersPage));

  it("is not indexed yet and names the page for planners", () => {
    expect(plannersMetadata.robots).toEqual({ index: false, follow: false });
    expect(plannersMetadata.title).toBe("Software para wedding planners · listalaboda.com");
    expect(plannersMetadata.alternates).toBeUndefined();
  });

  it("has exactly one h1 of its own, the planner promise", () => {
    // The other h1s are the five decorative theme renders' own (aria-hidden, inert; E2E checks the accessible tree).
    expect(html.match(/data-testid="public-site"/g)).toHaveLength(5);
    expect(html.match(/<h1/g)).toHaveLength(1 + 5);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('data-testid="theme-showcase"'));
    expect(html).toMatch(new RegExp(`<h1[^>]*>${page.hero.title}</h1>`));
  });

  it("leads with the pilot, then the demo, and links only to known destinations", () => {
    const links = hrefs(html);
    expect(links[0]).toBe(MARKETING_LINKS.PILOT);
    expect(links[1]).toBe(MARKETING_LINKS.DEMO);
    const allowed = new Set<string>(Object.values(MARKETING_LINKS));
    for (const href of links) expect(allowed.has(href), href).toBe(true);
    expect(html).not.toMatch(/\/parejas|\/signup/);
  });

  it("asks the six questions and shows the five themes", () => {
    expect(html.match(/<details/g)).toHaveLength(page.faq.items.length);
    expect(page.faq.items).toHaveLength(6);
    expect(html.match(/data-testid="theme-showcase-item"/g)).toHaveLength(5);
  });

  it("never claims to move money: payments are recorded, not processed", () => {
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/procesa pagos|paga proveedores|cobra|transfiere/i);
    expect(page.money.note).toBe("listalaboda.com registra los pagos; no los procesa.");
  });
});
