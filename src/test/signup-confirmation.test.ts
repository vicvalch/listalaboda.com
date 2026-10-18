import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
const jar = vi.hoisted(() => ({ values: new Map<string, string>(), set: vi.fn() }));
const requestHeaders = vi.hoisted(() => ({ value: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.value,
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    set: jar.set,
  }),
}));
const currentUser = vi.hoisted(() => ({ value: null as { id: string; email: string | null } | null }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => currentUser.value) }));

// Every Auth call a credential could be consumed through; none may run on a GET.
const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
}));
const createClient = vi.hoisted(() => vi.fn(async () => ({ auth })));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: createClient }));

const { GET: prepare } = await import("@/app/auth/confirm/prepare/route");
const { default: ConfirmPage } = await import("@/app/auth/confirm/page");
const { confirmSignupAction } = await import("@/app/auth/confirm/actions");
const { ConfirmSignupForm } = await import("@/app/auth/confirm/ConfirmSignupForm");
const { signupAction } = await import("@/app/(auth)/actions");
const { default: LoginPage } = await import("@/app/(auth)/login/page");
const { normalizeSignUpError, normalizeSignupVerifyError } = await import("@/lib/auth/errors");
const { continuationFromRedirectTo, signupConfirmFailurePath, signupConfirmPath, signupRedirectUrl } = await import(
  "@/lib/auth/signup-confirmation"
);
const { NextRequest } = await import("next/server");
const { es } = await import("@/lib/i18n/messages/es");

// Batch 3: scanner-safe, cross-device signup confirmation. The emailed link's
// GETs (prepare, confirm) never consume the token; only the explicit
// "Confirmar mi cuenta" action does, once, with the token from the httpOnly
// cookie and nothing the browser sends. Supabase Auth is faked at the client
// boundary.

const TOKEN = `pkce_${"a1".repeat(28)}`;
const IMPLICIT_TOKEN = "b2".repeat(28);
const FORGED = `pkce_${"f0".repeat(28)}`;
const ORIGIN = "https://bodas.example.com";
const copy = es.auth.signupConfirm;
const redirectTo = (next: string) => encodeURIComponent(signupRedirectUrl(ORIGIN, next));

function prepareRequest(query: string) {
  return new NextRequest(`${ORIGIN}/auth/confirm/prepare${query}`);
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function noCredentialConsumed() {
  expect(auth.verifyOtp).not.toHaveBeenCalled();
  expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
}

async function settle(run: () => Promise<unknown>): Promise<{ value?: unknown; redirect?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (match) return { redirect: match[1] };
    throw error;
  }
}

const confirm = (next = "/app") => settle(() => confirmSignupAction(null, form({ next })));
const cleared = () =>
  expect(jar.set).toHaveBeenCalledWith("lb_signup_token", "", expect.objectContaining({ maxAge: 0, path: "/auth/confirm" }));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  requestHeaders.value = new Headers({ origin: "https://evil.example", host: "evil.example" });
  jar.values.clear();
  jar.set.mockClear();
  currentUser.value = null;
  for (const fn of Object.values(auth)) fn.mockReset();
  createClient.mockClear();
  navigation.redirect.mockClear();
});

