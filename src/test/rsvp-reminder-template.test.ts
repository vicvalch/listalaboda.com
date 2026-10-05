import { describe, expect, it } from "vitest";

import { SUBJECT_MAX_LENGTH } from "@/lib/email/invitation";
import { renderRsvpConfirmationEmail } from "@/lib/email/rsvp-confirmation";
import {
  renderRsvpReminderEmail,
  rsvpReminderSubject,
  type RsvpReminderEmailInput,
} from "@/lib/email/rsvp-reminder";
import { es } from "@/lib/i18n/messages/es";

// LB-14 (ADR-007): the reminder email is pure; it renders exactly what the
// server hands it. Unlike the confirmation (LB-12), it DOES carry the
// party's current RSVP link: that is its purpose.

const copy = es.rsvpReminderEmail;
const SITE = "https://bodas.example.com/boda/ana-y-luis";
// A well-formed capability token, as a test value.
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const RSVP_URL = `https://bodas.example.com/rsvp/${TOKEN}`;

const base: RsvpReminderEmailInput = {
  partyLabel: "Familia Pérez",
  weddingName: "Boda de Ana y Luis",
  weddingDate: "2027-10-16",
  weddingCity: "Ciudad Ejemplo",
  rsvpUrl: RSVP_URL,
  siteUrl: null,
};

