import * as nodeCrypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Spy on the comparison without changing it.
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { CRON_SECRET_MIN_BYTES, authenticateCronRequest, getCronSecret, parseCronSecret } = await import(
  "@/lib/scheduler/cron-auth"
);

// LB-17 (ADR-010 §4): the scheduler route's secret boundary. Fake values only.

const SECRET = "test-only-cron-secret-0123456789abcdefghij";

describe("parseCronSecret", () => {
  it("requires at least 32 bytes and no whitespace or control characters", () => {
    expect(CRON_SECRET_MIN_BYTES).toBe(32);
    expect(parseCronSecret(undefined)).toBeNull();
    expect(parseCronSecret("")).toBeNull();
    expect(parseCronSecret("x".repeat(31))).toBeNull();
    expect(parseCronSecret(`${"x".repeat(32)} `)).toBeNull();
    expect(parseCronSecret(`${"x".repeat(32)}\n`)).toBeNull();
    expect(parseCronSecret("x".repeat(32))).not.toBeNull();
    expect(parseCronSecret(SECRET)).not.toBeNull();
  });

  it("never keeps the secret itself, only a digest", () => {
    const parsed = parseCronSecret(SECRET);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});

describe("authenticateCronRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(nodeCrypto.timingSafeEqual).mockClear();
  });

  const secret = parseCronSecret(SECRET);

  it("not configured → nothing is authorized", () => {
    expect(authenticateCronRequest(`Bearer ${SECRET}`, null)).toBe("not_configured");
  });

  it("only the exact Bearer secret is authorized", () => {
    expect(authenticateCronRequest(`Bearer ${SECRET}`, secret)).toBe("authorized");
    for (const header of [
      null,
      "",
      SECRET,
      `bearer ${SECRET}`,
      `Basic ${SECRET}`,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer  ${SECRET}`,
      `Bearer ${SECRET} extra`,
      "Bearer ",
    ]) {
      expect(authenticateCronRequest(header, secret), String(header)).toBe("unauthorized");
    }
  });

  it("always compares with timingSafeEqual, even when the header is missing or wrong", () => {
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    authenticateCronRequest(null, secret);
    authenticateCronRequest("Bearer nope", secret);
    authenticateCronRequest(`Bearer ${SECRET}`, secret);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("reads CRON_SECRET from the server environment only", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(authenticateCronRequest(`Bearer ${SECRET}`, getCronSecret())).toBe("authorized");
    vi.stubEnv("CRON_SECRET", "short");
    expect(getCronSecret()).toBeNull();
    vi.stubEnv("CRON_SECRET", "");
    expect(getCronSecret()).toBeNull();
  });
});
