import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  GUEST_RSVP_COOKIE,
  GUEST_RSVP_COOKIE_MAX_AGE_SECONDS,
  clearedGuestRsvpCookieOptions,
  guestRsvpCookieOptions,
} = await import("@/lib/rsvp/handoff");
const { INVITE_HANDOFF_COOKIE } = await import("@/lib/membership-invites/handoff");

describe("guest RSVP handoff cookie", () => {
  it("has its own name, distinct from the membership invite handoff", () => {
    expect(GUEST_RSVP_COOKIE).toBe("lb_guest_rsvp");
    expect(GUEST_RSVP_COOKIE).not.toBe(INVITE_HANDOFF_COOKIE);
  });

  it("is httpOnly, SameSite=Lax, scoped to /rsvp and short-lived (≤ 2 hours)", () => {
    const options = guestRsvpCookieOptions("production");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/rsvp" });
    expect(options.maxAge).toBe(GUEST_RSVP_COOKIE_MAX_AGE_SECONDS);
    expect(options.maxAge).toBeGreaterThanOrEqual(30 * 60);
    expect(options.maxAge).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("is Secure in production; only plain-http local development drops it", () => {
    expect(guestRsvpCookieOptions("production").secure).toBe(true);
    expect(guestRsvpCookieOptions("development").secure).toBe(false);
  });

  it("clears with the same scope and an immediate expiry", () => {
    expect(clearedGuestRsvpCookieOptions("production")).toEqual({
      ...guestRsvpCookieOptions("production"),
      maxAge: 0,
    });
  });
});
