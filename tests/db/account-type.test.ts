import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { TEST_EMAIL_DOMAIN, type TestUser } from "./context";
import { PERMISSION_DENIED, as, clientAs, ctx, serviceRole, sql, users, type DbClient } from "./support";

vi.mock("server-only", () => ({}));
const { generateMembershipInviteToken, hashMembershipInviteToken, membershipInviteExpiresAt } =
  await import("@/lib/membership-invites/token");

// ACCOUNT-01 (ADR-020): the immutable account type — user_accounts, its guard,
// select_account_type and the creation rule in create_wedding — exercised as
// real anon and authenticated users through the Data API. Each test signs up
// its own throwaway local account, so it starts untyped (the shared fixture
// users are planners, typed once by the global setup). The superuser
// connection only arranges memberships no client can write, reads ground
// truth, attempts the writes no client can make (to prove the guard holds
// for every role) and deletes the throwaway accounts at the end (the one
// allowed deletion).

type AccountType = "planner" | "couple";

const IMMUTABLE = "55000";
const INVALID_TEXT = "22P02";
const INVALID_PARAMETER = "22023";
const FOREIGN_KEY = "23503";

const LOCAL_PASSWORD = "local-only-fixture-password";
const createdUserIds: string[] = [];
const createdWeddingIds: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddingIds]);
  // Deleting the account is the only way an account type goes away (cascade).
  await sql("delete from auth.users where id = any($1::uuid[])", [createdUserIds]);
});

