import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
const requestHeaders = vi.hoisted(() => ({ value: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.value }));

const currentUser = vi.hoisted(() => ({ value: null as { id: string; email: string | null } | null }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => currentUser.value) }));
const accounts = vi.hoisted(() => ({ getCurrentAccountType: vi.fn() }));
vi.mock("@/lib/accounts/session", () => accounts);

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  getClaims: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => ({ auth })) }));

const { requestPasswordResetAction, resetPasswordAction } = await import("@/app/(auth)/actions");
const { getRecoveryUser } = await import("@/lib/auth/recovery-session");
const { LoginForm } = await import("@/app/(auth)/login/LoginForm");
const { default: ResetPasswordPage } = await import("@/app/(auth)/reset-password/page");
const { GET: callback } = await import("@/app/auth/callback/route");
const { NextRequest } = await import("next/server");
const { es } = await import("@/lib/i18n/messages/es");

// AUTH-RECOVERY-01/-02: the actions, the reset page gate and the shared callback,
// with Supabase Auth faked at the client boundary (no real Auth or mailer).

const USER = { id: "user-1", email: "persona@example.test" };
const nowSeconds = () => Math.floor(Date.now() / 1000);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function recoveryClaims(age = 60, sub = USER.id, method = "recovery") {
  return { data: { claims: { sub, amr: [{ method, timestamp: nowSeconds() - age }] } }, error: null };
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const match = /^NEXT_REDIRECT (.*)$/.exec((error as Error).message);
    if (match) return match[1];
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_ORIGIN", "https://bodas.example.com");
  requestHeaders.value = new Headers({ origin: "https://evil.example", host: "evil.example" });
  currentUser.value = null;
  for (const fn of Object.values(auth)) fn.mockReset();
  accounts.getCurrentAccountType.mockReset();
  navigation.redirect.mockClear();
});

describe("login page", () => {
  it("offers the forgot-password link, keeping a safe continuation", () => {
    const html = renderToStaticMarkup(createElement(LoginForm, { next: "/invite/continue" }));
    expect(html).toContain(es.auth.login.forgotPassword);
    expect(html).toContain('href="/forgot-password?next=%2Finvite%2Fcontinue"');
  });
});

describe("requestPasswordResetAction", () => {
  it("asks Supabase Auth with the normalized email and the canonical APP_ORIGIN callback, never the request's host", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const state = await requestPasswordResetAction(null, form({ email: " Ana@Example.TEST ", next: "https://evil.example" }));
    expect(state).toEqual({ ok: true, data: { requested: true } });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("ana@example.test", {
      redirectTo: "https://bodas.example.com/auth/callback?next=%2Freset-password",
    });
    expect(JSON.stringify(auth.resetPasswordForEmail.mock.calls)).not.toContain("evil.example");
  });

  it("gives a known and an unknown address the same visible result", async () => {
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    const known = await requestPasswordResetAction(null, form({ email: "existe@example.test" }));
    // Auth's per-address resend interval only applies to an account that exists.
    auth.resetPasswordForEmail.mockResolvedValueOnce({
      data: null,
      error: { code: "over_email_send_rate_limit", status: 429 },
    });
    const throttledKnown = await requestPasswordResetAction(null, form({ email: "existe@example.test" }));
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    const unknown = await requestPasswordResetAction(null, form({ email: "nadie@example.test" }));
    auth.resetPasswordForEmail.mockRejectedValueOnce(new Error("mailer down"));
    const failed = await requestPasswordResetAction(null, form({ email: "existe@example.test" }));
    expect(known).toEqual(unknown);
    expect(throttledKnown).toEqual(unknown);
    expect(failed).toEqual(unknown);
  });

  it("rejects an invalid email locally, without calling Auth", async () => {
    const state = await requestPasswordResetAction(null, form({ email: "no-es-un-correo" }));
    expect(state).toEqual({
      ok: false,
      fieldErrors: { email: es.auth.validation.emailInvalid },
      values: { email: "no-es-un-correo" },
    });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("maps the per-client request limit to friendly copy", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: { code: "over_request_rate_limit", status: 429 } });
    const state = await requestPasswordResetAction(null, form({ email: "ana@example.test" }));
    expect(state).toMatchObject({ ok: false, formError: es.auth.rateLimited });
    expect(auth.resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });

  it("without APP_ORIGIN, sends nothing outside local development", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const state = await requestPasswordResetAction(null, form({ email: "ana@example.test" }));
    expect(state).toMatchObject({ ok: false, formError: es.auth.forgotPassword.unavailable });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("without APP_ORIGIN, a local development request uses its own origin", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    requestHeaders.value = new Headers({ origin: "http://localhost:3000" });
    auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    await requestPasswordResetAction(null, form({ email: "ana@example.test" }));
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("ana@example.test", {
      redirectTo: "http://localhost:3000/auth/callback?next=%2Freset-password",
    });
  });
});

