import { describe, expect, it } from "vitest";

import {
  SUBJECT_MAX_LENGTH,
  escapeHtml,
  invitationSubject,
  renderInvitationEmail,
  type InvitationEmailInput,
} from "@/lib/email/invitation";
import { es } from "@/lib/i18n/messages/es";

const copy = es.invitationEmail;
const RSVP = "https://bodas.example.com/rsvp/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const SITE = "https://bodas.example.com/boda/ana-y-luis";

const base: InvitationEmailInput = {
  partyLabel: "Familia Pérez",
  weddingName: "Boda de Ana y Luis",
  weddingDate: "2027-10-16",
  weddingCity: "Ciudad Ejemplo",
  rsvpUrl: RSVP,
  siteUrl: null,
};

describe("invitation email subject", () => {
  it("names the wedding, in Spanish", () => {
    expect(invitationSubject("Boda de Ana y Luis")).toBe("Tu invitación a Boda de Ana y Luis");
  });

  it("can't be broken onto a new header line (CR/LF and control characters)", () => {
    const subject = invitationSubject("Boda\r\nBcc: victima@example.com\n\tX-Hack: 1\u0000\u2028fin");
    expect(subject).not.toMatch(/[\r\n\t\u0000\u2028]/);
    expect(subject).toBe("Tu invitación a Boda Bcc: victima@example.com X-Hack: 1 fin");
  });

  it("is bounded", () => {
    const subject = invitationSubject("Ñ".repeat(500));
    expect([...subject].length).toBe(SUBJECT_MAX_LENGTH);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("invitation email body", () => {
  it("text: greeting, wedding, date, city, RSVP link, personal note, footer", () => {
    const { text } = renderInvitationEmail(base);
    expect(text).toContain("Hola, Familia Pérez:");
    expect(text).toContain("Tienes una invitación a Boda de Ana y Luis.");
    expect(text).toContain(`${copy.dateLabel} 16 de octubre de 2027`);
    expect(text).toContain(`${copy.cityLabel} Ciudad Ejemplo`);
    expect(text).toContain(`${copy.cta}: ${RSVP}`);
    expect(text).toContain(copy.personalNote);
    expect(text).not.toContain(copy.siteIntro);
  });

  it("formats the calendar date without shifting it (no UTC/local drift)", () => {
    const { text, html } = renderInvitationEmail({ ...base, weddingDate: "2027-01-01" });
    expect(text).toContain("1 de enero de 2027");
    expect(html).toContain("1 de enero de 2027");
  });

  it("leaves out date and city when the wedding has none", () => {
    const { text, html } = renderInvitationEmail({ ...base, weddingDate: null, weddingCity: null });
    for (const part of [text, html]) {
      expect(part).not.toContain(copy.dateLabel);
      expect(part).not.toContain(copy.cityLabel);
    }
  });

  it("links the published website only when given", () => {
    const withSite = renderInvitationEmail({ ...base, siteUrl: SITE });
    expect(withSite.text).toContain(`${copy.siteIntro} ${SITE}`);
    expect(withSite.html).toContain(`href="${SITE}"`);
    expect(withSite.html).toContain(copy.siteLink);

    const without = renderInvitationEmail(base);
    expect(without.text).not.toContain("/boda/");
    expect(without.html).not.toContain("/boda/");
    expect(without.html).not.toContain(copy.siteLink);
  });

  it("html: a CTA button and the raw link as a fallback, no images or tracking", () => {
    const { html } = renderInvitationEmail(base);
    expect(html).toContain(`<a href="${RSVP}"`);
    expect(html).toContain(copy.cta);
    expect(html).toContain(copy.fallback);
    expect(html.split(RSVP).length - 1).toBe(3); // button href, fallback href, fallback text
    expect(html).toContain('lang="es"');
    expect(html).not.toMatch(/<img|<script|<iframe|<link|@import|url\(/i);
  });

  it("escapes every user-provided value in the HTML", () => {
    const { html, text } = renderInvitationEmail({
      ...base,
      weddingName: "<script>alert(1)</script>",
      partyLabel: "<img src=x onerror=alert(1)>",
      weddingCity: "<b>San José</b>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>San José</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;San José&lt;/b&gt;");
    // The plain-text part is plain text: shown as typed, never interpreted.
    expect(text).toContain("<b>San José</b>");
  });

  it("escapes attribute-breaking quotes too", () => {
    expect(escapeHtml(`"' onmouseover=x & <>`)).toBe("&quot;&#39; onmouseover=x &amp; &lt;&gt;");
    const { html } = renderInvitationEmail({ ...base, weddingName: `Boda "Ana" & 'Luis'` });
    expect(html).toContain("Boda &quot;Ana&quot; &amp; &#39;Luis&#39;");
  });

  it("user text can't inject catalog placeholders", () => {
    const { text } = renderInvitationEmail({ ...base, partyLabel: "{wedding}" });
    expect(text).toContain("Hola, {wedding}:");
  });
});