async function freshUser(): Promise<{ user: TestUser; client: DbClient }> {
  const email = `account-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;
  const { data, error } = await createClient(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.signUp({ email, password: LOCAL_PASSWORD });
  if (error || !data.session) throw new Error(`Could not create a local account: ${error?.message}`);
  createdUserIds.push(data.session.user.id);
  const user: TestUser = {
    id: data.session.user.id,
    email,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
  return { user, client: clientAs(user) };
}

function select(client: DbClient, requested: string) {
  return client.rpc("select_account_type", { requested: requested as AccountType });
}

async function storedType(userId: string): Promise<AccountType | null> {
  const rows = await sql<{ account_type: AccountType }>(
    "select account_type::text as account_type from public.user_accounts where user_id = $1",
    [userId],
  );
  return rows[0]?.account_type ?? null;
}

async function sqlError(text: string, params: unknown[]): Promise<string | undefined> {
  try {
    await sql(text, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("select_account_type: first choice (no row = not selected)", () => {
  it("a new account has no account type", async () => {
    const { user, client } = await freshUser();
    expect(await storedType(user.id)).toBeNull();
    const { data, error } = await client.from("user_accounts").select("account_type");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it.each<AccountType>(["planner", "couple"])("NULL → %s succeeds and returns it", async (type) => {
    const { user, client } = await freshUser();
    const { data, error } = await select(client, type);
    expect(error).toBeNull();
    expect(data).toBe(type);
    expect(await storedType(user.id)).toBe(type);
  });

  it("stamps selected_at with the database clock", async () => {
    const { user, client } = await freshUser();
    const before = (await sql<{ now: Date }>("select now() as now"))[0].now;
    await select(client, "planner");
    const [row] = await sql<{ selected_at: Date }>(
      "select selected_at from public.user_accounts where user_id = $1",
      [user.id],
    );
    expect(row.selected_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2_000);
  });

  it("an invalid value is refused and leaves nothing", async () => {
    const { user, client } = await freshUser();
    for (const value of ["admin", "PLANNER", "", "planner "]) {
      const { error } = await select(client, value);
      expect(error?.code, value).toBe(INVALID_TEXT);
    }
    const { error } = await client.rpc("select_account_type", { requested: null as unknown as AccountType });
    expect(error?.code).toBe(INVALID_PARAMETER);
    expect(await storedType(user.id)).toBeNull();
  });

  it("anon can't call it and a missing session writes nothing", async () => {
    const { error } = await select(as.anon, "planner");
    expect(error?.code).toBe(PERMISSION_DENIED);
  });
});

describe("select_account_type: immutable once chosen", () => {
  it.each<AccountType>(["planner", "couple"])("%s → %s again is an idempotent no-op", async (type) => {
    const { user, client } = await freshUser();
    await select(client, type);
    const [first] = await sql<{ selected_at: Date }>(
      "select selected_at from public.user_accounts where user_id = $1",
      [user.id],
    );
    const { data, error } = await select(client, type);
    expect(error).toBeNull();
    expect(data).toBe(type);
    const [second] = await sql<{ selected_at: Date }>(
      "select selected_at from public.user_accounts where user_id = $1",
      [user.id],
    );
    expect(second.selected_at).toEqual(first.selected_at);
  });

  it.each<[AccountType, AccountType]>([
    ["planner", "couple"],
    ["couple", "planner"],
  ])("%s → %s is refused", async (from, to) => {
    const { user, client } = await freshUser();
    await select(client, from);
    const { error } = await select(client, to);
    expect(error?.code).toBe(IMMUTABLE);
    expect(error?.message).toBe("account_type_already_selected");
    expect(await storedType(user.id)).toBe(from);
  });

  it("concurrent different first choices: exactly one wins", async () => {
    const { user, client } = await freshUser();
    const results = await Promise.all([select(client, "planner"), select(client, "couple")]);
    const winners = results.filter((r) => r.error === null).map((r) => r.data);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === IMMUTABLE)).toHaveLength(1);
    expect(await storedType(user.id)).toBe(winners[0]);
  });
});

describe("user_accounts: no client write path", () => {
  it("a user reads only their own row", async () => {
    const first = await freshUser();
    const second = await freshUser();
    await select(first.client, "planner");
    await select(second.client, "couple");
    const { data } = await first.client.from("user_accounts").select("user_id, account_type");
    expect(data).toEqual([{ user_id: first.user.id, account_type: "planner" }]);
    const { data: anonRows } = await as.anon.from("user_accounts").select("user_id");
    expect(anonRows ?? []).toEqual([]);
  });

  it("clients can't insert, update or delete, not even their own row", async () => {
    const { user, client } = await freshUser();
    const inserted = await client.from("user_accounts").insert({ user_id: user.id, account_type: "planner" });
    expect(inserted.error?.code).toBe(PERMISSION_DENIED);

    await select(client, "planner");
    const updated = await client.from("user_accounts").update({ account_type: "couple" }).eq("user_id", user.id);
    expect(updated.error?.code).toBe(PERMISSION_DENIED);
    const deleted = await client.from("user_accounts").delete().eq("user_id", user.id);
    expect(deleted.error?.code).toBe(PERMISSION_DENIED);
    expect(await storedType(user.id)).toBe("planner");
  });

  it("a user can't choose for someone else (no user id parameter; another user's row is unaffected)", async () => {
    const victim = await freshUser();
    const attacker = await freshUser();
    await select(attacker.client, "couple");
    const inserted = await attacker.client
      .from("user_accounts")
      .insert({ user_id: victim.user.id, account_type: "couple" });
    expect(inserted.error?.code).toBe(PERMISSION_DENIED);
    expect(await storedType(victim.user.id)).toBeNull();
  });
});

describe("guard: immutable for every role", () => {
  it.each<[AccountType, AccountType]>([
    ["planner", "couple"],
    ["couple", "planner"],
  ])("superuser UPDATE %s → %s is refused", async (from, to) => {
    const { user, client } = await freshUser();
    await select(client, from);
    expect(
      await sqlError("update public.user_accounts set account_type = $2 where user_id = $1", [user.id, to]),
    ).toBe(IMMUTABLE);
    expect(await storedType(user.id)).toBe(from);
  });

  // The guard runs before the NOT NULL constraint (which also refuses it).
  it.each<AccountType>(["planner", "couple"])("%s → NULL is refused (column and row)", async (type) => {
    const { user, client } = await freshUser();
    await select(client, type);
    expect(
      await sqlError("update public.user_accounts set account_type = null where user_id = $1", [user.id]),
    ).toBe(IMMUTABLE);
    expect(await sqlError("delete from public.user_accounts where user_id = $1", [user.id])).toBe(IMMUTABLE);
    expect(await storedType(user.id)).toBe(type);
  });

  it("service_role can't change or delete it either", async () => {
    const { user, client } = await freshUser();
    await select(client, "couple");
    const updated = await serviceRole.from("user_accounts").update({ account_type: "planner" }).eq("user_id", user.id);
    expect(updated.error).not.toBeNull();
    const deleted = await serviceRole.from("user_accounts").delete().eq("user_id", user.id);
    expect(deleted.error).not.toBeNull();
    expect(await storedType(user.id)).toBe("couple");
  });

  it("same-value UPDATE is a no-op; moving the row or its timestamp is refused", async () => {
    const { user, client } = await freshUser();
    await select(client, "planner");
    expect(
      await sqlError("update public.user_accounts set account_type = 'planner' where user_id = $1", [user.id]),
    ).toBeUndefined();
    const other = await freshUser();
    expect(
      await sqlError("update public.user_accounts set user_id = $2 where user_id = $1", [user.id, other.user.id]),
    ).toBe(IMMUTABLE);
    expect(
      await sqlError("update public.user_accounts set selected_at = now() - interval '1 day' where user_id = $1", [
        user.id,
      ]),
    ).toBe(IMMUTABLE);
  });

  it("an account type needs a real account", async () => {
    expect(
      await sqlError("insert into public.user_accounts (user_id, account_type) values ($1, 'planner')", [randomUUID()]),
    ).toBe(FOREIGN_KEY);
  });

  it("deleting the account removes its account type (the only deletion)", async () => {
    const { user, client } = await freshUser();
    await select(client, "planner");
    await sql("delete from auth.users where id = $1", [user.id]);
    expect(await storedType(user.id)).toBeNull();
  });
});

describe("wedding access is unchanged by the account type", () => {
  it("a typed account still creates and reads weddings only through membership", async () => {
    const { client } = await freshUser();
    await select(client, "couple");
    const { data, error } = await client.rpc("create_wedding", { wedding_name: "Boda tipo de cuenta" });
    expect(error).toBeNull();
    const { data: rows } = await client.from("weddings").select("id");
    expect(rows?.map((r) => r.id)).toEqual([data?.id]);
    await sql("delete from public.weddings where id = $1", [data?.id]);
  });
});

// ------------------------------------------------ create_wedding (ADR-020 §5)

describe("create_wedding: the account type's creation rule", () => {
  const LIMIT = { code: IMMUTABLE, message: "couple_wedding_limit" };
  const UNTYPED = { code: IMMUTABLE, message: "account_type_required" };

  async function create(client: DbClient, name = "Boda regla de creación") {
    const result = await client.rpc("create_wedding", { wedding_name: name });
    if (result.data?.id) createdWeddingIds.push(result.data.id);
    return result;
  }

  async function memberships(userId: string) {
    return sql<{ wedding_id: string; role: string }>(
      "select wedding_id, role::text as role from public.wedding_memberships where user_id = $1 order by wedding_id",
      [userId],
    );
  }

  /** A wedding of the shared planner `ownerA`, through the real RPC. */
  async function plannersWedding(name: string) {
    const { data, error } = await create(as.ownerA, name);
    if (error || !data) throw new Error(`fixture wedding failed: ${error?.message}`);
    return data.id;
  }

  async function addMembership(weddingId: string, userId: string, role: "owner" | "collaborator") {
    await sql("insert into public.wedding_memberships (wedding_id, user_id, role) values ($1, $2, $3)", [
      weddingId,
      userId,
      role,
    ]);
  }

  it("1: an untyped account is refused and nothing is created", async () => {
    const { user, client } = await freshUser();
    const { data, error } = await create(client);
    expect(data).toBeNull();
    expect(error).toMatchObject(UNTYPED);
    expect(await memberships(user.id)).toEqual([]);
    expect(await sql("select 1 from public.weddings where created_by = $1", [user.id])).toEqual([]);
  });

  it("2 + 3: a planner creates a first wedding and then several more", async () => {
    const { user, client } = await freshUser();
    await select(client, "planner");
    for (const n of [1, 2, 3]) {
      const { error } = await create(client, `Boda planner ${n}`);
      expect(error, `wedding ${n}`).toBeNull();
    }
    expect((await memberships(user.id)).map((m) => m.role)).toEqual(["owner", "owner", "owner"]);
  });

  it("4 + 5: a couple creates their first wedding; the next one is refused", async () => {
    const { user, client } = await freshUser();
    await select(client, "couple");
    const first = await create(client, "Boda de la pareja");
    expect(first.error).toBeNull();
    const second = await create(client, "Otra boda de la pareja");
    expect(second.data).toBeNull();
    expect(second.error).toMatchObject(LIMIT);
    expect(await memberships(user.id)).toEqual([{ wedding_id: first.data?.id, role: "owner" }]);
  });

  it("6: a couple who is only a collaborator somewhere is refused too", async () => {
    const { user, client } = await freshUser();
    await select(client, "couple");
    const weddingId = await plannersWedding("Boda del planner con la pareja colaboradora");
    await addMembership(weddingId, user.id, "collaborator");
    const { error } = await create(client);
    expect(error).toMatchObject(LIMIT);
    expect(await memberships(user.id)).toEqual([{ wedding_id: weddingId, role: "collaborator" }]);
  });

  it("7: a legacy couple in several weddings is refused, and keeps every wedding and membership", async () => {
    const { user, client } = await freshUser();
    const a = await plannersWedding("Boda heredada A");
    const b = await plannersWedding("Boda heredada B");
    await addMembership(a, user.id, "owner");
    await addMembership(b, user.id, "collaborator");
    await select(client, "couple");
    const before = await memberships(user.id);

    const { error } = await create(client);
    expect(error).toMatchObject(LIMIT);
    expect(await memberships(user.id)).toEqual(before);
    // They still read both weddings through membership.
    const { data } = await client.from("weddings").select("id").order("id");
    expect(data?.map((w) => w.id).sort()).toEqual([a, b].sort());
  });

  it("8: concurrent first creations by a couple: exactly one wins, one membership", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { user, client } = await freshUser();
      await select(client, "couple");
      const results = await Promise.all([create(client, "Boda simultánea 1"), create(client, "Boda simultánea 2")]);
      expect(results.filter((r) => r.error === null), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => r.error?.message === "couple_wedding_limit"), `round ${round}`).toHaveLength(1);
      expect(await memberships(user.id), `round ${round}`).toHaveLength(1);
    }
  });

  it("9: a couple who already has a wedding can still join another one through an invitation", async () => {
    const { user, client } = await freshUser();
    await select(client, "couple");
    const own = await create(client, "Boda propia");
    expect(own.error).toBeNull();

    const other = await plannersWedding("Boda que invita a la pareja");
    const { token, tokenHash } = generateMembershipInviteToken();
    const invited = await as.ownerA.from("membership_invites").insert({
      wedding_id: other,
      token_hash: tokenHash,
      expires_at: membershipInviteExpiresAt().toISOString(),
      intended_role: "collaborator",
      email: null,
    });
    expect(invited.error).toBeNull();
    const accepted = await client.rpc("accept_membership_invite", { invite_token_hash: hashMembershipInviteToken(token) });
    expect(accepted.error).toBeNull();
    expect((await memberships(user.id)).map((m) => m.wedding_id).sort()).toEqual([own.data?.id, other].sort());
    // Joining didn't open creation.
    expect((await create(client)).error).toMatchObject(LIMIT);
  });

  it("10: anon can't call it", async () => {
    const { data, error } = await as.anon.rpc("create_wedding", { wedding_name: "Anónima" });
    expect(data).toBeNull();
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("11 + 12: one function, still SECURITY DEFINER with an empty search_path, executable only by authenticated (and service_role)", async () => {
    const rows = await sql<{ definer: boolean; config: string[]; acl: string; anon: boolean; auth: boolean; pub: boolean }>(
      `select p.prosecdef as definer, p.proconfig as config, p.proacl::text as acl,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as pub
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_wedding'`,
    );
    expect(rows).toEqual([
      {
        definer: true,
        config: ['search_path=""'],
        acl: "{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}",
        anon: false,
        auth: true,
        pub: false,
      },
    ]);
    // The shared fixture users are planners (global setup), so their suites keep creating freely.
    const typed = await sql<{ account_type: string }>(
      "select account_type::text as account_type from public.user_accounts where user_id = any($1::uuid[])",
      [Object.values(users).map((u) => u.id)],
    );
    expect(typed.map((t) => t.account_type)).toEqual(Object.values(users).map(() => "planner"));
  });
});
