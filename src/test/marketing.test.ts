import { createElement, type ReactElement } from "react";
import { existsSync } from "node:fs";
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
const { HowItWorks } = await import("@/components/marketing/HowItWorks");
const { MarketingFooter } = await import("@/components/marketing/MarketingFooter");
const { MarketingHeader } = await import("@/components/marketing/MarketingHeader");
const { ThemeShowcase } = await import("@/components/marketing/ThemeShowcase");
const { getMessages } = await import("@/lib/i18n");
const { MARKETING_CONTACT_EMAIL, MARKETING_LINKS } = await import("@/lib/marketing/links");
const { SHOWCASE_SITE } = await import("@/lib/marketing/showcase");
const { WEDDING_SITE_THEME_KEYS } = await import("@/lib/wedding-site/design/themes");
// Importing the page itself proves its whole module graph stays clear of the mocks above.
const { default: PlannersPage, metadata: plannersMetadata } = await import("@/app/(marketing)/planners/page");
const { default: CouplesPage, metadata: couplesMetadata } = await import("@/app/(marketing)/parejas/page");
const { default: nextConfig } = await import("../../next.config");
const { default: robots } = await import("@/app/robots");

const render = (element: ReactElement) => renderToStaticMarkup(element);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
const copy = getMessages();

describe("marketing links (MKT-1)", () => {
  it("are the approved destinations, in one place", () => {
    expect(MARKETING_LINKS).toEqual({
      PLANNERS: "/planners",
      COUPLES: "/parejas",
      LOGIN: "/login",
      DEMO: "mailto:vicvalch@onchainfest.xyz?subject=Solicitud%20de%20demo%20-%20listalaboda.com",
      PILOT: "mailto:vicvalch@onchainfest.xyz?subject=Aplicaci%C3%B3n%20al%20pilot%20-%20listalaboda.com",
      ACCESS: "mailto:vicvalch@onchainfest.xyz?subject=Solicitud%20de%20acceso%20-%20listalaboda.com",
      CONTACT: "mailto:vicvalch@onchainfest.xyz",
      // ACCOUNT-01: the section of the current page; both landings have it.
      HOW_IT_WORKS: "#como-funciona",
    });
    expect(MARKETING_CONTACT_EMAIL).toBe("vicvalch@onchainfest.xyz");
  });

  it("never send anyone to self-signup yet (LB-26)", () => {
    expect(Object.values(MARKETING_LINKS)).not.toContain("/signup");
  });
});