describe("continuation helpers", () => {
  it("emailRedirectTo is the shared callback carrying the validated continuation", () => {
    expect(signupRedirectUrl(ORIGIN)).toBe(`${ORIGIN}/auth/callback`);
    expect(signupRedirectUrl(ORIGIN, "/app/billing")).toBe(`${ORIGIN}/auth/callback?next=%2Fapp%2Fbilling`);
    expect(signupRedirectUrl(ORIGIN, "https://evil.example")).toBe(`${ORIGIN}/auth/callback`);
  });

  it("reads the continuation back out of {{ .RedirectTo }}, keeping only a safe path", () => {
    expect(continuationFromRedirectTo(signupRedirectUrl(ORIGIN, "/app/billing?campaign=x&y=1"))).toBe(
      "/app/billing?campaign=x&y=1",
    );
    expect(continuationFromRedirectTo(signupRedirectUrl(ORIGIN, "/invite/continue"))).toBe("/invite/continue");
    // Supabase's fallback to the Site URL (redirect not allow-listed), other paths, junk: the default.
    for (const value of [ORIGIN, `${ORIGIN}/`, `${ORIGIN}/app/billing`, "", "nope", null, undefined, 42]) {
      expect(continuationFromRedirectTo(value)).toBe("/app");
    }
    // Never an origin, never an external continuation.
    expect(continuationFromRedirectTo("https://evil.example/auth/callback?next=%2Fapp%2Fbilling")).toBe("/app/billing");
    expect(continuationFromRedirectTo(`${ORIGIN}/auth/callback?next=https%3A%2F%2Fevil.example`)).toBe("/app");
    expect(continuationFromRedirectTo(`${ORIGIN}/auth/callback?next=%2F%2Fevil.example`)).toBe("/app");
  });

  it("confirm and failure paths carry only a validated continuation", () => {
    expect(signupConfirmPath()).toBe("/auth/confirm");
    expect(signupConfirmPath("/app/billing")).toBe("/auth/confirm?next=%2Fapp%2Fbilling");
    expect(signupConfirmPath("//evil.example")).toBe("/auth/confirm");
    expect(signupConfirmFailurePath()).toBe("/login?error=confirm");
    expect(signupConfirmFailurePath("/invite/continue")).toBe("/login?next=%2Finvite%2Fcontinue&error=confirm");
  });
});

describe("GET /auth/confirm/prepare", () => {
  it("moves the token into the httpOnly cookie and redirects to the clean confirm URL, verifying nothing", async () => {
    const response = await prepare(prepareRequest(`?token_hash=${TOKEN}&redirect_to=${redirectTo("/app/billing")}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/confirm?next=%2Fapp%2Fbilling`);
    expect(response.headers.get("location")).not.toContain(TOKEN);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`lb_signup_token=${TOKEN}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toContain("Path=/auth/confirm");
    expect(setCookie).toContain("Max-Age=900");
    expect(createClient).not.toHaveBeenCalled();
    noCredentialConsumed();
  });

  it("accepts the non-PKCE token hash shape too (a resend), and defaults the continuation", async () => {
    const response = await prepare(prepareRequest(`?token_hash=${IMPLICIT_TOKEN}`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/confirm`);
    expect(response.headers.get("set-cookie") ?? "").toContain(`lb_signup_token=${IMPLICIT_TOKEN}`);
  });

  it("is idempotent: any number of GETs (a scanner, then the person, twice) verify nothing", async () => {
    for (let i = 0; i < 3; i++) await prepare(prepareRequest(`?token_hash=${TOKEN}`));
    expect(createClient).not.toHaveBeenCalled();
    noCredentialConsumed();
  });

  it.each([
    ["missing", ""],
    ["empty", "?token_hash="],
    ["malformed", "?token_hash=%3Cscript%3E"],
    ["a control character", `?token_hash=${TOKEN}%0A`],
    ["too long", `?token_hash=${"ab".repeat(80)}`],
  ])("a %s token is dropped (cookie cleared), never echoed, nothing verified", async (_label, query) => {
    const response = await prepare(prepareRequest(query));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/confirm`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("lb_signup_token=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("script");
    noCredentialConsumed();
  });

  it("an external continuation is never followed", async () => {
    const evil = encodeURIComponent(`${ORIGIN}/auth/callback?next=https%3A%2F%2Fevil.example`);
    const response = await prepare(prepareRequest(`?token_hash=${TOKEN}&redirect_to=${evil}&next=https%3A%2F%2Fevil.example`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/confirm`);
  });
});

