import pg from "pg";

import { E2E_EMAIL_PATTERN } from "./support/identities";
import { readLocalSupabase } from "./support/local-supabase";

/**
 * Removes data left by earlier E2E runs on the LOCAL stack: weddings touched
 * by E2E accounts (memberships and invites cascade), then the accounts.
 * Each run uses fresh, unique fake identities, so tests never depend on
 * leftovers — this only keeps the local database from growing.
 *
 * The direct Postgres connection is test tooling for cleanup only; the app
 * under test never uses it.
 */
export default async function globalSetup() {
  const { dbUrl } = readLocalSupabase();
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ ok: boolean }>(
      "select to_regclass('public.membership_invites') is not null as ok",
    );
    if (!rows[0]?.ok) throw new Error("LB-03 schema is missing. Run `npm run db:reset` first.");

    await db.query(
      `delete from public.weddings w
       where exists (
         select 1 from public.wedding_memberships m
         join auth.users u on u.id = m.user_id
         where m.wedding_id = w.id and u.email like $1
       )`,
      [E2E_EMAIL_PATTERN],
    );
    await db.query("delete from auth.users where email like $1", [E2E_EMAIL_PATTERN]);
  } finally {
    await db.end();
  }
}
