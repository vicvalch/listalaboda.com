import { execFileSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import type { TestProject } from "vitest/node";

import {
  TEST_EMAIL_DOMAIN,
  TEST_USERS,
  type DbTestContext,
  type TestUser,
  type TestUserKey,
} from "./context";

// Local-only fixture password for fake @example.test accounts on the local
// Supabase stack. Not a credential for anything real.
const LOCAL_TEST_PASSWORD = "local-only-fixture-password";

type SupabaseStatus = { API_URL?: string; DB_URL?: string; PUBLISHABLE_KEY?: string; SECRET_KEY?: string };

function readLocalStatus(): Required<SupabaseStatus> {
  let status: SupabaseStatus;
  try {
    status = JSON.parse(
      execFileSync("npx", ["supabase", "status", "-o", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as SupabaseStatus;
  } catch {
    throw new Error(
      "Local Supabase is not running. Start it with `npm run db:start` (requires Docker).",
    );
  }
  const { API_URL, DB_URL, PUBLISHABLE_KEY, SECRET_KEY } = status;
  if (!API_URL || !DB_URL || !PUBLISHABLE_KEY || !SECRET_KEY) {
    throw new Error("`supabase status` did not report API_URL, DB_URL, PUBLISHABLE_KEY and SECRET_KEY.");
  }
  for (const url of [API_URL, DB_URL]) {
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error(`Refusing to run DB tests against a non-local host: ${host}`);
    }
  }
  return { API_URL, DB_URL, PUBLISHABLE_KEY, SECRET_KEY };
}

/** Signs in a fake local user, creating it through normal sign-up if needed. */
async function signIn(apiUrl: string, publishableKey: string, email: string) {
  const auth = createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth;

  const credentials = { email, password: LOCAL_TEST_PASSWORD };
  const signedIn = await auth.signInWithPassword(credentials);
  const result =
    signedIn.error?.code === "invalid_credentials" ? await auth.signUp(credentials) : signedIn;

  const { session } = result.data;
  if (result.error || !session) {
    throw new Error(
      `Could not sign in local test user ${email}: ${result.error?.message ?? "no session"}`,
    );
  }
  return {
    id: session.user.id,
    email,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

export default async function setup(project: TestProject) {
  const status = readLocalStatus();

  const db = new pg.Client({ connectionString: status.DB_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ ok: boolean }>(
      "select to_regclass('public.membership_invites') is not null as ok",
    );
    if (!rows[0]?.ok) {
      throw new Error("LB-03 schema is missing. Run `npm run db:reset` first.");
    }
    // Remove data left by earlier runs. Only weddings touched by the fake test
    // accounts are deleted; memberships and invites cascade.
    await db.query(
      `delete from public.weddings w
       where w.created_by in (select id from auth.users where email like $1)
          or exists (
            select 1 from public.wedding_memberships m
            join auth.users u on u.id = m.user_id
            where m.wedding_id = w.id and u.email like $1
          )`,
      [`%@${TEST_EMAIL_DOMAIN}`],
    );
  } finally {
    await db.end();
  }

  const users = {} as Record<TestUserKey, TestUser>;
  for (const [key, email] of Object.entries(TEST_USERS) as [TestUserKey, string][]) {
    users[key] = await signIn(status.API_URL, status.PUBLISHABLE_KEY, email);
  }

  const context: DbTestContext = {
    apiUrl: status.API_URL,
    dbUrl: status.DB_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
    users,
  };
  project.provide("db", context);
}