describe("marketing shell", () => {
  const allowed = new Set<string>(Object.values(MARKETING_LINKS));

  it("the header links only to existing destinations, with a labelled nav and a native phone menu", () => {
    const html = render(createElement(MarketingHeader));
    expect(html).toMatch(/^<header/);
    expect(html).toContain(`<nav aria-label="${copy.marketing.nav.label}">`);
    expect(html).toContain("<details");
    expect(html).toContain(`<summary`);
    for (const href of hrefs(html)) expect(allowed.has(href), href).toBe(true);
    expect(hrefs(html)).toContain(MARKETING_LINKS.DEMO);
    expect(hrefs(html)).toContain(MARKETING_LINKS.LOGIN);
    // ACCOUNT-01: the brand opens the planner page; then exactly the two audience
    // pages, how it works and login, in this order (no third, generic landing).
    const links = hrefs(html);
    expect(links[0]).toBe(MARKETING_LINKS.PLANNERS);
    expect(links.slice(1, 5)).toEqual([
      MARKETING_LINKS.PLANNERS,
      MARKETING_LINKS.COUPLES,
      MARKETING_LINKS.HOW_IT_WORKS,
      MARKETING_LINKS.LOGIN,
    ]);
    expect(html).not.toContain("/signup");
  });

  it("the footer links only to existing destinations and shows the contact address", () => {
    const html = render(createElement(MarketingFooter));
    expect(html).toMatch(/^<footer/);
    for (const href of hrefs(html)) expect(allowed.has(href), href).toBe(true);
    expect(html).toContain(`>${MARKETING_CONTACT_EMAIL}<`);
    expect(hrefs(html)).not.toContain("/");
    for (const href of [
      MARKETING_LINKS.PLANNERS,
      MARKETING_LINKS.COUPLES,
      MARKETING_LINKS.LOGIN,
      MARKETING_LINKS.DEMO,
      MARKETING_LINKS.ACCESS,
    ]) {
      expect(hrefs(html)).toContain(href);
    }
    expect(html).not.toContain("/signup");
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

describe("/ (ACCOUNT-01)", () => {
  it("redirects to /planners on the server, temporarily (no generic homepage)", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual([{ source: "/", destination: "/planners", permanent: false }]);
    expect(existsSync("src/app/(marketing)/page.tsx")).toBe(false);
  });

  it("removes the homepage-only screens and copy", () => {
    expect(existsSync("public/marketing/wedding-card-mobile.webp")).toBe(false);
    expect(existsSync("public/marketing/timeline.webp")).toBe(false);
    expect("home" in copy.marketing).toBe(false);
    // Still used by /planners and /parejas.
    for (const file of ["mis-bodas.webp", "wedding-card.webp", "timeline-mobile.webp", "lifestyle/tablescape-candles.webp"]) {
      expect(existsSync(`public/marketing/${file}`), file).toBe(true);
    }
  });
});

describe("Cómo funciona (ACCOUNT-01)", () => {
  const steps = (html: string, audience: string) => {
    const start = html.indexOf(`data-audience="${audience}"`);
    const block = html.slice(start, html.indexOf("</ol>", start));
    return [...block.matchAll(/<span class="text-lg[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);
  };
  const audiences = (html: string) => [...html.matchAll(/data-audience="(\w+)"/g)].map((m) => m[1]);

  it("one shared section explains both account paths, four steps each", () => {
    const html = render(createElement(HowItWorks, { first: "planner" }));
    expect(html).toMatch(/^<section id="como-funciona" aria-labelledby="como-funciona-titulo"/);
    expect(steps(html, "planner")).toEqual([
      "Crea y administra las bodas de tus clientes.",
      "Controla invitados, mesas, presupuesto, proveedores y cronograma.",
      "Detecta qué necesita atención entre todas tus bodas.",
      "Comparte la experiencia con cada pareja.",
    ]);
    expect(steps(html, "couple")).toEqual([
      "Crea tu boda.",
      "Organiza invitados, mesas, presupuesto y proveedores.",
      "Publica el sitio de tu boda.",
      "Llega al gran día con todo bajo control.",
    ]);
    expect(html.match(/<ol/g)).toHaveLength(2);
    expect(html).not.toMatch(/href=|<button|<script/);
  });

  it("each landing shows it once, its own audience first", () => {
    const planners = render(createElement(PlannersPage));
    const couples = render(createElement(CouplesPage));
    expect(planners.match(/id="como-funciona"/g)).toHaveLength(1);
    expect(couples.match(/id="como-funciona"/g)).toHaveLength(1);
    expect(audiences(planners)).toEqual(["planner", "couple"]);
    expect(audiences(couples)).toEqual(["couple", "planner"]);
  });

  it("never uses technical account vocabulary", () => {
    const text = JSON.stringify(copy.marketing.howItWorks);
    expect(text).not.toMatch(/\b(account_type|tenant|rol|role|workspace|portfolio)\b/i);
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

  it("stays about planners: no link to the couples page in its own content (the shell has it)", () => {
    expect(html).not.toContain(MARKETING_LINKS.COUPLES);
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
    expect(html).not.toContain("/signup");
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

describe("wedding photography (MKT-5)", () => {
  const pages = { planners: render(createElement(PlannersPage)), couples: render(createElement(CouplesPage)) };
  const photos = (html: string) => [...html.matchAll(/<img [^>]*data-lifestyle=""[^>]*>/g)].map((m) => m[0]);
  const alt = (tag: string) => /alt="([^"]*)"/.exec(tag)?.[1];

  it("stays restrained: two photos for planners, four for couples", () => {
    expect(photos(pages.planners)).toHaveLength(2);
    expect(photos(pages.couples)).toHaveLength(4);
  });

  it("describes meaningful photos in Spanish and hides decorative ones from assistive technology", () => {
    for (const html of Object.values(pages)) {
      for (const tag of photos(html)) {
        const text = alt(tag);
        expect(text).toBeDefined();
        if (text) expect(text.length).toBeGreaterThan(20);
      }
      // Every decorative photo sits in an aria-hidden wrapper.
      const decorative = [...html.matchAll(/<div aria-hidden="true" class="mkt-photo[^"]*"><picture><img [^>]*alt=""[^>]*data-lifestyle=""/g)];
      expect(decorative.length).toBe(photos(html).filter((tag) => alt(tag) === "").length);
    }
    // MKT-6: the planner with the couple leads the hero; the planner with the bride follows the Cronograma.
    expect(photos(pages.planners).map(alt)).toEqual([copy.marketing.planners.hero.photoAlt, copy.marketing.planners.weddingDay.photoAlt]);
  });

  it("never ships the invented-interface photo, and keeps romance away from the money and the day", () => {
    expect(existsSync("public/marketing/lifestyle/product-context.png")).toBe(false);
    expect(existsSync("public/marketing/lifestyle/product-context.webp")).toBe(false);
    for (const html of Object.values(pages)) expect(html).not.toContain("product-context");
    for (const [html, ids] of [
      [pages.planners, ["invitados-y-mesas", "presupuesto", "cronograma"]],
      [pages.couples, ["invitados", "presupuesto"]],
    ] as const) {
      for (const id of ids) {
        const start = html.indexOf(`<section id="${id}"`);
        const section = html.slice(start, html.indexOf("</section>", start));
        expect(start, id).toBeGreaterThan(-1);
        expect(section, id).not.toContain("data-lifestyle");
      }
    }
  });
});

describe("marketing metadata and robots (MKT-3)", () => {
  const pages = [
    { metadata: plannersMetadata, title: "Software para wedding planners · listalaboda.com" },
    { metadata: couplesMetadata, title: "Organiza tu boda en un solo lugar · listalaboda.com" },
  ];

  it("keeps every marketing page out of search, with no canonical, base URL or image", () => {
    for (const { metadata, title } of pages) {
      expect(metadata.title).toBe(title);
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.metadataBase).toBeUndefined();
      // Open Graph is text only: an image or URL would need an absolute (and so a canonical) address.
      expect(metadata.openGraph).toEqual({
        title,
        description: metadata.description,
        siteName: "listalaboda.com",
        locale: "es",
        type: "website",
      });
    }
    expect(JSON.stringify(pages)).not.toMatch(/vercel\.app|https?:/);
  });

  it("robots.txt keeps crawlers out of private surfaces, without a sitemap or host", () => {
    const result = robots();
    expect(result).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: ["/app", "/auth", "/invite", "/rsvp", "/api"] },
    });
    expect(result.sitemap).toBeUndefined();
    expect(result.host).toBeUndefined();
    // Published wedding sites keep their own noindex: crawlable, so it can be read.
    expect(JSON.stringify(result)).not.toContain("/boda");
  });
});

describe("/parejas (MKT-3)", () => {
  const page = copy.marketing.couples;
  const html = render(createElement(CouplesPage));

  it("is not indexed yet and names the page for couples", () => {
    expect(couplesMetadata.robots).toEqual({ index: false, follow: false });
    expect(couplesMetadata.description).toBe(
      "Organiza invitados, RSVP, tareas, mesas, presupuesto, cronograma y el sitio de tu boda desde un solo lugar.",
    );
  });

  it("has exactly one h1 of its own, the couples promise", () => {
    // Every other h1 belongs to a decorative site render (aria-hidden, inert): the
    // hero's, the centerpiece's and the five in the showcase.
    expect(html.match(/data-testid="public-site"/g)).toHaveLength(2 + 5);
    expect(html.match(/<h1/g)).toHaveLength(1 + 2 + 5);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('data-testid="public-site"'));
    expect(html).toMatch(new RegExp(`<h1[^>]*>${page.hero.title}</h1>`));
  });

  it("leads with access, then how it works, offers the planner page, and links only to known destinations", () => {
    const links = hrefs(html);
    expect(links.slice(0, 3)).toEqual([MARKETING_LINKS.ACCESS, MARKETING_LINKS.HOW_IT_WORKS, MARKETING_LINKS.PLANNERS]);
    expect(html).toContain('id="como-funciona"');
    const allowed = new Set<string>(Object.values(MARKETING_LINKS));
    for (const href of links) expect(allowed.has(href), href).toBe(true);
    // The closing band: access again, and the planner page.
    expect(links.slice(-2)).toEqual([MARKETING_LINKS.ACCESS, MARKETING_LINKS.PLANNERS]);
    expect(html).not.toContain("/signup");
  });

  it("shows the five themes, every render decorative and inert", () => {
    expect(html.match(/data-testid="theme-showcase-item"/g)).toHaveLength(5);
    expect(html.match(/<div aria-hidden="true" inert=""/g)).toHaveLength(2 + 5);
  });

  it("asks the seven questions, with the approved price answer", () => {
    expect(html.match(/<details/g)).toHaveLength(7);
    expect(page.faq.items.at(-1)?.answer).toBe(copy.marketing.planners.faq.items.at(-1)?.answer);
  });

  it("never shows a screen twice, and never the planners' multi-wedding screens", () => {
    const images = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(images).size).toBe(images.length);
    expect(html).not.toMatch(/mis-bodas|wedding-card/);
  });

  it("stays truthful: payments recorded, not processed; no open RSVP, automatic seating or pricing", () => {
    const text = JSON.stringify(page);
    expect(page.plan.note).toBe("listalaboda.com registra los pagos; no los procesa.");
    expect(text).not.toMatch(/procesa pagos|paga proveedores|cobra|transfiere|gratis|SMS|Mis bodas|registro abierto para|acomod\w* automátic|recordatorios? automátic/i);
    expect(text).not.toMatch(/[$₡]\s?\d|\d+\s?(USD|CRC)/);
  });
});
