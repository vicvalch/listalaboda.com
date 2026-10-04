import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super(url);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Redirect(url);
  }),
}));

const TOKEN = "T".repeat(43);
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: (name: string) => (name === "lb_guest_rsvp" ? { value: TOKEN } : undefined) })),
}));

const guestClient = vi.hoisted(() => ({ kind: "anon-guest-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => guestClient) }));

const getEmailDelivery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/delivery", () => ({ getEmailDelivery }));

const submitRsvpWithConfirmation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rsvp/confirmation", () => ({ submitRsvpWithConfirmation }));

const { submitRsvpAction } = await import("@/app/rsvp/actions");
const { es } = await import("@/lib/i18n/messages/es");

// The RSVP Server Action: the token comes only from the httpOnly cookie, the
// form only carries answers, and the RSVP result decides the response. The
// confirmation outcome adds at most a fixed word to the redirect.

const GUEST = "55555555-5555-4555-8555-555555555555";

function form(extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.append("guestId", GUEST);
  data.append(`attending-${GUEST}`, "yes");
  data.append(`dietaryNote-${GUEST}`, "");
  for (const [key, value] of Object.entries(extra)) data.append(key, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  submitRsvpWithConfirmation.mockReset();
});

describe("submitRsvpAction", () => {
  it("passes the cookie token, the parsed answers and the delivery FACTORY (not a value)", async () => {
    submitRsvpWithConfirmation.mockResolvedValue({ rsvp: "saved", party: {}, confirmation: "sent" });
    const forged = form({
      recipient: "atacante@example.com",
      to: "atacante@example.com",
      siteUrl: "https://evil.example.com",
      providerMessageId: "forged",
      token: "Z".repeat(43),
    });
    await redirectOf(submitRsvpAction(null, forged));
    expect(submitRsvpWithConfirmation).toHaveBeenCalledTimes(1);
    expect(submitRsvpWithConfirmation).toHaveBeenCalledWith(
      guestClient,
      TOKEN,
      [{ guestId: GUEST, attending: true, dietaryNote: null }],
      getEmailDelivery,
    );
    // The action itself never builds the delivery (the orchestration does,
    // after the save).
    expect(getEmailDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["sent", "/rsvp?saved=1&email=sent"],
    ["sent_but_unrecorded", "/rsvp?saved=1&email=sent"],
    ["provider_failed", "/rsvp?saved=1&email=failed"],
    ["not_sent", "/rsvp?saved=1&email=failed"],
    ["skipped_no_email", "/rsvp?saved=1"],
    ["not_configured", "/rsvp?saved=1"],
  ])("saved + %s → %s (always a success)", async (confirmation, url) => {
    submitRsvpWithConfirmation.mockResolvedValue({ rsvp: "saved", party: {}, confirmation });
    expect(await redirectOf(submitRsvpAction(null, form()))).toBe(url);
  });

  it("RSVP failures keep the existing failure UX", async () => {
    submitRsvpWithConfirmation.mockResolvedValue({ rsvp: "failed", reason: "unavailable" });
    expect(await redirectOf(submitRsvpAction(null, form()))).toBe("/rsvp");

    submitRsvpWithConfirmation.mockResolvedValue({ rsvp: "failed", reason: "stale" });
    expect(await submitRsvpAction(null, form())).toMatchObject({ ok: false, formError: es.rsvp.validation.stale });

    submitRsvpWithConfirmation.mockResolvedValue({ rsvp: "failed", reason: "error" });
    expect(await submitRsvpAction(null, form())).toMatchObject({ ok: false, formError: es.rsvp.errors.failed });
  });

  it("an invalid form never reaches the orchestration", async () => {
    const data = new FormData();
    data.append("guestId", GUEST);
    expect(await submitRsvpAction(null, data)).toMatchObject({ ok: false });
    expect(submitRsvpWithConfirmation).not.toHaveBeenCalled();
  });
});
