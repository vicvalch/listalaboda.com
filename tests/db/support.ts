import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, inject } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUser, TestUserKey } from "./context";

export type WeddingRole = Database["public"]["Enums"]["wedding_role"];
export type DbClient = SupabaseClient<Database>;

export const ctx = inject("db");
export const users = ctx.users;

/** A Data API client acting as `user` (JWT from a real sign-in) or as anon. */
export function clientAs(user: TestUser | null): DbClient {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: user ? { headers: { Authorization: `Bearer ${user.accessToken}` } } : {},
  });
}

/**
 * service_role on the LOCAL stack, for the ADR-004 grant tests only: the one
 * role allowed to execute record_guest_invitation_email.
 */
export const serviceRole = createClient<Database>(ctx.apiUrl, ctx.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

export const as = {
  anon: clientAs(null),
  ...(Object.fromEntries(
    Object.entries(users).map(([key, user]) => [key, clientAs(user)]),
  ) as Record<TestUserKey, DbClient>),
};

/**
 * Superuser connection for TEST FIXTURES AND ASSERTIONS ONLY: arranging state
 * no client may create (e.g. an already-expired invite) and reading ground
 * truth regardless of RLS. Never used to perform the action under test.
 */
export const superuser = new pg.Pool({ connectionString: ctx.dbUrl, max: 4 });
afterAll(async () => {
  await superuser.end();
});

export async function sql<Row extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  return (await superuser.query<Row>(text, params)).rows;
}

let weddingCounter = 0;

/** Creates a wedding through the real create_wedding RPC as `owner`. */
export async function createWedding(owner: TestUserKey, name?: string): Promise<string> {
  const { data, error } = await as[owner].rpc("create_wedding", {
    wedding_name: name ?? `Boda de prueba ${++weddingCounter}`,
  });
  if (error || !data) throw new Error(`create_wedding failed: ${error?.message}`);
  return data.id;
}

/** Fixture: adds a membership directly (clients have no such path). */
export async function addMember(weddingId: string, user: TestUserKey, role: WeddingRole) {
  await sql(
    "insert into public.wedding_memberships (wedding_id, user_id, role) values ($1, $2, $3)",
    [weddingId, users[user].id, role],
  );
}

export async function membershipRole(
  weddingId: string,
  user: TestUserKey,
): Promise<WeddingRole | null> {
  const rows = await sql<{ role: WeddingRole }>(
    "select role from public.wedding_memberships where wedding_id = $1 and user_id = $2",
    [weddingId, users[user].id],
  );
  return rows[0]?.role ?? null;
}

export async function weddingExists(weddingId: string): Promise<boolean> {
  const rows = await sql("select 1 from public.weddings where id = $1", [weddingId]);
  return rows.length === 1;
}

/** Postgres "insufficient_privilege": missing grant or RLS WITH CHECK failure. */
export const PERMISSION_DENIED = "42501";