describe("GET /auth/confirm (the page)", () => {
  const html = async (next?: string) =>
    renderToStaticMarkup((await ConfirmPage({ searchParams: Promise.resolve(next ? { next } : {}) } as never)) as ReactElement);

  it("with a pending token: the explicit confirmation, and the token nowhere in the HTML", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    const markup = await html("/app/billing");
    expect(markup).toContain(copy.title);
    expect(markup).toContain(copy.body);
    expect(markup).toContain(copy.submit);
    expect(markup).not.toContain(TOKEN);
    expect(markup).not.toContain("a1a1a1");
    expect(markup).not.toMatch(/<input[^>]*name="token/);
    noCredentialConsumed();
  });

  it("the client form receives only the validated continuation (nothing to carry a token into client JS)", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    const found: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as ReactElement<{ children?: unknown }>;
      if (element.type === ConfirmSignupForm) found.push(element.props);
      walk(element.props.children);
    };
    walk(await ConfirmPage({ searchParams: Promise.resolve({ next: "https://evil.example" }) } as never));
    expect(found).toEqual([{ next: "/app" }]);
  });

  it("no token and signed out (opened again, used, expired): login or sign up again, never a scary error", async () => {
    for (const value of [undefined, "basura"]) {
      jar.values.clear();
      if (value) jar.values.set("lb_signup_token", value);
      const markup = await html("/app/billing");
      expect(markup).toContain(copy.unavailableTitle);
      expect(markup).toContain(copy.unavailableBody);
      expect(markup).toContain('href="/login?next=%2Fapp%2Fbilling"');
      expect(markup).toContain('href="/signup?next=%2Fapp%2Fbilling"');
      expect(markup).not.toContain(copy.submit);
    }
    noCredentialConsumed();
  });

  it("no token and signed in (Back after confirming): the account is ready, continue", async () => {
    currentUser.value = { id: "u", email: "persona@example.test" };
    const markup = await html("/app/billing");
    expect(markup).toContain(copy.doneTitle);
    expect(markup).toContain('href="/app/billing"');
    expect(markup).not.toContain("persona@example.test");
    noCredentialConsumed();
  });
});

describe("confirmSignupAction (the explicit Confirmar mi cuenta)", () => {
  it("verifies the cookie's token exactly once, as an email confirmation, then clears it and continues", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" }, user: { id: "u" } }, error: null });
    expect((await confirm("/app/billing")).redirect).toBe("/app/billing");
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: TOKEN, type: "email" });
    cleared();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("continues to the pending invite or the default /app (whose guards send a new account to the choice)", async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
    jar.values.set("lb_signup_token", TOKEN);
    expect((await confirm("/invite/continue")).redirect).toBe("/invite/continue");
    jar.values.set("lb_signup_token", TOKEN);
    expect((await confirm("https://evil.example")).redirect).toBe("/app");
  });

  it("never reads a token or type from the form", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
    await settle(() => confirmSignupAction(null, form({ next: "/app", token_hash: FORGED, type: "recovery" })));
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: TOKEN, type: "email" });
    expect(JSON.stringify(auth.verifyOtp.mock.calls)).not.toContain(FORGED);
  });

  it.each([
    ["expired", { code: "otp_expired", status: 403 }],
    ["already used (reuse after confirmation)", { code: "otp_expired", status: 403 }],
    ["replaced by a newer email", { code: "otp_expired", status: 403 }],
    ["invalid", { code: "validation_failed", status: 400 }],
  ])("%s → cookie cleared, the login page with the fixed guidance, no raw error", async (_label, error) => {
    jar.values.set("lb_signup_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { ...error, message: "Token has expired or is invalid" } });
    expect((await confirm("/app/billing")).redirect).toBe("/login?next=%2Fapp%2Fbilling&error=confirm");
    cleared();
  });

  it("no pending token (or a malformed one) → the same login guidance, nothing verified", async () => {
    for (const value of [undefined, "basura"]) {
      jar.values.clear();
      if (value) jar.values.set("lb_signup_token", value);
      expect((await confirm()).redirect).toBe("/login?error=confirm");
    }
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("a limit or a failure on our side keeps the token for another press, with fixed copy (no retries)", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: "over_request_rate_limit", status: 429 } });
    expect((await confirm()).value).toEqual({ ok: false, formError: es.auth.rateLimited });
    auth.verifyOtp.mockRejectedValue(new Error("fetch failed"));
    expect((await confirm()).value).toEqual({ ok: false, formError: copy.retry });
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { status: 500, message: "boom" } });
    expect((await confirm()).value).toEqual({ ok: false, formError: copy.retry });
    expect(auth.verifyOtp).toHaveBeenCalledTimes(3);
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("a success without a session is not a success", async () => {
    jar.values.set("lb_signup_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expect((await confirm()).redirect).toBe("/login?error=confirm");
    cleared();
  });

  it("normalizeSignupVerifyError: refusals are invalid, limits and our failures are retries", () => {
    expect(normalizeSignupVerifyError({ code: "otp_expired", status: 403 })).toEqual({ kind: "invalid" });
    expect(normalizeSignupVerifyError({ status: 429 })).toEqual({ kind: "retry", message: es.auth.rateLimited });
    expect(normalizeSignupVerifyError({ status: 502 })).toEqual({ kind: "retry", message: copy.retry });
    expect(normalizeSignupVerifyError({})).toEqual({ kind: "retry", message: copy.retry });
  });
});