describe("getRecoveryUser (the reset gate)", () => {
  it.each([
    ["a recent PKCE recovery (amr recovery, AUTH-RECOVERY-01)", "recovery"],
    ["a recent token-hash recovery (amr otp, AUTH-RECOVERY-02)", "otp"],
  ])("is the validated user for %s", async (_label, method) => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims(60, USER.id, method));
    expect(await getRecoveryUser()).toEqual(USER);
  });

  it("INTENTIONALLY accepts a fresh magic-link / email-OTP sign-in (amr otp) for the same 30 minutes", async () => {
    // Accepted product decision (AUTH-RECOVERY-02): Supabase records a
    // magic-link sign-in exactly like a token-hash recovery; both prove fresh
    // control of the account's email.
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims(29 * 60, USER.id, "otp"));
    expect(await getRecoveryUser()).toEqual(USER);
    auth.getClaims.mockResolvedValue(recoveryClaims(31 * 60, USER.id, "otp"));
    expect(await getRecoveryUser()).toBeNull();
  });

  it.each([
    ["no user", null, recoveryClaims()],
    ["an ordinary sign-in", USER, { data: { claims: { sub: USER.id, amr: [{ method: "password", timestamp: nowSeconds() }] } }, error: null }],
    ["an expired recovery", USER, recoveryClaims(31 * 60)],
    ["an expired otp verification", USER, recoveryClaims(31 * 60, USER.id, "otp")],
    ["an unknown method", USER, recoveryClaims(60, USER.id, "sso/saml")],
    ["a missing amr", USER, { data: { claims: { sub: USER.id } }, error: null }],
    ["claims of another user", USER, recoveryClaims(60, "user-2")],
    ["otp claims of another user", USER, recoveryClaims(60, "user-2", "otp")],
    ["a claims failure", USER, { data: null, error: { code: "bad_jwt" } }],
  ])("refuses %s", async (_label, user, claims) => {
    currentUser.value = user;
    auth.getClaims.mockResolvedValue(claims);
    expect(await getRecoveryUser()).toBeNull();
  });
});

describe("reset password page", () => {
  async function render(): Promise<string> {
    return renderToStaticMarkup((await ResetPasswordPage({ searchParams: Promise.resolve({}) } as never)) as ReactElement);
  }

  it("without a recovery session, explains and links to a new request (no form)", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: USER.id, amr: [{ method: "password", timestamp: nowSeconds() }] } }, error: null });
    const html = await render();
    expect(html).toContain(es.auth.resetPassword.invalidTitle);
    expect(html).toContain('href="/forgot-password"');
    expect(html).not.toContain('name="password"');
  });

  it("with a recovery session, shows both password fields for that account", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    const html = await render();
    expect(html).toContain('name="password"');
    expect(html).toContain('name="confirmPassword"');
    expect(html).toContain(USER.email);
  });
});

describe("resetPasswordAction", () => {
  const valid = { password: "nueva-clave-123", confirmPassword: "nueva-clave-123" };

  it("requires a recovery session: otherwise back to the request page, nothing updated", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: USER.id, amr: [{ method: "password", timestamp: nowSeconds() }] } }, error: null });
    expect(await redirectOf(resetPasswordAction(null, form(valid)))).toBe("/forgot-password?error=expired");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects a mismatch without calling Auth", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    const state = await resetPasswordAction(null, form({ password: "nueva-clave-123", confirmPassword: "otra-clave-123" }));
    expect(state).toEqual({ ok: false, fieldErrors: { confirmPassword: es.auth.validation.passwordMismatch } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("updates only the password (never a user id from the form)", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    accounts.getCurrentAccountType.mockResolvedValue("planner");
    await redirectOf(resetPasswordAction(null, form({ ...valid, userId: "someone-else", email: "x@example.test" })));
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "nueva-clave-123" });
    expect(accounts.getCurrentAccountType).toHaveBeenCalledWith(USER.id);
  });

  it.each([
    [null, "/onboarding/account-type"],
    ["planner", "/app"],
    ["couple", "/app"],
  ] as const)("routes account type %s to %s after the update", async (type, path) => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    accounts.getCurrentAccountType.mockResolvedValue(type);
    expect(await redirectOf(resetPasswordAction(null, form(valid)))).toBe(path);
  });

  it("treats a session that expired at Auth as expired", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    auth.updateUser.mockResolvedValue({ data: null, error: { code: "session_not_found", status: 403 } });
    expect(await redirectOf(resetPasswordAction(null, form(valid)))).toBe("/forgot-password?error=expired");
  });

  it("keeps the user on the form for a password Auth refuses", async () => {
    currentUser.value = USER;
    auth.getClaims.mockResolvedValue(recoveryClaims());
    auth.updateUser.mockResolvedValue({ data: null, error: { code: "same_password", status: 422 } });
    expect(await resetPasswordAction(null, form(valid))).toEqual({
      ok: false,
      fieldErrors: { password: es.auth.resetPassword.samePassword },
    });
  });
});

describe("auth callback", () => {
  function request(query: string) {
    return new NextRequest(`https://bodas.example.com/auth/callback${query}`);
  }

  it("continues a recovery exchange to the reset page", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    const response = await callback(request("?code=abc&next=%2Freset-password"));
    expect(response.headers.get("location")).toBe("https://bodas.example.com/reset-password");
  });

  it("sends an invalid or expired recovery link to the request page", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: { code: "flow_state_expired" } });
    const failed = await callback(request("?code=abc&next=%2Freset-password"));
    expect(failed.headers.get("location")).toBe("https://bodas.example.com/forgot-password?error=link");
    // Supabase's own error redirect (no code) lands there too.
    const denied = await callback(request("?error=access_denied&error_code=otp_expired&next=%2Freset-password"));
    expect(denied.headers.get("location")).toBe("https://bodas.example.com/forgot-password?error=link");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("still exchanges a signup confirmation and continues to its own destination (unchanged)", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    const response = await callback(request("?code=abc&next=%2Finvite%2Fcontinue"));
    expect(response.headers.get("location")).toBe("https://bodas.example.com/invite/continue");
    const open = await callback(request("?code=abc&next=https%3A%2F%2Fevil.example"));
    expect(open.headers.get("location")).toBe("https://bodas.example.com/app");
  });

  it("keeps the login error for other flows", async () => {
    const response = await callback(request("?next=%2Fapp"));
    expect(response.headers.get("location")).toBe("https://bodas.example.com/login?error=callback");
  });
});