describe("RSVP reminder subject", () => {
  it("is the reminder subject naming the wedding", () => {
    expect(rsvpReminderSubject("Boda de Ana y Luis")).toBe("Recordatorio de confirmación — Boda de Ana y Luis");
    expect(renderRsvpReminderEmail(base).subject).toBe("Recordatorio de confirmación — Boda de Ana y Luis");
  });

  it("stays one safe header line (CR, LF, tab, control characters, U+2028, U+2029)", () => {
    const subject = rsvpReminderSubject("Boda\r\nBcc: victima@example.com\n\tX: 1\u0000\u0007\u2028a\u2029b");
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(subject).toBe("Recordatorio de confirmación — Boda Bcc: victima@example.com X: 1 a b");
  });

  it("is bounded", () => {
    const subject = rsvpReminderSubject("Ñ".repeat(500));
    expect([...subject].length).toBe(SUBJECT_MAX_LENGTH);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("RSVP reminder body", () => {
  it("text: greeting, reminder, date, city, the current link and thanks", () => {
    const { text } = renderRsvpReminderEmail(base);
    expect(text).toContain("Hola, Familia Pérez:");
    expect(text).toContain("Te recordamos que todavía puedes confirmar tu asistencia a Boda de Ana y Luis.");
    expect(text).toContain(`${copy.dateLabel} 16 de octubre de 2027`);
    expect(text).toContain(`${copy.cityLabel} Ciudad Ejemplo`);
    // The same line shape as the invitation, so the link is easy to find.
    expect(text.split("\n")).toContain(`${copy.cta}: ${RSVP_URL}`);
    expect(text).toContain(copy.personalNote);
    expect(text).toContain(copy.thanks);
  });

  it("html: the link as button and as raw fallback, Spanish document", () => {
    const { html } = renderRsvpReminderEmail(base);
    expect(html).toContain('<html lang="es">');
    expect(html.match(new RegExp(`href="${RSVP_URL}"`, "g"))).toHaveLength(2);
    expect(html).toContain(`>${copy.cta}<`);
    expect(html).toContain(copy.fallback);
    expect(html).toContain("Familia Pérez");
  });

  it("carries exactly the link it was given: the party's current capability", () => {
    const { text, html } = renderRsvpReminderEmail(base);
    for (const body of [text, html]) {
      expect(body).toContain(`/rsvp/${TOKEN}`);
      expect(body.match(/\/rsvp\/([A-Za-z0-9_-]+)/g)?.every((m) => m === `/rsvp/${TOKEN}`)).toBe(true);
    }
  });

  it("without date and city, neither line appears", () => {
    const { text, html } = renderRsvpReminderEmail({ ...base, weddingDate: null, weddingCity: null });
    for (const body of [text, html]) {
      expect(body).not.toContain(copy.dateLabel);
      expect(body).not.toContain(copy.cityLabel);
    }
  });

  it("only the date, or only the city", () => {
    expect(renderRsvpReminderEmail({ ...base, weddingCity: null }).text).not.toContain(copy.cityLabel);
    expect(renderRsvpReminderEmail({ ...base, weddingCity: null }).text).toContain("16 de octubre de 2027");
    expect(renderRsvpReminderEmail({ ...base, weddingDate: null }).text).not.toContain(copy.dateLabel);
    expect(renderRsvpReminderEmail({ ...base, weddingDate: null }).text).toContain("Ciudad Ejemplo");
  });

  it("formats the calendar date without shifting it", () => {
    expect(renderRsvpReminderEmail({ ...base, weddingDate: "2027-01-01" }).text).toContain("1 de enero de 2027");
  });

  it("links the website only when it is published", () => {
    const unpublished = renderRsvpReminderEmail(base);
    expect(unpublished.text).not.toContain("/boda/");
    expect(unpublished.html).not.toContain("/boda/");
    expect(unpublished.html).not.toContain(copy.siteLink);

    const published = renderRsvpReminderEmail({ ...base, siteUrl: SITE });
    expect(published.text).toContain(`${copy.siteIntro} ${SITE}`);
    expect(published.html).toContain(`href="${SITE}"`);
    expect(published.html).toContain(copy.siteLink);
  });

  it("the DTO has no place for answers, notes, the contact email, ids, hashes or provider data", () => {
    // Extra fields a caller might wrongly pass (structurally allowed) are
    // simply not rendered.
    const extra = {
      ...base,
      contactEmail: "secreto@example.com",
      guests: [{ name: "Ana", attending: true, dietaryNote: "sin gluten" }],
      dietaryNote: "sin gluten",
      notes: "nota privada",
      providerMessageId: "msg_proveedor_1",
      tokenHash: "a".repeat(64),
      envelope: "v1.envelope.secreto.tag",
      guestInvitationId: "44444444-4444-4444-8444-444444444444",
    };
    const leaky: RsvpReminderEmailInput = extra;
    const { subject, text, html } = renderRsvpReminderEmail(leaky);
    for (const body of [subject, text, html]) {
      for (const secret of [
        "secreto@example.com",
        "sin gluten",
        "nota privada",
        "msg_proveedor_1",
        "a".repeat(64),
        "v1.envelope",
        "44444444-4444",
        es.rsvp.status.attending,
      ]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it("escapes every user value in the HTML", () => {
    const { html, text } = renderRsvpReminderEmail({
      partyLabel: "<img src=x onerror=alert(1)>",
      weddingName: "<script>alert(1)</script>",
      weddingDate: null,
      weddingCity: '"San José & Heredia"',
      rsvpUrl: RSVP_URL,
      siteUrl: null,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;San José &amp; Heredia&quot;");
    // The plain-text part keeps the text as typed (it is never HTML).
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("reminder vs confirmation (two different semantics)", () => {
  it("the reminder carries /rsvp/; the confirmation, for the same party, never does", () => {
    const reminder = renderRsvpReminderEmail({ ...base, siteUrl: SITE });
    const confirmation = renderRsvpConfirmationEmail({
      partyLabel: base.partyLabel,
      weddingName: base.weddingName,
      weddingDate: base.weddingDate,
      weddingCity: base.weddingCity,
      guests: [{ name: "Ana", attending: true }],
      siteUrl: SITE,
    });
    expect(reminder.text).toContain("/rsvp/");
    for (const part of [confirmation.subject, confirmation.text, confirmation.html]) {
      expect(part).not.toContain("/rsvp/");
    }
    expect(reminder.subject).not.toBe(confirmation.subject);
  });
});
