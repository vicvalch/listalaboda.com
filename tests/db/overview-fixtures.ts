import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { ctx, sql, superuser, type DbClient, type WeddingRole } from "./support";

/**
 * LB-24B fixtures: fresh accounts and bulk domain rows for the overview's
 * integration, truncation and performance tests. Bulk rows are written by
 * the superuser in ONE transaction with triggers skipped (replica role), so
 * every row is built consistent by hand: same-wedding references, seated
 * guests within capacity, payments under their schedule item. Fixtures only;
 * the action under test always runs as a real signed-in user.
 */

export type Account = Readonly<{ id: string; client: DbClient; accessToken: string }>;

const PASSWORD = "local-test-password-lb24b";
export const accountIds: string[] = [];
export const weddingIds: string[] = [];

export async function account(label: string, metadata?: Record<string, unknown>): Promise<Account> {
  const client = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const email = `lb24b-${label}-${randomBytes(6).toString("hex")}@example.test`;
  const { data, error } = await client.auth.signUp({
    email,
    password: PASSWORD,
    ...(metadata ? { options: { data: metadata } } : {}),
  });
  if (error || !data.session || !data.user) throw new Error(`sign-up failed: ${error?.message}`);
  accountIds.push(data.user.id);
  return { id: data.user.id, client, accessToken: data.session.access_token };
}

