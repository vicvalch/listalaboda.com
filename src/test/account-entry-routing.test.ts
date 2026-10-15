import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  // For the wedding switcher (a client component) rendered by the wedding layout.
  usePathname: () => "/app/weddings",
  useRouter: () => ({ push: () => undefined }),
}));
vi.mock("next/navigation", () => navigation);
const request = vi.hoisted(() => ({
  path: "/app",
  cookies: new Map<string, string>(),
  set: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-lb-request-path": request.path }),
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined),
    set: request.set,
  }),
}));

const user = { id: "user-1", email: "persona@example.test" };
const auth = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "user-1", email: "persona@example.test" })),
  getCurrentUser: vi.fn(async () => ({ id: "user-1", email: "persona@example.test" })),
}));
vi.mock("@/lib/auth/session", () => auth);

const accounts = vi.hoisted(() => {
  class AccountTypeUnavailableError extends Error {}
  return {
    AccountTypeUnavailableError,
    // The real guard's contract (tested in account-type.test.ts): typed → returns, null → onboarding.
    requireAccountType: vi.fn(),
    // The /app shell's variant (SIT-01 invite exception tested in invite-account-type-entry.test.ts).
    requireAppEntry: vi.fn(),
    requireWeddingEntry: vi.fn(),
    getCurrentAccountType: vi.fn(),
  };
});
vi.mock("@/lib/accounts/session", () => accounts);
const accountService = vi.hoisted(() => ({ selectAccountType: vi.fn() }));
vi.mock("@/lib/accounts/service", () => accountService);

const client = vi.hoisted(() => ({ kind: "user-session-client", auth: { signOut: async () => ({}) } }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => client) }));
const weddings = vi.hoisted(() => ({ listMyWeddings: vi.fn(), createWedding: vi.fn() }));
vi.mock("@/lib/weddings/service", () => weddings);
const myWeddingsPage = vi.hoisted(() => ({ loadMyWeddingsPage: vi.fn() }));
vi.mock("@/lib/weddings/my-weddings-page", () => myWeddingsPage);
const switcher = vi.hoisted(() => ({ loadSwitcherWeddings: vi.fn(async () => null) }));
vi.mock("@/lib/weddings/switcher", () => switcher);
const invites = vi.hoisted(() => ({ acceptMembershipInvite: vi.fn() }));
vi.mock("@/lib/membership-invites/service", () => invites);

const { selectAccountTypeAction } = await import("@/app/onboarding/account-type/actions");
const { default: AccountTypePage } = await import("@/app/onboarding/account-type/page");
const { default: MyWeddingsPage } = await import("@/app/app/page");
const { default: AppLayout } = await import("@/app/app/layout");
const { default: NewWeddingPage } = await import("@/app/app/weddings/new/page");
const { createWeddingAction } = await import("@/app/app/weddings/new/actions");
const { default: WeddingLayout } = await import("@/app/app/weddings/[weddingId]/layout");
const { acceptInviteAction } = await import("@/app/invite/continue/actions");
const { getMessages } = await import("@/lib/i18n");

// ACCOUNT-01 (ADR-020): first login → the one-time choice → the account's own
// entry. Planner: the LB-24A/LB-24C "Mis bodas" unchanged. Couple: their
// wedding, never a portfolio, and no second wedding through the normal flow.

const copy = getMessages();
const W = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: `Boda ${n}`,
  weddingDate: null,
  city: null,
  timeZone: null,
  role: "owner" as const,
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function settle<T>(run: () => Promise<T>): Promise<{ value?: T; redirect?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    const match = /^NEXT_REDIRECT (.+)$/.exec((error as Error).message);
    if (match) return { redirect: match[1] };
    throw error;
  }
}

const html = (element: unknown) => renderToStaticMarkup(element as ReactElement);
const asType = (accountType: "planner" | "couple" | null) => {
  accounts.getCurrentAccountType.mockResolvedValue(accountType);
  const guard = async (next?: string) => {
    if (accountType === null) {
      navigation.redirect(
        next && next !== "/app" ? `/onboarding/account-type?next=${encodeURIComponent(next)}` : "/onboarding/account-type",
      );
    }
    return { user, accountType };
  };
  accounts.requireAccountType.mockImplementation(guard);
  accounts.requireAppEntry.mockImplementation(guard);
};

beforeEach(() => {
  vi.clearAllMocks();
  request.path = "/app";
  request.cookies.clear();
});

