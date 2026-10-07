import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_KINDS,
  INVITATION_KINDS,
  REMINDER_KINDS,
  blockOfStatus,
  deliveryForSend,
  deliveryStatusLabel,
  latestDelivery,
  recipientBlock,
  recipientWarning,
  type DeliveryStatus,
  type PartyDelivery,
} from "@/lib/guests/delivery-status";
import { es } from "@/lib/i18n/messages/es";

// LB-18.3 (ADR-011 §9): what organizers see about a recorded email, and the
// same-address rule the page mirrors (the sends are guarded by the database).

const CURRENT = "familia@example.com";

function delivery(overrides: Partial<PartyDelivery> = {}): PartyDelivery {
  return {
    kind: "guest_invitation",
    recipient: CURRENT,
    acceptedAt: "2026-10-02T10:00:00.000Z",
    status: "accepted",
    ...overrides,
  };
}

describe("deliveryStatusLabel", () => {
  it.each([
    ["accepted", "Enviado"],
    ["delayed", "Entrega retrasada"],
    ["failed", "No se pudo enviar"],
    ["delivered", "Entregado"],
    ["suppressed", "Bloqueado"],
    ["bounced", "Rebotó"],
    ["complained", "Marcado como spam"],
  ] as const)("%s → %s", (status, label) => {
    expect(deliveryStatusLabel(delivery({ status }))).toBe(label);
    expect(es.guests.delivery.status[status]).toBe(label);
  });

  it("accepted is never called delivered", () => {
    expect(deliveryStatusLabel(delivery({ status: "accepted" }))).not.toBe(es.guests.delivery.status.delivered);
  });

  it("no ledger row (a send before LB-18.1) → unavailable", () => {
    expect(deliveryStatusLabel(null)).toBe("Estado de entrega no disponible");
  });

  it("an automatic reminder says so; a manual one doesn't pretend to be automatic", () => {
    expect(deliveryStatusLabel(delivery({ kind: "rsvp_reminder_automatic", status: "delivered" }))).toBe(
      "Entregado (recordatorio automático)",
    );
    expect(deliveryStatusLabel(delivery({ kind: "rsvp_reminder_manual", status: "delivered" }))).toBe("Entregado");
  });
});

describe("blockOfStatus / recipientBlock: the same-address rule", () => {
  it.each([
    ["bounced", "bounced"],
    ["suppressed", "suppressed"],
    ["complained", "complained"],
    ["delayed", "none"],
    ["failed", "none"],
    ["delivered", "none"],
    ["accepted", "none"],
  ] as const)("same current address, %s → %s", (status, block) => {
    expect(blockOfStatus(status)).toBe(block);
    expect(recipientBlock([delivery({ status })], CURRENT)).toBe(block);
  });

  it("an old address's bounce never blocks the new current address", () => {
    const history = [delivery({ recipient: "vieja@example.com", status: "bounced" })];
    expect(recipientBlock(history, "nueva@example.com")).toBe("none");
    expect(recipientBlock(history, "vieja@example.com")).toBe("bounced");
  });

  // Comparison form = trim + lowercase of the whole address (case-only edits
  // are the SAME address); nothing provider-specific.
  it.each(["bounced", "suppressed", "complained"] as const)(
    "A: stored victor@example.com %s, current Victor@example.com → blocked",
    (status) => {
      expect(recipientBlock([delivery({ recipient: "victor@example.com", status })], "Victor@example.com")).toBe(status);
    },
  );

  it("B: stored VICTOR@EXAMPLE.COM bounced, current victor@example.com → blocked", () => {
    expect(recipientBlock([delivery({ recipient: "VICTOR@EXAMPLE.COM", status: "bounced" })], "victor@example.com")).toBe(
      "bounced",
    );
    expect(recipientBlock([delivery({ recipient: " victor@example.com ", status: "bounced" })], "Victor@Example.COM")).toBe(
      "bounced",
    );
  });

  it("C: a genuinely different address (victor2@) is allowed", () => {
    expect(recipientBlock([delivery({ recipient: "victor@example.com", status: "complained" })], "victor2@example.com")).toBe(
      "none",
    );
  });

  it("D: no Gmail dot rules — victor.test@ and victortest@ stay different", () => {
    expect(recipientBlock([delivery({ recipient: "victor.test@gmail.com", status: "bounced" })], "victortest@gmail.com")).toBe(
      "none",
    );
  });

  it("E: plus tags are not collapsed — victor+one@ and victor+two@ stay different", () => {
    expect(recipientBlock([delivery({ recipient: "victor+one@example.com", status: "bounced" })], "victor+two@example.com")).toBe(
      "none",
    );
    expect(recipientBlock([delivery({ recipient: "victor+one@example.com", status: "bounced" })], "victor@example.com")).toBe(
      "none",
    );
  });

  it("the strongest block wins (complained > bounced > suppressed), whatever the order", () => {
    const statuses: DeliveryStatus[] = ["suppressed", "complained", "delivered", "bounced"];
    expect(recipientBlock(statuses.map((status) => delivery({ status })), CURRENT)).toBe("complained");
    expect(recipientBlock([delivery({ status: "suppressed" }), delivery({ status: "bounced" })], CURRENT)).toBe("bounced");
  });

  it("a later successful delivery doesn't clear a bounce for the same address (no override)", () => {
    const history = [
      delivery({ status: "bounced", acceptedAt: "2026-10-01T00:00:00Z" }),
      delivery({ status: "delivered", acceptedAt: "2026-10-05T00:00:00Z" }),
    ];
    expect(recipientBlock(history, CURRENT)).toBe("bounced");
  });

  it("any kind counts: a bounced confirmation blocks the invitation to that address", () => {
    expect(recipientBlock([delivery({ kind: "rsvp_confirmation", status: "bounced" })], CURRENT)).toBe("bounced");
  });

  it("no current address → nothing to block", () => {
    expect(recipientBlock([delivery({ status: "complained" })], null)).toBe("none");
  });

  it("F: only one wedding's rows are ever passed (case variants included); another wedding's are simply absent", () => {
    // The page reads its own wedding's rows only (member RLS + wedding_id
    // filter). With wedding B's (empty) list, A's bounce can't block.
    const weddingA = [delivery({ recipient: "FAMILIA@example.com", status: "bounced" })];
    const weddingB: PartyDelivery[] = [];
    expect(recipientBlock(weddingA, CURRENT)).toBe("bounced");
    expect(recipientBlock(weddingB, CURRENT)).toBe("none");
  });
});

