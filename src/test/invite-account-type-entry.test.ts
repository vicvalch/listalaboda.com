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

const { INVITE_ENTRY_WINDOW_SECONDS, isRecentInviteJoin, weddingIdOfAppPath } = await import(
  "@/lib/accounts/invite-entry"
);
const { AccountTypeUnavailableError, requireAppEntry, requireWeddingEntry } = await import("@/lib/accounts/session");

// SIT-01: an invite decides the role in one wedding, never the account type.
// An untyped account enters the wedding it has just joined; every other /app
// entry still meets the one-time choice. The exception comes only from the
// caller's own membership row (database clock), never from the URL.

const W = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

type Read = { data: unknown; error: unknown };

/** A user-session client double: the `user_accounts` read and the caller's own membership read. */
function fakeClient({ accountType, membership }: { accountType: Read; membership?: Read | Error }) {
  const reads: { table: string; columns: string; filters: unknown[][] }[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const read = { table, columns, filters: [] as unknown[][] };
          reads.push(read);
          const chain = {
            eq(...args: unknown[]) {
              read.filters.push(args);
              return chain;
            },
            async maybeSingle() {
              if (table === "user_accounts") return accountType;
              if (membership instanceof Error) throw membership;
              return membership ?? { data: null, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
  return { client, reads };
}

const untyped: Read = { data: null, error: null };
const typed = (type: "planner" | "couple"): Read => ({ data: { account_type: type }, error: null });
const joined = (secondsAgo: number): Read => ({ data: { created_at: ago(secondsAgo) }, error: null });
const membershipReads = (reads: { table: string }[]) => reads.filter((read) => read.table === "wedding_memberships");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  navigation.redirect.mockClear();
  requireUser.mockClear();
});

describe("weddingIdOfAppPath", () => {
  it.each([
    [`/app/weddings/${W}`, W],
    [`/app/weddings/${W}?joined=new`, W],
    [`/app/weddings/${W}/guests`, W],
    [`/app/weddings/${W.toUpperCase()}/budget#x`, W],
  ])("%s → the wedding id", (path, id) => {
    expect(weddingIdOfAppPath(path)).toBe(id);
  });

  it.each(["/app", "/app?all=1", "/app/weddings/new", "/app/weddings/abc", `/app/weddings/${W}x`, `/x/app/weddings/${W}`, "", null])(
    "%j → none",
    (path) => {
      expect(weddingIdOfAppPath(path)).toBeNull();
    },
  );
});

describe("isRecentInviteJoin", () => {
  it("accepts a membership created within the window (database clock, small skew)", () => {
    expect(isRecentInviteJoin(ago(5), NOW)).toBe(true);
    expect(isRecentInviteJoin(ago(INVITE_ENTRY_WINDOW_SECONDS), NOW)).toBe(true);
    expect(isRecentInviteJoin(ago(-30), NOW)).toBe(true);
  });

  it.each([
    ["older than the window", ago(INVITE_ENTRY_WINDOW_SECONDS + 1)],
    ["far in the future", ago(-3600)],
    ["not a date", "ayer"],
    ["missing", null],
  ])("refuses %s", (_label, createdAt) => {
    expect(isRecentInviteJoin(createdAt, NOW)).toBe(false);
  });
});

describe("requireAppEntry (the /app shell)", () => {
  it("an untyped account that just joined this wedding through an invite enters it, still untyped", async () => {
    const { client, reads } = fakeClient({ accountType: untyped, membership: joined(60) });
    supabase.client = client;
    expect(await requireAppEntry(`/app/weddings/${W}?joined=new`)).toEqual({
      user: { id: "user-1", email: null },
      accountType: null,
    });
    // Its OWN row for THAT wedding: wedding id from the path, user id from the session.
    expect(membershipReads(reads)).toEqual([
      { table: "wedding_memberships", columns: "created_at", filters: [["wedding_id", W], ["user_id", "user-1"]] },
    ]);
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("…and any section of that wedding within the window", async () => {
    supabase.client = fakeClient({ accountType: untyped, membership: joined(600) }).client;
    expect((await requireAppEntry(`/app/weddings/${W}/guests`)).accountType).toBeNull();
  });

  it("once the window has passed, the same wedding goes to the one-time choice, carrying it", async () => {
    supabase.client = fakeClient({ accountType: untyped, membership: joined(INVITE_ENTRY_WINDOW_SECONDS + 60) }).client;
    await expect(requireAppEntry(`/app/weddings/${W}`)).rejects.toThrow(
      `NEXT_REDIRECT /onboarding/account-type?next=${encodeURIComponent(`/app/weddings/${W}`)}`,
    );
  });

  it.each([
    `/app/weddings/${W}?joined=new`,
    `/app/weddings/${W}?joined=existing&invite=true&skipOnboarding=true`,
  ])("query flags never bypass it: no recent membership → onboarding (%s)", async (path) => {
    supabase.client = fakeClient({ accountType: untyped, membership: { data: null, error: null } }).client;
    await expect(requireAppEntry(path)).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type?next=");
  });

  it.each(["/app", "/app?all=1", "/app/weddings/new"])("normal app entry %s → onboarding, no membership read", async (path) => {
    const { client, reads } = fakeClient({ accountType: untyped, membership: joined(5) });
    supabase.client = client;
    await expect(requireAppEntry(path)).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type");
    expect(membershipReads(reads)).toEqual([]);
  });

  it("a failed membership read never opens anything (fail closed)", async () => {
    supabase.client = fakeClient({ accountType: untyped, membership: { data: null, error: { code: "500" } } }).client;
    await expect(requireAppEntry(`/app/weddings/${W}`)).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type");
    supabase.client = fakeClient({ accountType: untyped, membership: new Error("network") }).client;
    await expect(requireAppEntry(`/app/weddings/${W}`)).rejects.toThrow("NEXT_REDIRECT /onboarding/account-type");
  });

  it.each(["planner", "couple"] as const)("a %s is unchanged: their type, no membership read", async (type) => {
    const { client, reads } = fakeClient({ accountType: typed(type), membership: joined(5) });
    supabase.client = client;
    expect(await requireAppEntry(`/app/weddings/${W}?joined=new`)).toEqual({
      user: { id: "user-1", email: null },
      accountType: type,
    });
    expect(membershipReads(reads)).toEqual([]);
  });

  it("a failed account-type read still throws (never 'no type', never a bypass)", async () => {
    supabase.client = fakeClient({ accountType: { data: null, error: { code: "500" } }, membership: joined(5) }).client;
    await expect(requireAppEntry(`/app/weddings/${W}`)).rejects.toBeInstanceOf(AccountTypeUnavailableError);
  });

  it("signed out stops at requireUser, carrying the requested path", async () => {
    requireUser.mockRejectedValueOnce(new Error("NEXT_REDIRECT /login"));
    await expect(requireAppEntry(`/app/weddings/${W}`)).rejects.toThrow("NEXT_REDIRECT /login");
    expect(requireUser).toHaveBeenCalledWith(`/app/weddings/${W}`);
  });
});

describe("requireWeddingEntry (the wedding layout, also on client navigation)", () => {
  it("the just-joined wedding: untyped stays null", async () => {
    supabase.client = fakeClient({ accountType: untyped, membership: joined(60) }).client;
    expect(await requireWeddingEntry("user-1", W, `/app/weddings/${W}`)).toBeNull();
  });

  it("another wedding (not just joined) → onboarding, carrying it", async () => {
    supabase.client = fakeClient({ accountType: untyped, membership: joined(INVITE_ENTRY_WINDOW_SECONDS * 4) }).client;
    await expect(requireWeddingEntry("user-1", OTHER, `/app/weddings/${OTHER}/budget`)).rejects.toThrow(
      `NEXT_REDIRECT /onboarding/account-type?next=${encodeURIComponent(`/app/weddings/${OTHER}/budget`)}`,
    );
  });

  it("a malformed wedding id → onboarding without any membership read", async () => {
    const { client, reads } = fakeClient({ accountType: untyped, membership: joined(5) });
    supabase.client = client;
    await expect(requireWeddingEntry("user-1", "abc", "/app/weddings/abc")).rejects.toThrow(
      "NEXT_REDIRECT /onboarding/account-type",
    );
    expect(membershipReads(reads)).toEqual([]);
  });

  it.each(["planner", "couple"] as const)("a %s passes with their type", async (type) => {
    supabase.client = fakeClient({ accountType: typed(type) }).client;
    expect(await requireWeddingEntry("user-1", W, `/app/weddings/${W}`)).toBe(type);
  });
});
