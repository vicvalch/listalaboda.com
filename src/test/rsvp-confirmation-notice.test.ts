import { describe, expect, it } from "vitest";

import { es } from "@/lib/i18n/messages/es";
import {
  confirmationNoticeOf,
  parseConfirmationNotice,
  type ConfirmationOutcome,
} from "@/lib/rsvp/confirmation-notice";

// What the guest is told about the confirmation email, always AFTER (and
// beneath) "Guardamos tu respuesta". Never an address or internal detail.

describe("confirmation notice", () => {
  it.each([
    ["sent", "sent"],
    // The provider accepted it: from the guest's side it was sent.
    ["sent_but_unrecorded", "sent"],
    ["provider_failed", "failed"],
    ["not_sent", "failed"],
    // No email was expected: no note, no alarm.
    ["skipped_no_email", null],
    ["not_configured", null],
  ] as Array<[ConfirmationOutcome, "sent" | "failed" | null]>)("%s → %s", (outcome, notice) => {
    expect(confirmationNoticeOf(outcome)).toBe(notice);
  });

  it("reads back only the two fixed words", () => {
    expect(parseConfirmationNotice("sent")).toBe("sent");
    expect(parseConfirmationNotice("failed")).toBe("failed");
    for (const value of [undefined, "", "SENT", "familia@example.com", ["sent"]]) {
      expect(parseConfirmationNotice(value)).toBeNull();
    }
  });

  it("the copy never implies the RSVP failed, nor names an address", () => {
    expect(es.rsvp.confirmation.failed).toContain("quedó guardada");
    for (const text of Object.values(es.rsvp.confirmation)) {
      expect(text).not.toMatch(/@/);
      expect(text).not.toContain(es.rsvp.errors.failed);
    }
  });
});
