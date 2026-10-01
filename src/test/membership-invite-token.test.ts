import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

// Vitest resolves `server-only` like a client bundle would; this file tests
// the module's behavior, and server-only-boundary.test.ts tests the guard.
vi.mock("server-only", () => ({}));

const {
  MEMBERSHIP_INVITE_TTL_MS,
  generateMembershipInviteToken,
  hashMembershipInviteToken,
  isWellFormedMembershipInviteToken,
  membershipInviteExpiresAt,
} = await import("@/lib/membership-invites/token");

describe("membership invite tokens", () => {
  it("encodes 256 bits of randomness as URL-safe base64url", () => {
    const { token } = generateMembershipInviteToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("returns the SHA-256 hex digest of the token, never the token itself", () => {
    const { token, tokenHash } = generateMembershipInviteToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(tokenHash).not.toContain(token);
  });

  it("hashes deterministically", () => {
    const { token, tokenHash } = generateMembershipInviteToken();
    expect(hashMembershipInviteToken(token)).toBe(tokenHash);
    expect(hashMembershipInviteToken(token)).toBe(hashMembershipInviteToken(token));
  });

  it("produces distinct tokens and hashes", () => {
    const generated = Array.from({ length: 200 }, generateMembershipInviteToken);
    expect(new Set(generated.map((g) => g.token)).size).toBe(200);
    expect(new Set(generated.map((g) => g.tokenHash)).size).toBe(200);
  });

  it("uses the CSPRNG, not Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    generateMembershipInviteToken();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(["", "short", "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`])(
    "rejects malformed token %#",
    (value) => {
      expect(isWellFormedMembershipInviteToken(value)).toBe(false);
      expect(() => hashMembershipInviteToken(value)).toThrow(
        "Malformed membership invite token.",
      );
    },
  );

  it("does not echo a malformed token in the error", () => {
    const value = "not-a-valid-token-but-maybe-sensitive";
    expect(() => hashMembershipInviteToken(value)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(value) }),
    );
  });

  it("expires invites after a bounded TTL within the database's 30-day cap", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const expiresAt = membershipInviteExpiresAt(now);

    expect(expiresAt.getTime() - now.getTime()).toBe(MEMBERSHIP_INVITE_TTL_MS);
    expect(MEMBERSHIP_INVITE_TTL_MS).toBeGreaterThan(0);
    expect(MEMBERSHIP_INVITE_TTL_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});
