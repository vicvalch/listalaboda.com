import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import type { Database } from "../../src/lib/supabase/database.types";
import { addDaysToIsoDate } from "../../src/lib/checklist/timing";
import { weddingLocalToday } from "../../src/lib/weddings/timezone";
import { chooseAccountType, type E2EAccountType } from "./flows";
import { E2E_PASSWORD, uniqueEmail } from "./identities";
import { readLocalSupabase } from "./local-supabase";

/**
 * LB-24C fixtures: weddings, memberships and domain rows written straight to
 * the LOCAL database by the superuser, so "Mis bodas" and the switcher can be
 * tested with many weddings and every attention kind without long UI setup.
 * Rows are built consistent by hand (same wedding everywhere, payments under
 * their items); the RSVP-link envelope trigger is skipped (replica role)
 * because no test here opens a guest link. The app always reads them as a
 * real signed-in user. Fake names only.
 */

export const ZONE = "America/Costa_Rica";

export function daysFromToday(days: number): string {
  return addDaysToIsoDate(weddingLocalToday(ZONE, new Date())!, days)!;
}

async function db<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * A confirmed local account with its account type chosen through the real
 * RPC as itself (ACCOUNT-01; null = not chosen yet); `metadata` lands in
 * user_metadata (e.g. a fake planner flag, which must never matter).
 */
