import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Like the other marketing pages, the legal pages are static: no Supabase,
// session or request headers anywhere in their module graph.
vi.mock("@supabase/supabase-js", () => {
  throw new Error("legal pages must not import supabase-js");
});
vi.mock("@supabase/ssr", () => {
  throw new Error("legal pages must not import @supabase/ssr");
});
vi.mock("@/lib/supabase/server", () => {
  throw new Error("legal pages must not read a session");
});
vi.mock("next/headers", () => {
  throw new Error("legal pages must not read cookies or headers");
});

const { default: TermsPage, metadata: termsMetadata } = await import("@/app/(marketing)/terminos/page");
const { default: PrivacyPage, metadata: privacyMetadata } = await import("@/app/(marketing)/privacidad/page");
const { displayPrice } = await import("@/lib/billing/display-prices");
const { getMessages } = await import("@/lib/i18n");
const { LEGAL_LINKS, REFUNDS_SECTION_ID, SUPPORT_EMAIL } = await import("@/lib/legal/links");

// Batch 1: Terms (with refunds and cancellations) and the privacy policy.

const { legal } = getMessages();
const terms = renderToStaticMarkup(createElement(TermsPage));
const privacy = renderToStaticMarkup(createElement(PrivacyPage));
/** Visible text only, entities decoded, whitespace collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ");

describe("legal links", () => {
  it("are fixed paths, the refund section is a direct anchor into the Terms, support is on the brand's domain", () => {
    expect(LEGAL_LINKS).toEqual({
      TERMS: "/terminos",
      PRIVACY: "/privacidad",
      REFUNDS: "/terminos#reembolsos-y-cancelaciones",
      SUPPORT: "mailto:soporte@listalaboda.com",
    });
    expect(SUPPORT_EMAIL).toBe("soporte@listalaboda.com");
  });
});

describe("Terms page", () => {
  const body = text(terms);

  it("names the operating entity, and only as the operator", () => {
    expect(body).toContain("listalaboda.com es operado por OnChainFest LLC.");
    expect(body.match(/OnChainFest/g)).toHaveLength(1);
  });

  it("has the refund and cancellation section under its stable, linkable id", () => {
    expect(terms).toContain(`id="${REFUNDS_SECTION_ID}"`);
    expect(terms).toContain(`href="${LEGAL_LINKS.REFUNDS}"`);
  });

  it("states the planner price, monthly automatic renewal and cancellation at the end of the paid period", () => {
    expect(body).toContain(`suscripción mensual de ${displayPrice("planner")} por mes`);
    expect(body).toContain("Se renueva automáticamente cada mes");
    expect(body).toContain("siguen activos hasta el final del período que ya pagaste");
    expect(body).toContain("No prometemos reembolsos proporcionales");
  });

  it("states the couple one-time price, scope and duration with the approved wording, never a lifetime promise", () => {
    expect(body).toContain(`pago único de ${displayPrice("couple")}`);
    expect(body).toContain(
      "El pago de Pareja es un pago único, sin suscripción ni cobros recurrentes. Da acceso a la cuenta de pareja para organizar una boda. Actualmente el acceso no tiene una fecha de vencimiento programada y permanece disponible mientras listalaboda.com continúe ofreciendo el servicio, sujeto a estos Términos.",
    );
    expect(body).not.toMatch(/de por vida|para siempre|lifetime|vitalici/i);
  });

  it("describes V1 refunds accurately: manual, case by case, by email, no fixed window, no automatic revocation", () => {
    expect(body).toContain("revisamos cada solicitud de forma manual, caso por caso");
    expect(body).toContain(SUPPORT_EMAIL);
    expect(body).not.toMatch(/\d+\s*días/);
    expect(body).not.toMatch(/autom[aá]tica(mente)? .*(revoca|retira|desactiva)/i);
    expect(body).toContain("Nada en esta política limita los derechos que te correspondan de forma obligatoria según la ley aplicable.");
  });

  it("explains unpaid use during launch without implying data loss", () => {
    expect(body).toContain("No hacemos ningún cobro automático: solo pagas si lo confirmas tú en Facturación.");
    expect(body).toContain("No haber pagado no borra, por sí solo, la información que ya guardaste.");
    expect(body).toContain("te avisaremos antes de que el cambio se aplique");
  });

  it("has no jurisdiction or governing-law clause, and every placeholder is filled", () => {
    expect(body).not.toMatch(/jurisdicci|ley aplicable de|tribunal|domicilio/i);
    expect(body).not.toMatch(/\{\w+\}/);
  });
});

describe("Privacy page", () => {
  const body = text(privacy);

  it("names the operator and the support address", () => {
    expect(body).toContain("listalaboda.com es operado por OnChainFest LLC.");
    expect(body).toContain(SUPPORT_EMAIL);
  });

  it("covers guest data, no selling or advertising, no analytics, and deletion by email (no self-service)", () => {
    expect(body).toContain("respuestas de asistencia, incluidas las notas de comida");
    expect(body).toContain("No vendemos tus datos ni los de tus invitados");
    expect(body).toContain("No usamos cookies de analítica ni de publicidad.");
    expect(body).toContain("No registramos si se abre ni en qué enlaces se hace clic.");
    expect(body).toContain("todavía no tiene una opción para que elimines tu cuenta directamente");
    expect(body).not.toMatch(/\{\w+\}/);
  });
});

// UX-01B8: wedding-site photos (ADR-022), stated only as implemented.

describe("photo sections", () => {
  const termsBody = text(terms);
  const privacyBody = text(privacy);

  it("sit under the same stable id on both pages", () => {
    expect(terms).toContain('id="fotos-del-sitio"');
    expect(privacy).toContain('id="fotos-del-sitio"');
  });

  it("state the real limits, the publication gate and that anyone with the link can view and download", () => {
    expect(termsBody).toContain("hasta 20 fotos por boda");
    expect(termsBody).toContain("hasta 15 MB");
    expect(termsBody).toContain("solo si la boda está publicada, la sección donde está la foto está visible y la foto tiene una descripción");
    expect(termsBody).toContain("cualquier persona con el enlace del sitio puede ver y descargar esa foto");
    expect(termsBody).toContain("el sitio no es privado");
  });

  it("put the right to share on the uploader and route reports to the support address, reviewed manually", () => {
    expect(termsBody).toContain("Sube solo fotos que tengas derecho a usar y a compartir.");
    expect(termsBody).toContain(`escríbenos a ${SUPPORT_EMAIL} con el enlace del sitio. Revisamos cada solicitud de forma manual.`);
    expect(privacyBody).toContain(`escríbenos a ${SUPPORT_EMAIL} con el enlace del sitio`);
  });

  it("describe storage, metadata removal and delivery, naming both providers", () => {
    expect(privacyBody).toContain("No guardamos el archivo original ni su nombre.");
    expect(privacyBody).toContain("la ubicación (GPS), la fecha y los datos de la cámara (EXIF)");
    expect(privacyBody).toContain("almacenamiento privado de Supabase");
    expect(privacyBody).toContain("se entregan a través de Vercel");
    expect(privacyBody).toContain("almacenamiento de las fotos del sitio");
    expect(privacyBody).toContain("entrega de las fotos publicadas");
  });

  it("are honest about cache and copies: no absolute or instant erasure promise", () => {
    for (const body of [termsBody, privacyBody]) {
      expect(body).toMatch(/no podemos borrar/i);
      expect(body).not.toMatch(/de inmediato|inmediatamente|para siempre|permanentemente|garantizamos/i);
    }
    expect(termsBody).toContain("hasta 10 minutos");
  });
});

describe("both pages", () => {
  it("are plain text in sections, cross-link each other and are not indexed yet", () => {
    for (const html of [terms, privacy]) {
      expect(html).toContain(`href="${LEGAL_LINKS.TERMS}"`);
      expect(html).toContain(`href="${LEGAL_LINKS.PRIVACY}"`);
      expect(html).not.toMatch(/<script|<iframe|onchainfest\.xyz/i);
      expect(text(html)).toContain(legal.updated);
    }
    expect(termsMetadata.robots).toEqual({ index: false, follow: false });
    expect(privacyMetadata.robots).toEqual({ index: false, follow: false });
    expect(termsMetadata.title).toBe(legal.terms.metadata.title);
    expect(privacyMetadata.title).toBe(legal.privacy.metadata.title);
  });
});
