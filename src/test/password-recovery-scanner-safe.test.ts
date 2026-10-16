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
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    set: jar.set,
  }),
}));

// Every Auth call a credential could be consumed through; none may run on a GET.
const auth = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  updateUser: vi.fn(),
  getUser: vi.fn(),
  getClaims: vi.fn(),
}));
const createClient = vi.hoisted(() => vi.fn(async () => ({ auth })));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: createClient }));

const { GET: prepare } = await import("@/app/auth/recovery/prepare/route");
const { default: ConfirmPage } = await import("@/app/auth/recovery/confirm/page");
const { confirmRecoveryAction } = await import("@/app/auth/recovery/confirm/actions");
const { ConfirmRecoveryForm } = await import("@/app/auth/recovery/confirm/ConfirmRecoveryForm");
const { NextRequest } = await import("next/server");
const { es } = await import("@/lib/i18n/messages/es");

// AUTH-RECOVERY-02: the emailed link's GETs (prepare, confirm) never consume
// the recovery token; only the explicit "Continuar" action does, once, with
// the token from the httpOnly cookie and nothing the browser sends.

const TOKEN = `pkce_${"a1".repeat(28)}`;
const FORGED = `pkce_${"f0".repeat(28)}`;
const ORIGIN = "https://bodas.example.com";
const copy = es.auth.recoveryConfirm;

function prepareRequest(query: string) {
  return new NextRequest(`${ORIGIN}/auth/recovery/prepare${query}`);
}

function noCredentialConsumed() {
  expect(auth.verifyOtp).not.toHaveBeenCalled();
  expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  expect(auth.updateUser).not.toHaveBeenCalled();
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

const cleared = () =>
  expect(jar.set).toHaveBeenCalledWith("lb_recovery_token", "", expect.objectContaining({ maxAge: 0, path: "/auth/recovery" }));

beforeEach(() => {
  jar.values.clear();
  jar.set.mockClear();
  for (const fn of Object.values(auth)) fn.mockReset();
  createClient.mockClear();
  navigation.redirect.mockClear();
});

describe("GET /auth/recovery/prepare", () => {
  it("moves a token into the httpOnly cookie and redirects to the clean confirm URL, verifying nothing", async () => {
    const response = await prepare(prepareRequest(`?token_hash=${TOKEN}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/recovery/confirm`);
    expect(response.headers.get("location")).not.toContain(TOKEN);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`lb_recovery_token=${TOKEN}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toContain("Path=/auth/recovery");
    expect(setCookie).toContain("Max-Age=900");
    // No Auth client is even created on this GET.
    expect(createClient).not.toHaveBeenCalled();
    noCredentialConsumed();
  });

  it("is idempotent: any number of GETs (a scanner, then the person) verify nothing", async () => {
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
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/recovery/confirm`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("lb_recovery_token=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).not.toContain("script");
    noCredentialConsumed();
  });

  it("only token_hash is read: a type or redirect parameter changes nothing", async () => {
    const response = await prepare(prepareRequest(`?token_hash=${TOKEN}&type=signup&next=https%3A%2F%2Fevil.example`));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/recovery/confirm`);
    noCredentialConsumed();
  });
});

describe("GET /auth/recovery/confirm (the page)", () => {
  const html = async () => renderToStaticMarkup((await ConfirmPage()) as ReactElement);

  it("with a pending token: the explicit confirmation, and the token nowhere in the HTML", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    const markup = await html();
    expect(markup).toContain(copy.title);
    expect(markup).toContain(copy.body);
    expect(markup).toContain(copy.submit);
    expect(markup).toContain(copy.requestNew);
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).not.toContain(TOKEN);
    expect(markup).not.toContain("a1a1a1");
    // No field the browser could use to carry a token.
    expect(markup).not.toMatch(/<input[^>]*name="token/);
    noCredentialConsumed();
  });

  it("without a token (or a malformed one): 'no longer available' and a new request", async () => {
    for (const value of [undefined, "basura"]) {
      jar.values.clear();
      if (value) jar.values.set("lb_recovery_token", value);
      const markup = await html();
      expect(markup).toContain(copy.unavailableTitle);
      expect(markup).toContain(copy.unavailableBody);
      expect(markup).toContain('href="/forgot-password"');
      expect(markup).not.toContain(copy.submit);
    }
    noCredentialConsumed();
  });

  it("the client form receives no props at all (nothing to carry a token into client JS)", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    const found: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as ReactElement<{ children?: unknown }>;
      if (element.type === ConfirmRecoveryForm) found.push(element.props);
      walk(element.props.children);
    };
    walk(await ConfirmPage());
    expect(found).toEqual([{}]);
  });
});

describe("confirmRecoveryAction (the explicit Continuar)", () => {
  it("verifies the cookie's token exactly once, as a recovery, then clears it and opens the reset page", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" }, user: { id: "u" } }, error: null });
    const result = await settle(() => confirmRecoveryAction());
    expect(result.redirect).toBe("/reset-password");
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: TOKEN, type: "recovery" });
    cleared();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("takes no client input: a forged token or type in the form is never read", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
    const forged = new FormData();
    forged.append("token_hash", FORGED);
    forged.append("type", "signup");
    // React passes (prevState, formData) to a form action; it accepts neither.
    const action = confirmRecoveryAction as unknown as (prev: null, form: FormData) => Promise<unknown>;
    await settle(() => action(null, forged));
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: TOKEN, type: "recovery" });
    expect(JSON.stringify(auth.verifyOtp.mock.calls)).not.toContain(FORGED);
  });

  it.each([
    ["expired", { code: "otp_expired", status: 403 }],
    ["already used (replay)", { code: "otp_expired", status: 403 }],
    ["invalid", { code: "validation_failed", status: 400 }],
  ])("%s → cookie cleared, the request page with the fixed 'link' notice, no raw error", async (_label, error) => {
    jar.values.set("lb_recovery_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { ...error, message: "Token has expired or is invalid" } });
    const result = await settle(() => confirmRecoveryAction());
    expect(result.redirect).toBe("/forgot-password?error=link");
    cleared();
  });

  it("no pending token (or a malformed one) → the same request page, nothing verified", async () => {
    for (const value of [undefined, "basura"]) {
      jar.values.clear();
      if (value) jar.values.set("lb_recovery_token", value);
      expect((await settle(() => confirmRecoveryAction())).redirect).toBe("/forgot-password?error=link");
    }
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("a limit or a failure on our side keeps the token for another press, with fixed copy (no retries)", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: "over_request_rate_limit", status: 429 } });
    expect((await settle(() => confirmRecoveryAction())).value).toEqual({ ok: false, formError: es.auth.rateLimited });
    auth.verifyOtp.mockRejectedValue(new Error("fetch failed"));
    expect((await settle(() => confirmRecoveryAction())).value).toEqual({ ok: false, formError: copy.retry });
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { status: 500, message: "boom" } });
    expect((await settle(() => confirmRecoveryAction())).value).toEqual({ ok: false, formError: copy.retry });
    expect(auth.verifyOtp).toHaveBeenCalledTimes(3);
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("a success without a session is not a success", async () => {
    jar.values.set("lb_recovery_token", TOKEN);
    auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expect((await settle(() => confirmRecoveryAction())).redirect).toBe("/forgot-password?error=link");
    cleared();
  });
});
