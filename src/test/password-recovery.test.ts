import { describe, expect, it } from "vitest";

import { ACCOUNT_TYPE_ONBOARDING_PATH } from "@/lib/accounts/account-type";
import {
  normalizePasswordResetRequestError,
  normalizePasswordUpdateError,
  normalizeRecoveryVerifyError,
} from "@/lib/auth/errors";
import {
  afterPasswordResetPath,
  callbackFailurePath,
  forgotPasswordPath,
  hasRecentRecovery,
  isWellFormedRecoveryTokenHash,
  RECOVERY_SESSION_MAX_AGE_SECONDS,
  recoveryNext,
  recoveryRedirectUrl,
  resetPasswordPath,
} from "@/lib/auth/recovery";
import { parseEmail, parseNewPassword } from "@/lib/auth/validation";
import { es } from "@/lib/i18n/messages/es";

// AUTH-RECOVERY-01: the pure rules of password recovery.

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const nowSeconds = NOW / 1000;

describe("recovery paths", () => {
  it("returns the emailed link to the shared callback, continuing to the reset page", () => {
    expect(recoveryRedirectUrl("https://bodas.example.com")).toBe(
      "https://bodas.example.com/auth/callback?next=%2Freset-password",
    );
    expect(recoveryRedirectUrl("http://localhost:3100", "/invite/continue")).toBe(
      "http://localhost:3100/auth/callback?next=%2Freset-password%3Fnext%3D%252Finvite%252Fcontinue",
    );
  });

  it.each(["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/%2F%2Fevil.example"])(
    "never carries an external continuation (%j)",
    (next) => {
      expect(recoveryNext(next)).toBe("/app");
      expect(recoveryRedirectUrl("https://bodas.example.com", next)).toBe(
        "https://bodas.example.com/auth/callback?next=%2Freset-password",
      );
    },
  );

  it("never continues into a recovery page itself", () => {
    expect(recoveryNext("/reset-password")).toBe("/app");
    expect(recoveryNext("/forgot-password?error=link")).toBe("/app");
    expect(resetPasswordPath("/reset-password?next=%2Fapp")).toBe("/reset-password");
  });

  it("builds the request page with a validated continuation and a fixed notice", () => {
    expect(forgotPasswordPath()).toBe("/forgot-password");
    expect(forgotPasswordPath("/invite/continue")).toBe("/forgot-password?next=%2Finvite%2Fcontinue");
    expect(forgotPasswordPath("https://evil.example", "expired")).toBe("/forgot-password?error=expired");
  });

  it("sends a failed recovery exchange to the request page, anything else to login", () => {
    expect(callbackFailurePath("/reset-password")).toBe("/forgot-password?error=link");
    expect(callbackFailurePath("/reset-password?next=%2Finvite%2Fcontinue")).toBe(
      "/forgot-password?next=%2Finvite%2Fcontinue&error=link",
    );
    expect(callbackFailurePath("/app")).toBe("/login?error=callback");
    expect(callbackFailurePath("/reset-passwordx")).toBe("/login?error=callback");
  });
});

