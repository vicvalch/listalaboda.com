import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

vi.mock("server-only", () => ({}));

const {
  decryptRsvpCapability,
  encryptRsvpCapability,
  isWellFormedRsvpCapabilityEnvelope,
  parseRsvpCapabilityEncryptionSettings,
  RSVP_CAPABILITY_ENVELOPE_MAX_LENGTH,
} = await import("@/lib/security/rsvp-capability-encryption");
const { generateCapabilityToken } = await import("@/lib/security/capability-token");

// LB-13 (ADR-006): the recoverable form of a guest link. Keys here are
// fake, test-only values (src/test/fixtures/rsvp-capability-key.ts).

const KEY = TEST_RSVP_CAPABILITY_KEY;
const ENVELOPE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{58})\.([A-Za-z0-9_-]{22})$/;

function sealed() {
  const { token, tokenHash } = generateCapabilityToken();
  return { token, tokenHash, envelope: encryptRsvpCapability({ token, tokenHash, key: KEY }) };
}

function open(envelope: string, expectedTokenHash: string, key = KEY) {
  return decryptRsvpCapability({ envelope, expectedTokenHash, key });
}

/** Flips one bit of one base64url-encoded part (1 = iv, 2 = ciphertext, 3 = tag). */
function tamper(envelope: string, part: 1 | 2 | 3): string {
  const parts = envelope.split(".");
  const bytes = Buffer.from(parts[part]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  parts[part] = bytes.toString("base64url");
  return parts.join(".");
}

describe("RSVP capability encryption", () => {
  it("round-trips: the envelope opens to the same token with the same key and hash", () => {
    const { token, tokenHash, envelope } = sealed();
    expect(open(envelope, tokenHash)).toBe(token);
  });

  it("is not deterministic: the same token encrypted twice gives different envelopes", () => {
    const { token, tokenHash } = generateCapabilityToken();
    const a = encryptRsvpCapability({ token, tokenHash, key: KEY });
    const b = encryptRsvpCapability({ token, tokenHash, key: KEY });
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]); // fresh IV
    expect(open(a, tokenHash)).toBe(token);
    expect(open(b, tokenHash)).toBe(token);
  });

  it("uses the v1 envelope: 12-byte IV, 43-byte ciphertext, 16-byte tag, base64url", () => {
    const { envelope } = sealed();
    const match = ENVELOPE.exec(envelope);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1]!, "base64url")).toHaveLength(12);
    expect(Buffer.from(match![2]!, "base64url")).toHaveLength(43);
    expect(Buffer.from(match![3]!, "base64url")).toHaveLength(16);
    expect(envelope.length).toBeLessThanOrEqual(RSVP_CAPABILITY_ENVELOPE_MAX_LENGTH);
    expect(isWellFormedRsvpCapabilityEnvelope(envelope)).toBe(true);
  });

  it("never contains the plaintext token or its hash", () => {
    for (let i = 0; i < 20; i++) {
      const { token, tokenHash, envelope } = sealed();
      expect(envelope).not.toContain(token);
      expect(envelope).not.toContain(tokenHash);
      expect(Buffer.from(envelope.split(".")[2]!, "base64url").toString("utf8")).not.toBe(token);
    }
  });

  it("is bound to the expected token hash: another hash fails", () => {
    const { envelope } = sealed();
    const other = generateCapabilityToken();
    expect(open(envelope, other.tokenHash)).toBeNull();
  });

  it("an envelope swapped in from another party fails against this party's hash", () => {
    const mine = sealed();
    const theirs = sealed();
    expect(open(theirs.envelope, mine.tokenHash)).toBeNull();
  });

  it("fails with a different key", () => {
    const { tokenHash, envelope } = sealed();
    expect(open(envelope, tokenHash, WRONG_TEST_RSVP_CAPABILITY_KEY)).toBeNull();
  });

  it("doesn't use the token hash as the key: the hash's own bytes can't open it", () => {
    const { tokenHash, envelope } = sealed();
    expect(open(envelope, tokenHash, Buffer.from(tokenHash, "hex"))).toBeNull();
    expect(open(envelope, tokenHash, createHash("sha256").update(tokenHash).digest())).toBeNull();
  });

  it.each([
    { part: 1, name: "IV" },
    { part: 2, name: "ciphertext" },
    { part: 3, name: "auth tag" },
  ] as const)("detects a modified $name", ({ part }) => {
    const { tokenHash, envelope } = sealed();
    const modified = tamper(envelope, part);
    expect(modified).not.toBe(envelope);
    expect(isWellFormedRsvpCapabilityEnvelope(modified)).toBe(true);
    expect(open(modified, tokenHash)).toBeNull();
  });

  it("refuses malformed envelopes before decrypting", () => {
    const { tokenHash, envelope } = sealed();
    const [, iv, ct, tag] = envelope.split(".") as [string, string, string, string];
    const malformed = [
      "",
      envelope.slice(0, -1), // truncated tag
      envelope.slice(0, envelope.lastIndexOf(".")), // missing tag
      `${envelope}.extra`, // extra segment
      `v2.${iv}.${ct}.${tag}`, // unknown version
      `V1.${iv}.${ct}.${tag}`,
      `.${iv}.${ct}.${tag}`,
      `v1..${ct}.${tag}`, // empty component
      `v1.${iv}.${ct}.`,
      `v1.${iv}.${ct}.${tag}=`, // padding
      `v1.${iv}.${ct.slice(0, -1)}+.${tag}`, // not base64url
      `v1.${iv}.${ct.slice(0, -1)}/.${tag}`,
      `v1.${iv} .${ct}.${tag}`,
      `v1.${iv.slice(0, -2)}.${ct}.${tag}`, // wrong IV length
      `v1.${iv}.${ct}.${tag.slice(0, -2)}`, // wrong tag length
      `v1.${iv}.${ct}AAAA.${tag}`, // wrong ciphertext length
      `v1.${iv}.${"A".repeat(300)}.${tag}`, // oversized
    ];
    for (const value of malformed) {
      expect(isWellFormedRsvpCapabilityEnvelope(value), JSON.stringify(value)).toBe(false);
      expect(open(value, tokenHash), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses a plaintext that isn't a capability token, even when authentic", async () => {
    // Build an authentic envelope around a non-token of the right length
    // with the same primitives: decryption succeeds, the plaintext check fails.
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const notAToken = "!".repeat(43);
    const tokenHash = createHash("sha256").update(notAToken).digest("hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`listalaboda:rsvp-capability:v1:${tokenHash}`, "utf8"));
    const ct = Buffer.concat([cipher.update(notAToken, "utf8"), cipher.final()]);
    const envelope = ["v1", iv, ct, cipher.getAuthTag()]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
    expect(isWellFormedRsvpCapabilityEnvelope(envelope)).toBe(true);
    expect(open(envelope, tokenHash)).toBeNull();
  });

  it("refuses bad inputs to decryption without throwing", () => {
    const { envelope } = sealed();
    expect(open(envelope, "not-a-hash")).toBeNull();
    expect(open(envelope, "A".repeat(64))).toBeNull(); // uppercase hex isn't the stored form
    expect(open(envelope, sealed().tokenHash, Buffer.alloc(16))).toBeNull();
  });

  it("refuses to encrypt inconsistent input", () => {
    const { token, tokenHash } = generateCapabilityToken();
    const other = generateCapabilityToken();
    expect(() => encryptRsvpCapability({ token, tokenHash: other.tokenHash, key: KEY })).toThrow();
    expect(() => encryptRsvpCapability({ token: "short", tokenHash, key: KEY })).toThrow();
    expect(() => encryptRsvpCapability({ token, tokenHash, key: Buffer.alloc(31) })).toThrow();
    // Errors never echo the token.
    try {
      encryptRsvpCapability({ token, tokenHash: other.tokenHash, key: KEY });
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
});

describe("RSVP capability encryption settings", () => {
  const valid = TEST_RSVP_CAPABILITY_KEY.toString("base64url");

  it("accepts base64url of exactly 32 bytes", () => {
    const result = parseRsvpCapabilityEncryptionSettings({ RSVP_CAPABILITY_ENCRYPTION_KEY: valid });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.key.equals(TEST_RSVP_CAPABILITY_KEY)).toBe(true);
  });

  it("reports a missing key (and never generates one)", () => {
    expect(parseRsvpCapabilityEncryptionSettings({})).toEqual({ ok: false, problem: "missing" });
    expect(parseRsvpCapabilityEncryptionSettings({ RSVP_CAPABILITY_ENCRYPTION_KEY: "" })).toEqual({
      ok: false,
      problem: "missing",
    });
  });

  it.each([
    ["malformed base64url", "not base64url!"],
    ["standard base64 with padding", TEST_RSVP_CAPABILITY_KEY.toString("base64")],
    ["too short (31 bytes)", Buffer.alloc(31, 1).toString("base64url")],
    ["too long (33 bytes)", Buffer.alloc(33, 1).toString("base64url")],
    ["16 bytes", Buffer.alloc(16, 1).toString("base64url")],
    ["leading whitespace", ` ${valid}`],
    ["trailing newline", `${valid}\n`],
    ["inner whitespace", `${valid.slice(0, 10)} ${valid.slice(10)}`],
    ["non-canonical trailing bits", `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`],
  ])("rejects %s", (_case, value) => {
    expect(parseRsvpCapabilityEncryptionSettings({ RSVP_CAPABILITY_ENCRYPTION_KEY: value })).toEqual({
      ok: false,
      problem: "invalid",
    });
  });

  it("never echoes the value in its result", () => {
    const result = parseRsvpCapabilityEncryptionSettings({ RSVP_CAPABILITY_ENCRYPTION_KEY: "secret-ish value" });
    expect(JSON.stringify(result)).not.toContain("secret-ish");
  });
});
