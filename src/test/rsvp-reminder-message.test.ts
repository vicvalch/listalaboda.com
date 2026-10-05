import { describe, expect, it } from "vitest";

import { renderRsvpReminderMessage, type RsvpReminderMessageInput } from "@/lib/guests/rsvp-reminder-message";
import { es } from "@/lib/i18n/messages/es";

// LB-14: the WhatsApp-ready text is pure plain text the organizer copies.

const copy = es.rsvpReminderMessage;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const RSVP_URL = `https://bodas.example.com/rsvp/${TOKEN}`;

const base: RsvpReminderMessageInput = {
  partyLabel: "Familia Pérez",
  weddingName: "Boda de Ana y Luis",
  weddingDate: "2027-10-16",
  rsvpUrl: RSVP_URL,
};

describe("renderRsvpReminderMessage", () => {
  it("greets the party, reminds with the wedding and date, gives the current link", () => {
    expect(renderRsvpReminderMessage(base)).toBe(
      [
        "Hola, Familia Pérez:",
        "",
        "Te recordamos que todavía puedes confirmar tu asistencia a Boda de Ana y Luis (16 de octubre de 2027).",
        "",
        copy.linkIntro,
        RSVP_URL,
        "",
        copy.thanks,
      ].join("\n"),
    );
  });

  it("without a date, no date", () => {
    const message = renderRsvpReminderMessage({ ...base, weddingDate: null });
    expect(message).toContain("Te recordamos que todavía puedes confirmar tu asistencia a Boda de Ana y Luis.");
    expect(message).not.toContain("2027");
    expect(message).not.toContain("undefined");
  });

  it("the link sits alone on its line (WhatsApp makes it tappable)", () => {
    expect(renderRsvpReminderMessage(base).split("\n")).toContain(RSVP_URL);
  });

  it("a label or wedding name can't inject extra lines or a second link", () => {
    const message = renderRsvpReminderMessage({
      ...base,
      partyLabel: "Familia\nhttps://malo.example/rsvp/xyz\r\nFin",
      weddingName: "Boda\u2028Otra línea",
    });
    expect(message.split("\n")[0]).toBe("Hola, Familia https://malo.example/rsvp/xyz Fin:");
    expect(message.split("\n").filter((line) => line.startsWith("https://"))).toEqual([RSVP_URL]);
    expect(message).not.toContain("\u2028");
  });

  it("is concise plain text: no answers, notes, email, ids or markup", () => {
    const extra = {
      ...base,
      contactEmail: "secreto@example.com",
      dietaryNote: "sin gluten",
      guests: [{ name: "Ana", attending: false }],
      guestInvitationId: "44444444-4444-4444-8444-444444444444",
    };
    const leaky: RsvpReminderMessageInput = extra;
    const message = renderRsvpReminderMessage(leaky);
    for (const secret of ["secreto@example.com", "sin gluten", "44444444", es.rsvp.status.not_attending, "<"]) {
      expect(message).not.toContain(secret);
    }
    expect(message.length).toBeLessThan(400);
  });
});
