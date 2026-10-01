import { describe, expect, it } from "vitest";

import {
  DEFAULT_NEXT_PATH,
  INVITE_CONTINUE_PATH,
  loginPath,
  safeNextPath,
  signupPath,
} from "@/lib/auth/redirect";

describe("safeNextPath", () => {
  it.each([
    "/app",
    "/app/weddings/abc",
    "/app/weddings/0b8f8a1e-5b0c-4a53-9d55-2b0a7a3a9f10",
    INVITE_CONTINUE_PATH,
    "/app?tab=x",
    "/app#top",
  ])("allows the internal path %s", (value) => {
    expect(safeNextPath(value)).toBe(value);
  });

  it.each([
    // Absolute URLs
    "https://evil.example",
    "http://evil.example",
    "HTTPS://evil.example/app",
    // Protocol-relative and slash/backslash tricks
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "\\evil.example",
    "/\t/evil.example",
    "/ /evil.example",
    // Schemes
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    // Encoded variants
    "/%2F/evil.example",
    "%2F%2Fevil.example",
    "/%5Cevil.example",
    "/%5C%5Cevil.example",
    "/%09/evil.example",
    // Dot segments that normalize into a protocol-relative URL
    "/.//evil.example",
    "/..//evil.example",
    "/app/..//evil.example",
    "/%2E//evil.example",
    "%68ttps://evil.example",
    // Malformed / not a path
    "app",
    "",
    "evil.example",
    "/%E0%A4%A",
    `/${"a".repeat(600)}`,
  ])("rejects %j", (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([undefined, null, 42, ["/app"], { href: "/app" }])(
    "falls back to /app for non-string %j",
    (value) => {
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    },
  );

  it("never returns anything that resolves to another origin", () => {
    const tricky = ["/app", "//x", "/\\x", "/%2F%2Fx", "https://x", "/.//x", "/..//x"];
    for (const value of tricky) {
      const resolved = new URL(safeNextPath(value), "https://listalaboda.com");
      expect(resolved.origin).toBe("https://listalaboda.com");
    }
  });
});

describe("login/signup paths", () => {
  it("omit the default destination", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath("/app")).toBe("/login");
    expect(signupPath(undefined)).toBe("/signup");
  });

  it("carry a validated continuation, URL-encoded", () => {
    expect(loginPath(INVITE_CONTINUE_PATH)).toBe("/login?next=%2Finvite%2Fcontinue");
    expect(signupPath("/app/weddings/abc")).toBe("/signup?next=%2Fapp%2Fweddings%2Fabc");
  });

  it("drop unsafe continuations", () => {
    expect(loginPath("https://evil.example")).toBe("/login");
    expect(signupPath("//evil.example")).toBe("/signup");
  });
});
