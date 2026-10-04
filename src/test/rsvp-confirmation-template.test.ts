import { describe, expect, it } from "vitest";

import { SUBJECT_MAX_LENGTH } from "@/lib/email/invitation";
import {
  renderRsvpConfirmationEmail,
  rsvpConfirmationSubject,
  type RsvpConfirmationEmailInput,
} from "@/lib/email/rsvp-confirmation";
import { es } from "@/lib/i18n/messages/es";

const copy = es.rsvpConfirmationEmail;
const status = es.rsvp.status;
const SITE = "https://bodas.example.com/boda/ana-y-luis";
// A well-formed capability token, as a test value: it must never appear.
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

const base: RsvpConfirmationEmailInput = {
  partyLabel: "Familia Pérez",
  weddingName: "Boda de Ana y Luis",
  weddingDate: "2027-10-16",
  weddingCity: "Ciudad Ejemplo",
  guests: [
    { name: "Ana Pérez", attending: true },
    { name: "Carlos Pérez", attending: false },
  ],
  siteUrl: null,
};

describe("RSVP confirmation subject", () => {
  it("is fresh Spanish transactional copy naming the wedding", () => {
    expect(rsvpConfirmationSubject("Boda de Ana y Luis")).toBe("Confirmación de asistencia — Boda de Ana y Luis");
  });

  it("stays one safe header line (CR, LF, tab, control characters, U+2028, U+2029)", () => {
    const subject = rsvpConfirmationSubject("Boda\r\nBcc: victima@example.com\n\tX: 1\u0000\u0007\u2028a\u2029b");
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(subject).toBe("Confirmación de asistencia — Boda Bcc: victima@example.com X: 1 a b");
  });

  it("is bounded", () => {
    const subject = rsvpConfirmationSubject("Ñ".repeat(500));
    expect([...subject].length).toBe(SUBJECT_MAX_LENGTH);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("RSVP confirmation body", () => {
  it("text: greeting, wedding, date, city and each guest's current answer", () => {
    const { text } = renderRsvpConfirmationEmail(base);
    expect(text).toContain("Hola, Familia Pérez:");
    expect(text).toContain("Boda de Ana y Luis");
    expect(text).toContain(`${copy.dateLabel} 16 de octubre de 2027`);
    expect(text).toContain(`${copy.cityLabel} Ciudad Ejemplo`);
    expect(text).toContain(copy.summaryTitle);
    expect(text).toContain(`- Ana Pérez: ${status.attending}`);
    expect(text).toContain(`- Carlos Pérez: ${status.not_attending}`);
    expect(text).toContain(copy.changeNote);
  });

  it("html: the same summary, in party order", () => {
    const { html } = renderRsvpConfirmationEmail(base);
    expect(html).toContain("Ana Pérez");
    expect(html).toContain("Carlos Pérez");
    expect(html.indexOf("Ana Pérez")).toBeLessThan(html.indexOf("Carlos Pérez"));
    expect(html).toContain(`>${status.attending}<`);
    expect(html).toContain(`>${status.not_attending}<`);
    expect(html).toContain('<html lang="es">');
  });

  it("one guest", () => {
    const { text } = renderRsvpConfirmationEmail({ ...base, guests: [{ name: "Ana Sola", attending: true }] });
    expect(text.match(/^- /gm)).toHaveLength(1);
    expect(text).toContain(`- Ana Sola: ${status.attending}`);
  });

  it("uses Spanish product wording, never raw booleans or English", () => {
    const { text, html } = renderRsvpConfirmationEmail(base);
    for (const body of [text, html]) {
      expect(body).not.toMatch(/\b(true|false|yes)\b/);
    }
  });

  it("without date and city, neither line appears", () => {
    const { text, html } = renderRsvpConfirmationEmail({ ...base, weddingDate: null, weddingCity: null });
    for (const body of [text, html]) {
      expect(body).not.toContain(copy.dateLabel);
      expect(body).not.toContain(copy.cityLabel);
    }
  });

  it("formats the calendar date without shifting it", () => {
    const { text } = renderRsvpConfirmationEmail({ ...base, weddingDate: "2027-01-01" });
    expect(text).toContain("1 de enero de 2027");
  });

  it("links the website only when it is published", () => {
    const unpublished = renderRsvpConfirmationEmail(base);
    expect(unpublished.text).not.toContain("/boda/");
    expect(unpublished.html).not.toContain("/boda/");
    expect(unpublished.html).not.toContain(copy.siteLink);

    const published = renderRsvpConfirmationEmail({ ...base, siteUrl: SITE });
    expect(published.text).toContain(`${copy.siteIntro} ${SITE}`);
    expect(published.html).toContain(`href="${SITE}"`);
    expect(published.html).toContain(copy.siteLink);
  });

  it("never carries an RSVP link or token (not even with a site link)", () => {
    for (const input of [base, { ...base, siteUrl: SITE }]) {
      const { subject, text, html } = renderRsvpConfirmationEmail(input);
      for (const part of [subject, text, html]) {
        expect(part).not.toContain("/rsvp/");
        expect(part).not.toContain(TOKEN);
      }
    }
    // The only link is the published website.
    const { html } = renderRsvpConfirmationEmail({ ...base, siteUrl: SITE });
    expect(html.match(/href="/g)).toHaveLength(1);
  });

  it("the DTO has no place for notes, contact email, ids or provider data", () => {
    // Extra fields a caller might wrongly pass (structurally allowed) are
    // simply not rendered.
    const guest = { name: "Ana", attending: true, dietaryNote: "sin gluten", id: "g-1" };
    const extra = { ...base, contactEmail: "secreto@example.com", guests: [guest] };
    const leaky: RsvpConfirmationEmailInput = extra;
    const { text, html } = renderRsvpConfirmationEmail(leaky);
    for (const body of [text, html]) {
      expect(body).not.toContain("secreto@example.com");
      expect(body).not.toContain("sin gluten");
      expect(body).not.toContain("g-1");
    }
  });

  it("escapes every user value in the HTML", () => {
    const { html, text } = renderRsvpConfirmationEmail({
      partyLabel: "<img src=x onerror=alert(1)>",
      weddingName: "<script>alert(1)</script>",
      weddingDate: null,
      weddingCity: '"San José & Heredia"',
      guests: [{ name: "Ana <b>Pérez</b>", attending: true }],
      siteUrl: null,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Pérez</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Ana &lt;b&gt;Pérez&lt;/b&gt;");
    expect(html).toContain("&quot;San José &amp; Heredia&quot;");
    // The plain-text part keeps the text as typed (it is never HTML).
    expect(text).toContain("Ana <b>Pérez</b>");
  });
});