export async function createAccountWithId(
  label: string,
  accountType: E2EAccountType,
  metadata?: Record<string, unknown>,
): Promise<{ email: string; id: string }> {
  const { apiUrl, publishableKey } = readLocalSupabase();
  const email = uniqueEmail(label);
  const client = createClient<Database>(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signUp({
    email,
    password: E2E_PASSWORD,
    ...(metadata ? { options: { data: metadata } } : {}),
  });
  if (error || !data.user || !data.session) throw new Error(`Could not create local E2E account: ${error?.code}`);
  if (accountType) await chooseAccountType(client, accountType);
  return { email, id: data.user.id };
}

export type SeedWedding = Readonly<{
  name: string;
  date?: string | null;
  city?: string | null;
  timeZone?: string | null;
  /** Memberships; `createdBy` only sets `weddings.created_by` (never access). */
  members: readonly Readonly<{ userId: string; role: "owner" | "collaborator" }>[];
  createdBy?: string;
  /** Overdue cuotas: one booked vendor per currency, one item due 10 days ago. */
  overduePayments?: Readonly<{ crc?: number; usd?: number }>;
  /** Pending checklist items due 5 and 20 days ago. */
  overdueChecklist?: number;
  /** Done checklist items (no due date). */
  doneChecklist?: number;
  /** Checklist rows past PostgREST's 1000-row cap: the domain becomes unavailable. */
  truncatedChecklist?: boolean;
  /** Guests seated who declined; plus `attending` / `unanswered` guests (unseated). */
  seatedDeclined?: number;
  attending?: number;
  unanswered?: number;
}>;

/** Inserts one wedding with its memberships and rows; returns its id. */
export async function seedWedding(spec: SeedWedding): Promise<string> {
  return db(async (client) => {
    await client.query("begin");
    try {
      await client.query("set local session_replication_role = replica");
      const { rows } = await client.query<{ id: string }>(
        `insert into public.weddings (name, wedding_date, city, time_zone, created_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          spec.name,
          spec.date === undefined ? daysFromToday(120) : spec.date,
          spec.city ?? null,
          spec.timeZone === undefined ? ZONE : spec.timeZone,
          spec.createdBy ?? spec.members[0]?.userId ?? null,
        ],
      );
      const id = rows[0].id;
      for (const member of spec.members) {
        await client.query("insert into public.wedding_memberships (wedding_id, user_id, role) values ($1, $2, $3)", [
          id,
          member.userId,
          member.role,
        ]);
      }

      for (const [currency, amount] of [
        ["CRC", spec.overduePayments?.crc],
        ["USD", spec.overduePayments?.usd],
      ] as const) {
        if (!amount) continue;
        const vendor = await client.query<{ id: string }>(
          `insert into public.wedding_vendors (wedding_id, name, category, status, currency, contracted_amount_minor)
           values ($1, $2, 'photography', 'booked', $3, $4) returning id`,
          [id, `Proveedor ${currency}`, currency, amount * 2],
        );
        await client.query(
          `insert into public.vendor_payment_schedule_items (wedding_id, wedding_vendor_id, label, amount_minor, due_on)
           values ($1, $2, 'Adelanto', $3, $4)`,
          [id, vendor.rows[0].id, amount, daysFromToday(-10)],
        );
      }

      for (let i = 0; i < (spec.overdueChecklist ?? 0); i += 1) {
        await client.query(
          `insert into public.checklist_items (wedding_id, title, status, timing_mode, due_date, sort_order)
           values ($1, $2, 'pending', 'absolute', $3, $4)`,
          [id, `Pendiente atrasado ${i + 1}`, daysFromToday(i === 0 ? -20 : -5), i + 1],
        );
      }
      if (spec.doneChecklist) {
        await client.query(
          `insert into public.checklist_items (wedding_id, title, status, completed_at, sort_order)
           select $1, 'Hecho ' || g, 'done', now(), 100 + g from generate_series(1, $2) g`,
          [id, spec.doneChecklist],
        );
      }
      if (spec.truncatedChecklist) {
        await client.query(
          `insert into public.checklist_items (wedding_id, title, status, sort_order)
           select $1, 'Pendiente ' || g, 'pending', 1000 + g from generate_series(1, 1001) g`,
          [id],
        );
      }

      const guests = (spec.seatedDeclined ?? 0) + (spec.attending ?? 0) + (spec.unanswered ?? 0);
      if (guests > 0) {
        const party = await client.query<{ id: string }>(
          `insert into public.guest_invitations (wedding_id, label, token_hash)
           values ($1, 'Familia de prueba', encode(extensions.gen_random_bytes(32), 'hex')) returning id`,
          [id],
        );
        const table = await client.query<{ id: string }>(
          "insert into public.seating_tables (wedding_id, name, capacity, sort_order) values ($1, 'Mesa 1', 50, 1) returning id",
          [id],
        );
        const answers = [
          ...Array<boolean | null>(spec.seatedDeclined ?? 0).fill(false),
          ...Array<boolean | null>(spec.attending ?? 0).fill(true),
          ...Array<boolean | null>(spec.unanswered ?? 0).fill(null),
        ];
        for (const [index, attending] of answers.entries()) {
          const guest = await client.query<{ id: string }>(
            "insert into public.guests (wedding_id, guest_invitation_id, name) values ($1, $2, $3) returning id",
            [id, party.rows[0].id, `Invitado ${index + 1}`],
          );
          if (attending !== null) {
            await client.query("insert into public.rsvps (guest_id, wedding_id, attending) values ($1, $2, $3)", [
              guest.rows[0].id,
              id,
              attending,
            ]);
          }
          if (attending === false) {
            await client.query(
              "insert into public.seating_assignments (guest_id, wedding_id, seating_table_id) values ($1, $2, $3)",
              [guest.rows[0].id, id, table.rows[0].id],
            );
          }
        }
      }
      await client.query("commit");
      return id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

/** Many plain weddings (dated, with a zone) owned by one user, in one statement. */
export async function seedManyWeddings(userId: string, count: number, prefix = "Boda"): Promise<void> {
  await db(async (client) => {
    await client.query(
      `with created as (
         insert into public.weddings (name, wedding_date, city, time_zone, created_by)
         select $2 || ' ' || lpad(g::text, 3, '0'), date '2027-01-01' + g, 'Ciudad ' || g, $3, $1
         from generate_series(1, $4) g
         returning id
       )
       insert into public.wedding_memberships (wedding_id, user_id, role)
       select id, $1, 'owner' from created`,
      [userId, prefix, ZONE, count],
    );
  });
}
