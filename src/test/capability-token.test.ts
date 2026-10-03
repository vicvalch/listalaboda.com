import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { generateCapabilityToken, hashCapabilityToken, isWellFormedCapabilityToken } = await import(
  "@/lib/security/capability-token"
);
const { generateMembershipInviteToken, hashMembershipInviteToken } = await import(
  "@/lib/membership-invites/token"
);

describe("capability tokens (shared by membership invites and guest links)", () => {
  it("carries 256 bits from the CSPRNG, URL-safe", () => {
    const { token } = generateCapabilityToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("stores only a lowercase SHA-256 hex digest, never the token", () => {
    const { token, tokenHash } = generateCapabilityToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(tokenHash).not.toContain(token);
  });

  it("hashes deterministically; different tokens give different hashes", () => {
    const a = generateCapabilityToken();
    const b = generateCapabilityToken();
    expect(hashCapabilityToken(a.token)).toBe(a.tokenHash);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("produces no repeats across many draws", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateCapabilityToken().token));
    expect(tokens.size).toBe(1000);
  });

  it("rejects malformed input without echoing it", () => {
    for (const bad of ["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}/`]) {
      expect(isWellFormedCapabilityToken(bad)).toBe(false);
      expect(() => hashCapabilityToken(bad)).toThrow("Malformed capability token.");
    }
    try {
      hashCapabilityToken("secret-looking-value");
    } catch (error) {
      expect(String(error)).not.toContain("secret-looking-value");
    }
  });

  it("membership invites use the same primitive (same hash format)", () => {
    const invite = generateMembershipInviteToken();
    expect(hashCapabilityToken(invite.token)).toBe(invite.tokenHash);
    const capability = generateCapabilityToken();
    expect(hashMembershipInviteToken(capability.token)).toBe(capability.tokenHash);
  });
});