describe("signupAction (the email's continuation and outcomes)", () => {
  const signUp = (fields: Record<string, string>) =>
    settle(() => signupAction(null, form({ email: "persona@example.test", password: "una-clave-segura", ...fields })));

  it("asks Auth for a confirmation link built on APP_ORIGIN (never request headers), carrying next", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: { id: "u" } }, error: null });
    const result = await signUp({ next: "/app/billing" });
    expect(result.value).toEqual({ ok: true, data: { confirmationRequired: true } });
    expect(auth.signUp).toHaveBeenCalledExactlyOnceWith({
      email: "persona@example.test",
      password: "una-clave-segura",
      options: { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2Fapp%2Fbilling` },
    });
    expect(JSON.stringify(auth.signUp.mock.calls)).not.toContain("evil.example");
  });

  it("without APP_ORIGIN only a local request may supply the origin; otherwise no redirect is sent", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    auth.signUp.mockResolvedValue({ data: { session: null, user: { id: "u" } }, error: null });
    await signUp({});
    expect(auth.signUp.mock.calls[0][0].options).toBeUndefined();
    requestHeaders.value = new Headers({ origin: "http://localhost:3100", host: "localhost:3100" });
    await signUp({});
    expect(auth.signUp.mock.calls[1][0].options).toEqual({ emailRedirectTo: "http://localhost:3100/auth/callback" });
  });

  it("no enumeration: a new, an existing, a confirmed and a just-emailed address all get the same answer", async () => {
    const outcomes = [
      { data: { session: null, user: { id: "new" } }, error: null },
      { data: { session: null, user: { id: "obfuscated" } }, error: null },
      { data: { session: null, user: null }, error: { code: "user_already_exists", status: 422 } },
      { data: { session: null, user: null }, error: { code: "over_email_send_rate_limit", status: 429 } },
    ];
    for (const outcome of outcomes) {
      auth.signUp.mockResolvedValueOnce(outcome);
      expect((await signUp({})).value).toEqual({ ok: true, data: { confirmationRequired: true } });
    }
  });

  it("the per-client limit (before any lookup) explains what to do instead of 'Demasiados intentos'", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { code: "over_request_rate_limit", status: 429 } });
    expect((await signUp({})).value).toMatchObject({ ok: false, formError: es.auth.signup.rateLimited });
    expect(normalizeSignUpError({ code: "over_request_rate_limit" })).toEqual({ kind: "form", message: es.auth.signup.rateLimited });
  });
});

describe("copy", () => {
  it("the check-email answer works on any device and never says 'same browser'", () => {
    const text = [es.auth.signup.checkEmailBody, ...es.auth.signup.checkEmailHints].join(" ");
    expect(text).not.toMatch(/mismo navegador/i);
    expect(text).toMatch(/otro dispositivo/);
    expect(text).toMatch(/más reciente/);
  });

  it("the login page explains a used confirmation link calmly (status, not alert)", async () => {
    const markup = renderToStaticMarkup(
      (await LoginPage({ searchParams: Promise.resolve({ error: "confirm" }) } as never)) as ReactElement,
    );
    expect(markup).toContain(es.auth.login.confirmLinkInvalid);
    const before = markup.slice(0, markup.indexOf(es.auth.login.confirmLinkInvalid));
    expect(before.slice(before.lastIndexOf('role="'))).toMatch(/^role="status"/);
  });
});