describe("selectAccountTypeAction (onboarding completion)", () => {
  it("planner → saved through the service with the type only, then /app", async () => {
    accountService.selectAccountType.mockResolvedValue({ ok: true, accountType: "planner" });
    const result = await settle(() =>
      selectAccountTypeAction(null, form({ accountType: "planner", next: "/app", userId: "someone-else" })),
    );
    expect(result.redirect).toBe("/app");
    expect(accountService.selectAccountType).toHaveBeenCalledExactlyOnceWith(client, "planner");
    expect(auth.requireUser).toHaveBeenCalledWith("/onboarding/account-type");
  });

  it("couple → saved, then continues to the pending destination (e.g. an accepted invite's wedding)", async () => {
    accountService.selectAccountType.mockResolvedValue({ ok: true, accountType: "couple" });
    const next = `/app/weddings/${W(1).id}?joined=new`;
    const result = await settle(() => selectAccountTypeAction(null, form({ accountType: "couple", next })));
    expect(result.redirect).toBe(next);
  });

  it.each([[""], ["admin"], ["Planner"], ["pareja"]])("%j never reaches the service and stays on the page", async (value) => {
    const result = await settle(() => selectAccountTypeAction(null, form({ accountType: value })));
    expect(result.value).toEqual({ ok: false, fieldErrors: { accountType: copy.accountType.required } });
    expect(accountService.selectAccountType).not.toHaveBeenCalled();
  });

  it("can't switch: the other type already chosen changes nothing and continues with the stored one", async () => {
    accountService.selectAccountType.mockResolvedValue({ ok: false, reason: "already_selected" });
    const result = await settle(() => selectAccountTypeAction(null, form({ accountType: "couple", next: "/app" })));
    expect(result.redirect).toBe("/app");
  });

  it("a failure stays on the page with a retryable error and never routes onward", async () => {
    accountService.selectAccountType.mockResolvedValue({ ok: false, reason: "error" });
    const result = await settle(() => selectAccountTypeAction(null, form({ accountType: "planner" })));
    expect(result.value).toEqual({
      ok: false,
      formError: copy.common.unexpectedError,
      values: { accountType: "planner" },
    });
  });

  it("the continuation is re-validated: no external URL, no loop back into onboarding", async () => {
    accountService.selectAccountType.mockResolvedValue({ ok: true, accountType: "planner" });
    for (const next of ["https://evil.example", "//evil.example", "/onboarding/account-type"]) {
      const result = await settle(() => selectAccountTypeAction(null, form({ accountType: "planner", next })));
      expect(result.redirect, next).toBe("/app");
    }
  });
});

describe("/onboarding/account-type", () => {
  const open = (params: Record<string, string> = {}) =>
    settle(() => AccountTypePage({ searchParams: Promise.resolve(params), params: Promise.resolve({}) }));

  it("an untyped account sees exactly two choices, nothing preselected, and the warning", async () => {
    accounts.getCurrentAccountType.mockResolvedValue(null);
    const { value } = await open();
    const markup = html(value);
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<input[^>]* checked/);
    expect(markup).toContain(copy.accountType.planner.label);
    expect(markup).toContain(copy.accountType.couple.label);
    expect(markup).toContain(copy.accountType.warning);
    expect(markup).not.toMatch(/account_type|tenant|\brol\b/);
    expect(markup).not.toContain("user-1");
  });

  it.each(["planner", "couple"] as const)("an account already typed %s never sees it again", async (type) => {
    accounts.getCurrentAccountType.mockResolvedValue(type);
    expect((await open()).redirect).toBe("/app");
    expect((await open({ next: "/app/weddings/new" })).redirect).toBe("/app/weddings/new");
  });

  it("signed out → /login", async () => {
    auth.requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login?next=%2Fonboarding%2Faccount-type"));
    expect((await open()).redirect).toBe("/login?next=%2Fonboarding%2Faccount-type");
    expect(accounts.getCurrentAccountType).not.toHaveBeenCalled();
  });
});

