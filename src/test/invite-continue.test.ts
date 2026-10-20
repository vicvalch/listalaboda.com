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
const currentUser = vi.hoisted(() => ({ value: null as { id: string; email: string | null } | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => currentUser.value),
  requireUser: vi.fn(async () => currentUser.value),
}));
const accountType = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/accounts/session", () => ({ getCurrentAccountType: accountType.read }));
const invites = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock("@/lib/membership-invites/service", () => ({ acceptMembershipInvite: invites.accept }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => ({})) }));

const { default: InviteContinuePage } = await import("@/app/invite/continue/page");
const { acceptInviteAction } = await import("@/app/invite/continue/actions");
const { GET: openInvite } = await import("@/app/invite/[token]/route");
const { NextRequest } = await import("next/server");
const { es } = await import("@/lib/i18n/messages/es");

// QA-02a: /invite/continue without a pending invite. A refusal (malformed
// link, accept RPC said invalid) keeps the "no longer valid" state; no invite
// in THIS browser (sign-up confirmed on another device, handoff ran out) says
// to reopen the link here, claims nothing about the invite, and gives an
// untyped account no way into the one-time account-type choice.

const TOKEN = "A".repeat(43);
const ORIGIN = "https://bodas.example.com";

async function html(query: Record<string, string> = {}) {
  return renderToStaticMarkup(
    (await InviteContinuePage({ searchParams: Promise.resolve(query) } as never)) as ReactElement,
  );
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

beforeEach(() => {
  jar.values.clear();
  jar.set.mockClear();
  currentUser.value = null;
  accountType.read.mockReset();
  invites.accept.mockReset();
  navigation.redirect.mockClear();
});

describe("/invite/continue without a pending invite", () => {
  it("signed in, untyped: reopen the link on this device; not 'invalid', no link into /app or onboarding", async () => {
    currentUser.value = { id: "u", email: "invitada@example.test" };
    accountType.read.mockResolvedValue(null);
    const markup = await html();
    expect(markup).toContain(es.inviteMissing.title);
    expect(markup).toContain(es.inviteMissing.body);
    expect(markup).toContain(es.inviteMissing.newLink);
    expect(markup).not.toContain(es.inviteInvalid.title);
    expect(markup).not.toMatch(/href="\/(app|onboarding)/);
    expect(markup).not.toContain("invitada@example.test");
  });

  it("a failed account-type read is treated like untyped (fail closed: no /app link)", async () => {
    currentUser.value = { id: "u", email: null };
    accountType.read.mockResolvedValue(undefined);
    expect(await html()).not.toMatch(/href="\/(app|onboarding)/);
  });

  it("signed in with a type: the same guidance, plus Mis bodas", async () => {
    currentUser.value = { id: "u", email: null };
    accountType.read.mockResolvedValue("planner");
    const markup = await html();
    expect(markup).toContain(es.inviteMissing.title);
    expect(markup).toContain('href="/app?all=1"');
  });

  it("signed out: the same guidance with login, no account read", async () => {
    const markup = await html();
    expect(markup).toContain(es.inviteMissing.title);
    expect(markup).toContain('href="/login"');
    expect(accountType.read).not.toHaveBeenCalled();
  });

  it("after a refusal (?invite=invalid): the unchanged invalid state", async () => {
    currentUser.value = { id: "u", email: null };
    accountType.read.mockResolvedValue(null);
    const markup = await html({ invite: "invalid" });
    expect(markup).toContain(es.inviteInvalid.title);
    expect(markup).toContain(es.inviteInvalid.body);
    expect(markup).not.toContain(es.inviteMissing.title);
    expect(markup).toContain('href="/app?all=1"');
  });

  it("any other flag value is just 'missing'; a pending invite always wins over the flag", async () => {
    expect(await html({ invite: "otro" })).toContain(es.inviteMissing.title);
    jar.values.set("lb_membership_invite", TOKEN);
    currentUser.value = { id: "u", email: null };
    const markup = await html({ invite: "invalid" });
    expect(markup).toContain(es.inviteAccept.title);
    expect(markup).not.toContain(es.inviteInvalid.title);
    expect(markup).not.toContain(TOKEN);
  });
});

describe("where a refusal lands", () => {
  it("a malformed link → the invalid state, cookie forgotten; a well-formed one → the plain page, no token in the URL", async () => {
    const bad = await openInvite(new NextRequest(`${ORIGIN}/invite/nope`), {
      params: Promise.resolve({ token: "nope" }),
    } as never);
    expect(bad.headers.get("location")).toBe(`${ORIGIN}/invite/continue?invite=invalid`);
    expect(bad.cookies.get("lb_membership_invite")?.value).toBe("");

    const good = await openInvite(new NextRequest(`${ORIGIN}/invite/${TOKEN}`), {
      params: Promise.resolve({ token: TOKEN }),
    } as never);
    expect(good.headers.get("location")).toBe(`${ORIGIN}/invite/continue`);
    expect(good.headers.get("location")).not.toContain(TOKEN);
    expect(good.cookies.get("lb_membership_invite")?.value).toBe(TOKEN);
  });

  it("the accept RPC saying invalid → cookie cleared, the invalid state", async () => {
    currentUser.value = { id: "u", email: null };
    jar.values.set("lb_membership_invite", TOKEN);
    invites.accept.mockResolvedValue({ ok: false, reason: "invalid" });
    expect(await settle(() => acceptInviteAction())).toEqual({ redirect: "/invite/continue?invite=invalid" });
    expect(jar.set).toHaveBeenCalledWith("lb_membership_invite", "", expect.objectContaining({ maxAge: 0 }));
  });
});