/** The same user's client with every Data API request counted (one per root query). */
export function countingClient(who: Account): Readonly<{ client: DbClient; requests: string[] }> {
  const requests: string[] = [];
  const client = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${who.accessToken}` },
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return fetch(input, init);
      },
    },
  });
  return { client, requests };
}

export type WeddingFixture = Readonly<{
  name: string;
  weddingDate?: string | null;
  timeZone?: string | null;
}>;

/** A wedding created through the real `create_wedding` RPC, so `owner` is its creator and owner. */
export async function wedding(owner: Account, fixture: WeddingFixture): Promise<string> {
  const { data, error } = await owner.client.rpc("create_wedding", {
    wedding_name: fixture.name,
    ...(fixture.weddingDate ? { wedding_date: fixture.weddingDate } : {}),
    ...(fixture.timeZone ? { wedding_time_zone: fixture.timeZone } : {}),
  });
  if (error || !data) throw new Error(`create_wedding failed: ${error?.message}`);
  weddingIds.push(data.id);
  return data.id;
}

/** Fixture: memberships have no client insert path outside invites. */
export async function join(weddingId: string, who: Account, role: WeddingRole) {
  await sql("insert into public.wedding_memberships (wedding_id, user_id, role) values ($1, $2, $3)", [
    weddingId,
    who.id,
    role,
  ]);
}

export async function cleanupOverviewFixtures() {
  await sql("delete from public.weddings where id = any($1::uuid[])", [weddingIds]);
  await sql("delete from auth.users where id = any($1::uuid[])", [accountIds]);
}

export type VolumeSpec = Readonly<{
  checklistItems?: number;
  parties?: number;
  guestsPerParty?: number;
  tables?: number;
  seatedPerTable?: number;
  vendors?: number;
  itemsPerVendor?: number;
  paymentsPerVendor?: number;
  timelineEntries?: number;
}>;

/**
 * Bulk domain rows for one wedding, in one replica-role transaction.
 *
 * - checklist: alternating pending/done, absolute due dates spread over 2026
 * - guests: every 4th guest unanswered, every 10th declined, the rest attending
 * - seating: the first `tables × seatedPerTable` guests are seated, table by table
 * - vendors: booked, CRC, contract 1 000 000; items of 10 000 due across 2026;
 *   payments of 5 000 each linked to the vendor's items in turn
 * - timeline: every 5th entry untimed, others hourly
 */
export async function seedVolume(weddingId: string, spec: VolumeSpec) {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");

    if (spec.checklistItems) {
      await client.query(
        `insert into public.checklist_items (wedding_id, title, status, timing_mode, due_date, sort_order, completed_at)
         select $1, 'Pendiente ' || g,
                case when g % 2 = 0 then 'done' else 'pending' end::public.checklist_item_status,
                'absolute', date '2026-01-01' + (g % 365), g,
                case when g % 2 = 0 then now() end
         from generate_series(1, $2) g`,
        [weddingId, spec.checklistItems],
      );
    }

    if (spec.parties && spec.guestsPerParty) {
      await client.query(
        `insert into public.guest_invitations (wedding_id, label, token_hash)
         select $1, 'Grupo ' || g, encode(extensions.gen_random_bytes(32), 'hex')
         from generate_series(1, $2) g`,
        [weddingId, spec.parties],
      );
      await client.query(
        `insert into public.guests (wedding_id, guest_invitation_id, name)
         select gi.wedding_id, gi.id, 'Invitado ' || n
         from public.guest_invitations gi cross join generate_series(1, $2) n
         where gi.wedding_id = $1`,
        [weddingId, spec.guestsPerParty],
      );
      await client.query(
        `insert into public.rsvps (guest_id, wedding_id, attending)
         select id, wedding_id, (rn % 10 <> 0)
         from (select id, wedding_id, row_number() over (order by id) rn from public.guests where wedding_id = $1) g
         where rn % 4 <> 0`,
        [weddingId],
      );
    }

    if (spec.tables && spec.seatedPerTable) {
      await client.query(
        `insert into public.seating_tables (wedding_id, name, capacity, sort_order)
         select $1, 'Mesa ' || g, 50, g from generate_series(1, $2) g`,
        [weddingId, spec.tables],
      );
      await client.query(
        `with t as (
           select id, row_number() over (order by sort_order) - 1 as idx from public.seating_tables where wedding_id = $1
         ), g as (
           select id, row_number() over (order by id) - 1 as idx from public.guests where wedding_id = $1
         )
         insert into public.seating_assignments (guest_id, wedding_id, seating_table_id)
         select g.id, $1, t.id from g join t on t.idx = g.idx / $2
         where g.idx < $2 * (select count(*) from t)`,
        [weddingId, spec.seatedPerTable],
      );
    }

    if (spec.vendors) {
      await client.query(
        `insert into public.wedding_vendors (wedding_id, name, category, status, currency, contracted_amount_minor)
         select $1, 'Proveedor ' || g, 'photography', 'booked', 'CRC', 1000000 from generate_series(1, $2) g`,
        [weddingId, spec.vendors],
      );
      if (spec.itemsPerVendor) {
        await client.query(
          `insert into public.vendor_payment_schedule_items (wedding_id, wedding_vendor_id, label, amount_minor, due_on)
           select $1, v.id, 'Cuota ' || n, 10000, date '2026-01-01' + (n * 37 % 365)
           from public.wedding_vendors v cross join generate_series(1, $2) n where v.wedding_id = $1`,
          [weddingId, spec.itemsPerVendor],
        );
      }
      if (spec.paymentsPerVendor) {
        await client.query(
          `with items as (
             select id, wedding_vendor_id, row_number() over (partition by wedding_vendor_id order by id) - 1 as idx,
                    count(*) over (partition by wedding_vendor_id) as total
             from public.vendor_payment_schedule_items where wedding_id = $1
           )
           insert into public.vendor_payments (wedding_id, wedding_vendor_id, schedule_item_id, amount_minor, paid_on)
           select $1, v.id, i.id, 5000, date '2026-01-01' + n
           from public.wedding_vendors v cross join generate_series(0, $2 - 1) n
           left join items i on i.wedding_vendor_id = v.id and i.idx = n % greatest(i.total, 1)
           where v.wedding_id = $1`,
          [weddingId, spec.paymentsPerVendor],
        );
      }
    }

    if (spec.timelineEntries) {
      await client.query(
        `insert into public.wedding_timeline_entries (wedding_id, title, day_offset, start_time, duration_minutes)
         select $1, 'Momento ' || g, 0,
                case when g % 5 = 0 then null else make_time(g % 24, 0, 0) end,
                case when g % 5 = 0 then null else 30 end
         from generate_series(1, $2) g`,
        [weddingId, spec.timelineEntries],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