describe("/app (role-aware entry)", () => {
  const open = (params: Record<string, string> = {}) =>
    settle(() => MyWeddingsPage({ searchParams: Promise.resolve(params), params: Promise.resolve({}) }));

  it("no account type → onboarding, before any wedding read", async () => {
    asType(null);
    expect((await open()).redirect).toBe("/onboarding/account-type");
    expect(weddings.listMyWeddings).not.toHaveBeenCalled();
    expect(myWeddingsPage.loadMyWeddingsPage).not.toHaveBeenCalled();
  });

  it("planner → the existing Mis bodas entry (list request honored)", async () => {
    asType("planner");
    myWeddingsPage.loadMyWeddingsPage.mockResolvedValue({ kind: "empty" });
    const { value } = await open({ all: "1" });
    expect(myWeddingsPage.loadMyWeddingsPage).toHaveBeenCalledWith(client, "user-1", expect.objectContaining({ showList: true }));
    expect(html(value)).toContain(copy.app.weddings.emptyTitle);
    expect(weddings.listMyWeddings).not.toHaveBeenCalled();
  });

  it("couple with 0 weddings → their own empty state with one create action", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([]);
    const markup = html((await open()).value);
    expect(markup).toContain(copy.app.weddings.couple.emptyTitle);
    expect(markup).toContain('href="/app/weddings/new"');
    expect(markup).not.toContain(copy.app.weddings.title);
    expect(myWeddingsPage.loadMyWeddingsPage).not.toHaveBeenCalled();
  });

  it("couple with 1 wedding → straight into it, even when the list is asked for", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([W(1)]);
    expect((await open({ all: "1" })).redirect).toBe(`/app/weddings/${W(1).id}`);
  });

  it("legacy couple with several weddings → all of them listed plainly, none chosen or dropped, no create", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([W(1), W(2), W(3)]);
    const markup = html((await open()).value);
    for (const n of [1, 2, 3]) expect(markup).toContain(`href="/app/weddings/${W(n).id}"`);
    expect(markup).toContain(copy.app.weddings.couple.legacyBody);
    expect(markup).not.toContain("/app/weddings/new");
    expect(markup).not.toContain('data-testid="global-attention"');
    expect(myWeddingsPage.loadMyWeddingsPage).not.toHaveBeenCalled();
  });

  it("couple list failure → an error, never an empty state or a redirect", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue(null);
    const markup = html((await open()).value);
    expect(markup).toContain(copy.common.unexpectedError);
    expect(markup).not.toContain("/app/weddings/new");
  });
});

describe("/app layout (shared deep-link guard)", () => {
  const open = () => settle(() => AppLayout({ children: createElement("p", null, "contenido"), params: Promise.resolve({}) }));

  it("an untyped account is sent to onboarding from any /app URL, carrying it", async () => {
    asType(null);
    const { redirect } = await open();
    expect(redirect).toBe("/onboarding/account-type");
    expect(accounts.requireAppEntry).toHaveBeenCalledWith("/app");
  });

  it("planner chrome offers Mis bodas and Crear boda", async () => {
    asType("planner");
    const markup = html((await open()).value);
    expect(markup).toContain('href="/app?all=1"');
    expect(markup).toContain('href="/app/weddings/new"');
  });

  it("couple chrome offers neither (no portfolio, no second wedding)", async () => {
    asType("couple");
    const markup = html((await open()).value);
    expect(markup).not.toContain('href="/app?all=1"');
    expect(markup).not.toContain("/app/weddings/new");
    expect(markup).toContain(copy.app.nav.logout);
  });
});

describe("creating a wedding", () => {
  const valid = () => form({ name: "Boda de prueba" });

  it("planner keeps creating weddings, whatever they already have", async () => {
    asType("planner");
    weddings.createWedding.mockResolvedValue({ ok: true, weddingId: W(9).id });
    expect((await settle(() => createWeddingAction(null, valid()))).redirect).toBe(`/app/weddings/${W(9).id}`);
    expect(weddings.listMyWeddings).not.toHaveBeenCalled();
    expect((await settle(() => NewWeddingPage())).value).toBeDefined();
  });

  it("couple with no wedding creates their first one", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([]);
    weddings.createWedding.mockResolvedValue({ ok: true, weddingId: W(1).id });
    expect((await settle(() => createWeddingAction(null, valid()))).redirect).toBe(`/app/weddings/${W(1).id}`);
    const markup = html((await settle(() => NewWeddingPage())).value);
    expect(markup).toContain(copy.weddingNew.cancelCouple);
    expect(markup).not.toContain(copy.weddingNew.cancel);
  });

  it("couple who already has a wedding: the page sends them back and the action refuses (server-side)", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([W(1)]);
    expect((await settle(() => NewWeddingPage())).redirect).toBe("/app");
    const result = await settle(() => createWeddingAction(null, valid()));
    expect(result.value).toMatchObject({ ok: false, formError: copy.app.weddings.couple.createBlocked });
    expect(weddings.createWedding).not.toHaveBeenCalled();
  });

  it("couple whose wedding list can't be read: refused, nothing created", async () => {
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue(null);
    const result = await settle(() => createWeddingAction(null, valid()));
    expect(result.value).toMatchObject({ ok: false, formError: copy.common.unexpectedError });
    expect(weddings.createWedding).not.toHaveBeenCalled();
  });

  it("the database's refusals map like the app's own rule (the database is the authority)", async () => {
    // A couple whose app check passed (e.g. a race) but the database refused.
    asType("couple");
    weddings.listMyWeddings.mockResolvedValue([]);
    weddings.createWedding.mockResolvedValue({ ok: false, reason: "couple_wedding_limit" });
    const limited = await settle(() => createWeddingAction(null, valid()));
    expect(limited.value).toMatchObject({ ok: false, formError: copy.app.weddings.couple.createBlocked });
    expect(JSON.stringify(limited.value)).not.toContain("couple_wedding_limit");

    // No account type in the database → the one-time choice, then back to creating.
    asType("planner");
    weddings.createWedding.mockResolvedValue({ ok: false, reason: "account_type_required" });
    expect((await settle(() => createWeddingAction(null, valid()))).redirect).toBe(
      "/onboarding/account-type?next=%2Fapp%2Fweddings%2Fnew",
    );

    // Any other failure stays generic.
    weddings.createWedding.mockResolvedValue({ ok: false, reason: "error" });
    expect((await settle(() => createWeddingAction(null, valid()))).value).toMatchObject({
      ok: false,
      formError: copy.common.unexpectedError,
    });
  });

  it("an untyped account is sent to onboarding first, nothing created", async () => {
    asType(null);
    expect((await settle(() => createWeddingAction(null, valid()))).redirect).toBe(
      "/onboarding/account-type?next=%2Fapp%2Fweddings%2Fnew",
    );
    expect(weddings.createWedding).not.toHaveBeenCalled();
  });
});

