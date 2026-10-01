import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvError, getPublicEnv, parsePublicEnv } from "@/lib/env/public";

const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_VAR = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

const validSource = {
  [URL_VAR]: "http://127.0.0.1:54321",
  [KEY_VAR]: "sb_publishable_test_placeholder",
};

/** Builds an unsigned JWT-shaped string carrying the given role claim. */
function fakeJwt(role: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signature`;
}

describe("public env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes only the public configuration, never server secrets", () => {
    const env = parsePublicEnv({
      ...validSource,
      SUPABASE_SERVICE_ROLE_KEY: "server-secret-placeholder",
    });

    expect(Object.keys(env).sort()).toEqual(["supabasePublishableKey", "supabaseUrl"]);
    expect(Object.values(env)).not.toContain("server-secret-placeholder");
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("does not pick up the service-role key from process.env", () => {
    vi.stubEnv(URL_VAR, validSource[URL_VAR]);
    vi.stubEnv(KEY_VAR, validSource[KEY_VAR]);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-placeholder");

    expect(JSON.stringify(getPublicEnv())).not.toContain("server-secret-placeholder");
  });

  it.each([URL_VAR, KEY_VAR])("fails clearly when %s is missing", (name) => {
    const source = { ...validSource, [name]: "  " };
    expect(() => parsePublicEnv(source)).toThrow(EnvError);
    expect(() => parsePublicEnv(source)).toThrow(name);
  });

  it("rejects a non-URL Supabase URL", () => {
    expect(() => parsePublicEnv({ ...validSource, [URL_VAR]: "not a url" })).toThrow(
      EnvError,
    );
  });

  it("rejects a secret key configured as the public key", () => {
    expect(() =>
      parsePublicEnv({ ...validSource, [KEY_VAR]: "sb_secret_placeholder" }),
    ).toThrow(/secret\/service-role/);
  });

  it("rejects a legacy service_role JWT configured as the public key", () => {
    expect(() =>
      parsePublicEnv({ ...validSource, [KEY_VAR]: fakeJwt("service_role") }),
    ).toThrow(/secret\/service-role/);
  });

  it("accepts a legacy anon JWT", () => {
    expect(parsePublicEnv({ ...validSource, [KEY_VAR]: fakeJwt("anon") })).toBeTruthy();
  });

  it("does not echo the offending key value in errors", () => {
    const secret = "sb_secret_do_not_print_me";
    expect(() => parsePublicEnv({ ...validSource, [KEY_VAR]: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});
