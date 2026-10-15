import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock("next/navigation", () => navigation);
const requireUser = vi.hoisted(() => vi.fn(async () => ({ id: "user-1", email: null })));
vi.mock("@/lib/auth/session", () => ({ requireUser }));
const supabase = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => supabase.client) }));

const {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_ONBOARDING_PATH,
  accountTypeOnboardingPath,
  afterAccountTypePath,
  canCreateWedding,
  decideCoupleEntry,
  parseAccountType,
} = await import("@/lib/accounts/account-type");
const { getAccountType, selectAccountType } = await import("@/lib/accounts/service");
const { AccountTypeUnavailableError, requireAccountType } = await import("@/lib/accounts/session");

// ACCOUNT-01 (ADR-020): the account type's pure rules, its service over the
// user's own client and the server guard every /app request goes through.
// The database side (immutability, RLS, the one write path) is in tests/db.

type Read = { data: unknown; error: unknown };

/** A user-session client double: one `user_accounts` read and one RPC. */
function fakeClient(read: Read | Error, rpc: Read | Error = { data: null, error: null }) {
  const calls = { from: [] as string[], eq: [] as unknown[][], rpc: [] as unknown[][] };
  const client = {
    from(table: string) {
      calls.from.push(table);
      return {
        select: () => ({
          eq: (...args: unknown[]) => {
            calls.eq.push(args);
            return {
              maybeSingle: async () => {
                if (read instanceof Error) throw read;
                return read;
              },
            };
          },
        }),
      };
    },
    async rpc(...args: unknown[]) {
      calls.rpc.push(args);
      if (rpc instanceof Error) throw rpc;
      return rpc;
    },
  };
  return { client, calls };
}

const wedding = (id: string) => ({ id, name: `Boda ${id}`, weddingDate: null, city: null, timeZone: null, role: "owner" as const });

describe("parseAccountType", () => {
  it("accepts exactly planner and couple", () => {
    expect(ACCOUNT_TYPES).toEqual(["planner", "couple"]);
    expect(parseAccountType("planner")).toBe("planner");
    expect(parseAccountType("couple")).toBe("couple");
  });

  it.each([["Planner"], ["COUPLE"], [" planner"], ["pareja"], ["admin"], [""], [null], [undefined], [1], [["planner"]]])(
    "refuses %j",
    (value) => {
      expect(parseAccountType(value)).toBeNull();
    },
  );
});

describe("onboarding paths", () => {
  it("carries a validated continuation, never the default, an external URL or itself", () => {
    expect(ACCOUNT_TYPE_ONBOARDING_PATH).toBe("/onboarding/account-type");
    expect(accountTypeOnboardingPath()).toBe("/onboarding/account-type");
    expect(accountTypeOnboardingPath("/app")).toBe("/onboarding/account-type");
    expect(accountTypeOnboardingPath("/app/weddings/abc/guests")).toBe(
      "/onboarding/account-type?next=%2Fapp%2Fweddings%2Fabc%2Fguests",
    );
    expect(accountTypeOnboardingPath("https://evil.example/")).toBe("/onboarding/account-type");
    expect(accountTypeOnboardingPath("/onboarding/account-type?next=/app")).toBe("/onboarding/account-type");
  });

  it("continues after the choice to a safe path, never back into onboarding", () => {
    expect(afterAccountTypePath(undefined)).toBe("/app");
    expect(afterAccountTypePath("/invite/continue")).toBe("/invite/continue");
    expect(afterAccountTypePath("//evil.example")).toBe("/app");
    expect(afterAccountTypePath("/onboarding/account-type")).toBe("/app");
  });
});

describe("canCreateWedding", () => {
  it("planners always keep creating weddings", () => {
    for (const count of [0, 1, 2, 50, null]) expect(canCreateWedding("planner", count)).toBe(true);
  });

  it("couples create only their first wedding; an unknown count denies", () => {
    expect(canCreateWedding("couple", 0)).toBe(true);
    expect(canCreateWedding("couple", 1)).toBe(false);
    expect(canCreateWedding("couple", 3)).toBe(false);
    expect(canCreateWedding("couple", null)).toBe(false);
  });
});