describe("hasRecentRecovery", () => {
  it("accepts a recovery verification within the allowed age", () => {
    expect(hasRecentRecovery([{ method: "recovery", timestamp: nowSeconds - 60 }], NOW)).toBe(true);
    expect(
      hasRecentRecovery([{ method: "recovery", timestamp: nowSeconds - RECOVERY_SESSION_MAX_AGE_SECONDS }], NOW),
    ).toBe(true);
  });

  it("accepts a fresh token-hash verification (amr otp, AUTH-RECOVERY-02)", () => {
    expect(hasRecentRecovery([{ method: "otp", timestamp: nowSeconds - 60 }], NOW)).toBe(true);
    expect(hasRecentRecovery([{ method: "otp", timestamp: nowSeconds - RECOVERY_SESSION_MAX_AGE_SECONDS }], NOW)).toBe(true);
  });

  it("refuses a stale otp verification", () => {
    expect(
      hasRecentRecovery([{ method: "otp", timestamp: nowSeconds - RECOVERY_SESSION_MAX_AGE_SECONDS - 1 }], NOW),
    ).toBe(false);
  });

  it.each(["oauth", "sso/saml", "totp", "anonymous", "Recovery", "OTP", ""])("refuses the method %j", (method) => {
    expect(hasRecentRecovery([{ method, timestamp: nowSeconds - 5 }], NOW)).toBe(false);
  });

  it("refuses an ordinary sign-in session", () => {
    expect(hasRecentRecovery([{ method: "password", timestamp: nowSeconds - 5 }], NOW)).toBe(false);
  });

  it("refuses an expired recovery session", () => {
    expect(
      hasRecentRecovery([{ method: "recovery", timestamp: nowSeconds - RECOVERY_SESSION_MAX_AGE_SECONDS - 1 }], NOW),
    ).toBe(false);
  });

  it.each([
    ["no claim", undefined],
    ["plain strings (no time)", ["recovery"]],
    ["a non-numeric time", [{ method: "recovery", timestamp: "now" }]],
    ["a time far in the future", [{ method: "recovery", timestamp: nowSeconds + 3600 }]],
    ["null entries", [null]],
  ])("refuses %s", (_label, amr) => {
    expect(hasRecentRecovery(amr, NOW)).toBe(false);
  });
});

describe("afterPasswordResetPath", () => {
  it("sends an account without a type to the onboarding choice", () => {
    expect(afterPasswordResetPath(null, "/app")).toBe(ACCOUNT_TYPE_ONBOARDING_PATH);
    expect(afterPasswordResetPath(null, "/invite/continue")).toBe(
      `${ACCOUNT_TYPE_ONBOARDING_PATH}?next=%2Finvite%2Fcontinue`,
    );
  });

  it.each(["planner", "couple"] as const)("sends a %s to the role-aware /app entry", (type) => {
    expect(afterPasswordResetPath(type, undefined)).toBe("/app");
    expect(afterPasswordResetPath(type, "https://evil.example")).toBe("/app");
  });

  it("continues to /app when the type couldn't be read (its guard re-reads)", () => {
    expect(afterPasswordResetPath(undefined, "/app")).toBe("/app");
  });
});

describe("parseEmail", () => {
  it("normalizes a valid address", () => {
    expect(parseEmail("  Ana@Example.TEST ")).toEqual({ ok: true, email: "ana@example.test" });
  });

  it.each([
    ["", es.auth.validation.emailRequired],
    ["no-at-sign", es.auth.validation.emailInvalid],
    ["a @b.test", es.auth.validation.emailInvalid],
  ])("rejects %j locally", (value, message) => {
    expect(parseEmail(value)).toEqual({ ok: false, fieldErrors: { email: message } });
  });
});

describe("parseNewPassword", () => {
  it("accepts matching passwords that meet the sign-up policy", () => {
    expect(parseNewPassword({ password: "nueva-clave-123", confirmPassword: "nueva-clave-123" })).toEqual({
      ok: true,
      password: "nueva-clave-123",
    });
  });

  it("rejects a mismatch", () => {
    expect(parseNewPassword({ password: "nueva-clave-123", confirmPassword: "nueva-clave-124" })).toEqual({
      ok: false,
      fieldErrors: { confirmPassword: es.auth.validation.passwordMismatch },
    });
  });

  it("applies the sign-up length rules", () => {
    expect(parseNewPassword({ password: "corta", confirmPassword: "corta" })).toMatchObject({
      ok: false,
      fieldErrors: { password: es.auth.validation.passwordTooShort },
    });
    expect(parseNewPassword({ password: "ñ".repeat(37), confirmPassword: "ñ".repeat(37) })).toMatchObject({
      ok: false,
      fieldErrors: { password: es.auth.validation.passwordTooLong },
    });
  });

  it("requires both fields and never echoes a password", () => {
    const result = parseNewPassword({ password: "", confirmPassword: "" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        password: es.auth.validation.passwordRequired,
        confirmPassword: es.auth.validation.confirmPasswordRequired,
      },
    });
    expect(JSON.stringify(parseNewPassword({ password: "secret-ish-1", confirmPassword: "x" }))).not.toContain(
      "secret-ish-1",
    );
  });
});

