import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  INVITE_HANDOFF_COOKIE,
  INVITE_HANDOFF_MAX_AGE_SECONDS,
  clearedInviteHandoffCookieOptions,
  inviteHandoffCookieOptions,
} = await import("@/lib/membership-invites/handoff");

describe("invite handoff cookie", () => {
  it("has an application-specific name", () => {
    expect(INVITE_HANDOFF_COOKIE).toBe("lb_membership_invite");
  });

  it("is httpOnly, SameSite=Lax and short-lived (10–30 minutes)", () => {
    const options = inviteHandoffCookieOptions("production");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(options.maxAge).toBe(INVITE_HANDOFF_MAX_AGE_SECONDS);
    expect(options.maxAge).toBeGreaterThanOrEqual(10 * 60);
    expect(options.maxAge).toBeLessThanOrEqual(30 * 60);
  });

  it("is Secure in production; only plain-http local development drops it", () => {
    expect(inviteHandoffCookieOptions("production").secure).toBe(true);
    expect(inviteHandoffCookieOptions("development").secure).toBe(false);
    expect(inviteHandoffCookieOptions(undefined).secure).toBe(false);
  });

  it("clears with the same scope and an immediate expiry", () => {
    const cleared = clearedInviteHandoffCookieOptions("production");
    expect(cleared).toEqual({ ...inviteHandoffCookieOptions("production"), maxAge: 0 });
  });
});