// SIT-01: an invite decides the role in one wedding, never the account type.
describe("accepting an invite (no account type involved)", () => {
  const TOKEN = "a".repeat(43);

  it("an untyped account accepts and is sent straight to the wedding it joined", async () => {
    request.cookies.set("lb_membership_invite", TOKEN);
    invites.acceptMembershipInvite.mockResolvedValue({ ok: true, weddingId: W(1).id, role: "collaborator", alreadyMember: false });
    const result = await settle(() => acceptInviteAction());
    expect(result.redirect).toBe(`/app/weddings/${W(1).id}?joined=new`);
    expect(invites.acceptMembershipInvite).toHaveBeenCalledExactlyOnceWith(client, TOKEN);
    // Never reads, infers or writes a type: no account-type call of any kind.
    expect(accounts.getCurrentAccountType).not.toHaveBeenCalled();
    expect(accounts.requireAccountType).not.toHaveBeenCalled();
    expect(accountService.selectAccountType).not.toHaveBeenCalled();
  });

  it("an invalid or expired invite still fails normally (generic invalid state)", async () => {
    request.cookies.set("lb_membership_invite", TOKEN);
    invites.acceptMembershipInvite.mockResolvedValue({ ok: false, reason: "invalid" });
    const result = await settle(() => acceptInviteAction());
    expect(result.redirect).toBe("/invite/continue");
    expect(accountService.selectAccountType).not.toHaveBeenCalled();
  });
});

describe("wedding layout (entry rule re-applied per wedding)", () => {
  const open = (weddingId: string) =>
    settle(() => WeddingLayout({ children: createElement("p", null, "contenido"), params: Promise.resolve({ weddingId }) }));

  it("checks the account-type entry rule for THIS wedding with the requested path", async () => {
    request.path = `/app/weddings/${W(1).id}/guests`;
    accounts.requireWeddingEntry.mockResolvedValue(null);
    const markup = html((await open(W(1).id)).value);
    expect(markup).toContain("contenido");
    expect(accounts.requireWeddingEntry).toHaveBeenCalledExactlyOnceWith("user-1", W(1).id, `/app/weddings/${W(1).id}/guests`);
  });

  it("an untyped account outside the invite exception is sent to onboarding", async () => {
    request.path = `/app/weddings/${W(2).id}?joined=new`;
    accounts.requireWeddingEntry.mockImplementation(async (_user: string, _id: string, next: string) =>
      navigation.redirect(`/onboarding/account-type?next=${encodeURIComponent(next)}`),
    );
    expect((await open(W(2).id)).redirect).toBe(
      `/onboarding/account-type?next=${encodeURIComponent(`/app/weddings/${W(2).id}?joined=new`)}`,
    );
  });

  it("only a planner's switcher offers creating a wedding (untyped: no)", async () => {
    switcher.loadSwitcherWeddings.mockResolvedValue([W(1), W(2)] as never);
    for (const [type, offered] of [["planner", true], ["couple", false], [null, false]] as const) {
      accounts.requireWeddingEntry.mockResolvedValue(type);
      const markup = html((await open(W(1).id)).value);
      expect(markup.includes("/app/weddings/new")).toBe(offered);
    }
  });
});
