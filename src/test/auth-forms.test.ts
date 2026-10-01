import { describe, expect, it } from "vitest";

import { normalizeSignInError, normalizeSignUpError } from "@/lib/auth/errors";
import { parseCredentials } from "@/lib/auth/validation";
import { es } from "@/lib/i18n/messages/es";

describe("parseCredentials", () => {
  it("normalizes the email and keeps the password untouched", () => {
    const result = parseCredentials(
      { email: "  Ana@Example.TEST ", password: " pass word 123 " },
      "signup",
    );
    expect(result).toEqual({
      ok: true,
      credentials: { email: "ana@example.test", password: " pass word 123 " },
    });
  });

  it("requires both fields with Spanish messages", () => {
    expect(parseCredentials({ email: "", password: "" }, "login")).toEqual({
      ok: false,
      fieldErrors: {
        email: es.auth.validation.emailRequired,
        password: es.auth.validation.passwordRequired,
      },
    });
  });

  it.each(["no-at-sign", "a@b", "a @b.test", "@example.test"])("rejects email %j", (email) => {
    const result = parseCredentials({ email, password: "long-enough-password" }, "login");
    expect(result).toMatchObject({ ok: false, fieldErrors: { email: es.auth.validation.emailInvalid } });
  });

  it("enforces the minimum length only on sign-up", () => {
    expect(parseCredentials({ email: "a@b.test", password: "short" }, "signup")).toMatchObject({
      ok: false,
      fieldErrors: { password: es.auth.validation.passwordTooShort },
    });
    expect(parseCredentials({ email: "a@b.test", password: "short" }, "login").ok).toBe(true);
  });

  it("rejects passwords over 72 bytes (bcrypt limit)", () => {
    const result = parseCredentials({ email: "a@b.test", password: "ñ".repeat(37) }, "signup");
    expect(result).toMatchObject({ ok: false, fieldErrors: { password: es.auth.validation.passwordTooLong } });
  });

  it("never echoes the password in errors", () => {
    const password = "secret-ish";
    const result = parseCredentials({ email: "bad", password }, "login");
    expect(JSON.stringify(result)).not.toContain(password);
  });
});

describe("normalizeSignInError", () => {
  it("gives one generic message for wrong password and unknown account", () => {
    const wrongPassword = normalizeSignInError({ code: "invalid_credentials", status: 400 });
    const unknown = normalizeSignInError({ code: "user_not_found", status: 400 });
    const uncoded = normalizeSignInError({ status: 400 });
    expect(wrongPassword).toEqual({ formError: es.auth.login.invalidCredentials });
    expect(unknown).toEqual(wrongPassword);
    expect(uncoded).toEqual(wrongPassword);
  });

  it("maps rate limiting and unconfirmed email", () => {
    expect(normalizeSignInError({ code: "over_request_rate_limit", status: 429 })).toEqual({
      formError: es.auth.rateLimited,
    });
    expect(normalizeSignInError({ code: "email_not_confirmed", status: 400 })).toEqual({
      formError: es.auth.login.emailNotConfirmed,
    });
  });

  it("treats server failures as unexpected, not as bad credentials", () => {
    expect(normalizeSignInError({ status: 500 })).toEqual({ formError: es.common.unexpectedError });
    expect(normalizeSignInError({})).toEqual({ formError: es.common.unexpectedError });
  });
});

describe("normalizeSignUpError", () => {
  it("answers an existing account exactly like a confirmation-required sign-up", () => {
    expect(normalizeSignUpError({ code: "user_already_exists", status: 422 })).toEqual({
      kind: "confirmation_required",
    });
    expect(normalizeSignUpError({ code: "email_exists", status: 422 })).toEqual({
      kind: "confirmation_required",
    });
  });

  it("maps weak passwords and invalid emails to field errors", () => {
    expect(normalizeSignUpError({ code: "weak_password" })).toEqual({
      kind: "field",
      field: "password",
      message: es.auth.signup.weakPassword,
    });
    expect(normalizeSignUpError({ code: "email_address_invalid" })).toEqual({
      kind: "field",
      field: "email",
      message: es.auth.validation.emailInvalid,
    });
  });

  it("never surfaces unknown Auth errors verbatim", () => {
    expect(normalizeSignUpError({ code: "something_new", status: 500 })).toEqual({
      kind: "form",
      message: es.common.unexpectedError,
    });
  });
});