describe("normalizePasswordResetRequestError", () => {
  it.each([
    "over_email_send_rate_limit",
    "user_not_found",
    "unexpected_failure",
    undefined,
  ])("answers %s exactly like a successful request (no enumeration)", (code) => {
    expect(normalizePasswordResetRequestError({ code, status: 429 })).toEqual({ kind: "requested" });
  });

  it("reports the per-client request limit, which doesn't depend on any account", () => {
    expect(normalizePasswordResetRequestError({ code: "over_request_rate_limit", status: 429 })).toEqual({
      kind: "form",
      message: es.auth.rateLimited,
    });
  });
});

describe("normalizePasswordUpdateError", () => {
  it("maps password policy errors to the password field", () => {
    expect(normalizePasswordUpdateError({ code: "weak_password", status: 422 })).toEqual({
      kind: "field",
      message: es.auth.signup.weakPassword,
    });
    expect(normalizePasswordUpdateError({ code: "same_password", status: 422 })).toEqual({
      kind: "field",
      message: es.auth.resetPassword.samePassword,
    });
  });

  it.each([
    [{ code: "session_not_found", status: 403 }],
    [{ code: "bad_jwt", status: 401 }],
    [{ status: 401 }],
  ])("treats a missing or invalid session (%j) as expired", (error) => {
    expect(normalizePasswordUpdateError(error)).toEqual({ kind: "session_expired" });
  });

  it("never surfaces unknown Auth errors verbatim", () => {
    expect(normalizePasswordUpdateError({ code: "something_new", status: 500 })).toEqual({
      kind: "form",
      message: es.common.unexpectedError,
    });
  });
});

describe("isWellFormedRecoveryTokenHash", () => {
  it.each(["pkce_" + "a1".repeat(28), "0f".repeat(28), "ab".repeat(64)])("accepts a token hash shape (%#)", (value) => {
    expect(isWellFormedRecoveryTokenHash(value)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["too short", "ab".repeat(10)],
    ["too long", "ab".repeat(65)],
    ["uppercase", "AB".repeat(28)],
    ["a control character", `${"ab".repeat(28)}\n`],
    ["a space inside", `${"ab".repeat(14)} ${"ab".repeat(14)}`],
    ["another prefix", `pkce-${"ab".repeat(28)}`],
    ["a URL", "https://evil.example/" + "ab".repeat(28)],
    ["not a string", 42],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedRecoveryTokenHash(value)).toBe(false);
  });
});

describe("normalizeRecoveryVerifyError", () => {
  it.each([
    [{ code: "otp_expired", status: 403 }],
    [{ code: "validation_failed", status: 400 }],
    [{ status: 422 }],
  ])("a definitive refusal (%j) means a new link is needed", (error) => {
    expect(normalizeRecoveryVerifyError(error)).toEqual({ kind: "invalid" });
  });

  it("a limit keeps the token for another try, with friendly copy", () => {
    expect(normalizeRecoveryVerifyError({ code: "over_request_rate_limit", status: 429 })).toEqual({
      kind: "retry",
      message: es.auth.rateLimited,
    });
  });

  it.each([[{ status: 500 }], [{ status: 0 }], [{}]])("a failure on our side (%j) keeps the token, no raw error", (error) => {
    expect(normalizeRecoveryVerifyError(error)).toEqual({ kind: "retry", message: es.auth.recoveryConfirm.retry });
  });
});