describe("decideCoupleEntry", () => {
  it("failed list → error, never empty or a redirect", () => {
    expect(decideCoupleEntry(null)).toEqual({ kind: "error" });
  });

  it("0 weddings → the couple's empty state", () => {
    expect(decideCoupleEntry([])).toEqual({ kind: "empty" });
  });

  it("1 wedding → straight into it", () => {
    expect(decideCoupleEntry([wedding("a")])).toEqual({ kind: "redirect", path: "/app/weddings/a" });
  });

  it("2+ weddings (legacy) → every wedding listed, none chosen, nothing dropped", () => {
    const weddings = [wedding("a"), wedding("b"), wedding("c")];
    expect(decideCoupleEntry(weddings)).toEqual({ kind: "legacy", weddings });
  });
});

describe("getAccountType", () => {
  it("reads only the user's own row and returns its type", async () => {
    const { client, calls } = fakeClient({ data: { account_type: "couple" }, error: null });
    expect(await getAccountType(client as never, "user-1")).toBe("couple");
    expect(calls.from).toEqual(["user_accounts"]);
    expect(calls.eq).toEqual([["user_id", "user-1"]]);
  });

  it("no row = not chosen (null)", async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await getAccountType(client as never, "user-1")).toBeNull();
  });

  it("a failed or strange read is undefined, never null or a type", async () => {
    expect(await getAccountType(fakeClient({ data: null, error: { code: "500" } }).client as never, "u")).toBeUndefined();
    expect(await getAccountType(fakeClient(new Error("network")).client as never, "u")).toBeUndefined();
    expect(
      await getAccountType(fakeClient({ data: { account_type: "admin" }, error: null }).client as never, "u"),
    ).toBeUndefined();
  });
});

describe("selectAccountType", () => {
  it("sends only the requested type: never a user id", async () => {
    const { client, calls } = fakeClient({ data: null, error: null }, { data: "planner", error: null });
    expect(await selectAccountType(client as never, "planner")).toEqual({ ok: true, accountType: "planner" });
    expect(calls.rpc).toEqual([["select_account_type", { requested: "planner" }]]);
  });

  it("the other type already chosen → already_selected", async () => {
    const { client } = fakeClient(
      { data: null, error: null },
      { data: null, error: { code: "55000", message: "account_type_already_selected" } },
    );
    expect(await selectAccountType(client as never, "couple")).toEqual({ ok: false, reason: "already_selected" });
  });

  it("no session → unauthenticated; anything else → error", async () => {
    const noSession = fakeClient({ data: null, error: null }, { data: null, error: { code: "42501", message: "x" } });
    expect(await selectAccountType(noSession.client as never, "couple")).toEqual({ ok: false, reason: "unauthenticated" });
    const broken = fakeClient({ data: null, error: null }, new Error("network"));
    expect(await selectAccountType(broken.client as never, "couple")).toEqual({ ok: false, reason: "error" });
    const odd = fakeClient({ data: null, error: null }, { data: "admin", error: null });
    expect(await selectAccountType(odd.client as never, "couple")).toEqual({ ok: false, reason: "error" });
  });
});

describe("requireAccountType (the /app guard)", () => {
  beforeEach(() => {
    navigation.redirect.mockClear();
    requireUser.mockClear();
  });

  it("returns the user and their type", async () => {
    supabase.client = fakeClient({ data: { account_type: "planner" }, error: null }).client;
    expect(await requireAccountType("/app")).toEqual({ user: { id: "user-1", email: null }, accountType: "planner" });
    expect(requireUser).toHaveBeenCalledWith("/app");
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("no account type → onboarding, carrying the deep link it came from", async () => {
    supabase.client = fakeClient({ data: null, error: null }).client;
    await expect(requireAccountType("/app/weddings/abc/budget")).rejects.toThrow(
      "NEXT_REDIRECT /onboarding/account-type?next=%2Fapp%2Fweddings%2Fabc%2Fbudget",
    );
  });

  it("a failed read throws: never asks again, never guesses a type", async () => {
    supabase.client = fakeClient({ data: null, error: { code: "500" } }).client;
    await expect(requireAccountType("/app")).rejects.toBeInstanceOf(AccountTypeUnavailableError);
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("signed out stops at requireUser (→ /login), before any account read", async () => {
    requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    const { client, calls } = fakeClient({ data: { account_type: "planner" }, error: null });
    supabase.client = client;
    await expect(requireAccountType("/app")).rejects.toThrow("NEXT_REDIRECT /login");
    expect(calls.from).toEqual([]);
  });
});