describe("recipientWarning", () => {
  it("bounced/suppressed share the undeliverable warning; complaints have their own", () => {
    expect(recipientWarning("bounced")).toBe("undeliverable");
    expect(recipientWarning("suppressed")).toBe("undeliverable");
    expect(recipientWarning("complained")).toBe("complained");
    expect(recipientWarning("none")).toBeNull();
    expect(es.guests.delivery.warning.undeliverable).toBe(
      "No pudimos entregar correos a esta dirección. Revísala antes de volver a enviar.",
    );
    expect(es.guests.delivery.warning.complained).toBe(
      "Esta dirección marcó un correo como spam. Cambia el correo antes de volver a enviar.",
    );
  });
});

describe("latestDelivery / deliveryForSend", () => {
  const rows = [
    delivery({ kind: "guest_invitation", acceptedAt: "2026-10-01T00:00:00Z", status: "bounced" }),
    delivery({ kind: "guest_invitation", acceptedAt: "2026-10-03T00:00:00Z", status: "delivered" }),
    delivery({ kind: "rsvp_confirmation", acceptedAt: "2026-10-04T00:00:00Z", status: "delayed" }),
    delivery({ kind: "rsvp_reminder_manual", acceptedAt: "2026-10-05T00:00:00Z", status: "accepted" }),
    delivery({ kind: "rsvp_reminder_automatic", acceptedAt: "2026-10-06T00:00:00Z", status: "failed" }),
  ];

  it("latest per kind, by acceptance time, whatever the input order", () => {
    expect(latestDelivery([...rows].reverse(), INVITATION_KINDS)?.status).toBe("delivered");
    expect(latestDelivery(rows, CONFIRMATION_KINDS)?.status).toBe("delayed");
    expect(latestDelivery(rows, ["rsvp_reminder_manual"])?.status).toBe("accepted");
  });

  it("reminders: the latest of either channel wins, and keeps its kind", () => {
    expect(latestDelivery(rows, REMINDER_KINDS)).toMatchObject({ kind: "rsvp_reminder_automatic", status: "failed" });
    const manualLater = [...rows, delivery({ kind: "rsvp_reminder_manual", acceptedAt: "2026-10-07T00:00:00Z", status: "delivered" })];
    expect(latestDelivery(manualLater, REMINDER_KINDS)).toMatchObject({ kind: "rsvp_reminder_manual", status: "delivered" });
  });

  it("the line's own send only: same database clock, else unavailable (never guessed)", () => {
    expect(deliveryForSend(rows, INVITATION_KINDS, "2026-10-03T00:00:00+00:00")?.status).toBe("delivered");
    // A send recorded before the ledger existed (or any mismatch): no row.
    expect(deliveryForSend(rows, INVITATION_KINDS, "2026-10-09T00:00:00Z")).toBeNull();
    expect(deliveryForSend([], INVITATION_KINDS, "2026-10-03T00:00:00Z")).toBeNull();
  });
});
