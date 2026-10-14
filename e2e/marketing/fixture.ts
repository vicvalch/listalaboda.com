import pg from "pg";

import { readLocalSupabase } from "../support/local-supabase";
import { createAccountWithId, daysFromToday, seedWedding, ZONE } from "../support/overview";

/**
 * Marketing screenshot fixture (Marketing Landing V1): one fictional planner
 * account with three fictional weddings in the LOCAL database, written by the
 * superuser like the LB-24C overview fixtures (`e2e/support/overview.ts`):
 * rows built consistent by hand, triggers skipped (replica role). Every name,
 * place and amount is invented. No contact emails or phone numbers are set,
 * and guest links are random hashes no one holds, so no page can show a
 * usable RSVP link. Never pointed at production (`readLocalSupabase` refuses
 * anything that isn't local).
 */

export type MarketingFixture = Readonly<{ email: string; mainWeddingId: string }>;

async function db<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: readLocalSupabase().dbUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

type Party = Readonly<{ label: string; guests: ReadonlyArray<readonly [name: string, attending: boolean | null]> }>;

const PARTIES: readonly Party[] = [
  { label: "Familia Rojas Mora", guests: [["Ana Rojas", true], ["Luis Mora", true], ["Sofía Mora", true]] },
  { label: "Padrinos", guests: [["Gabriela Soto", true], ["Mauricio León", true]] },
  { label: "Familia Jiménez", guests: [["Carlos Jiménez", true], ["Marta Solís", false]] },
  { label: "Tía Carmen y Jorge", guests: [["Carmen Vargas", null], ["Jorge Castro", null]] },
  { label: "Amigos de la U", guests: [["Daniela Quesada", true], ["Pablo Herrera", true], ["Andrea Brenes", null]] },
  { label: "Familia Chaves", guests: [["Rodrigo Chaves", true], ["Laura Arias", true]] },
  { label: "Compañeros de trabajo", guests: [["Fernanda Ulate", false], ["Esteban Mora", true]] },
];

/** Tables: name, shape, capacity, board center (snapped to the planner's 20-unit grid). */
const TABLES = [
  { name: "Mesa principal", shape: "rectangle", capacity: 12, x: 600, y: 160 },
  { name: "Mesa 1", shape: "round", capacity: 10, x: 300, y: 440 },
  { name: "Mesa 2", shape: "round", capacity: 10, x: 600, y: 460 },
  { name: "Mesa 3", shape: "round", capacity: 10, x: 900, y: 440 },
] as const;

/** Who sits where (by guest name). Fernanda declined after being seated: the planner flags it. */
const SEATS: Record<string, string> = {
  "Gabriela Soto": "Mesa principal",
  "Mauricio León": "Mesa principal",
  "Ana Rojas": "Mesa 1",
  "Luis Mora": "Mesa 1",
  "Sofía Mora": "Mesa 1",
  "Carlos Jiménez": "Mesa 1",
  "Daniela Quesada": "Mesa 2",
  "Pablo Herrera": "Mesa 2",
  "Rodrigo Chaves": "Mesa 3",
  "Laura Arias": "Mesa 3",
  "Fernanda Ulate": "Mesa 3",
  "Esteban Mora": "Mesa 3",
};

const CHECKLIST = [
  { title: "Reservar el lugar de la ceremonia", category: "venue_and_date", status: "done" },
  { title: "Contratar fotografía", category: "vendors", status: "done" },
  { title: "Enviar las invitaciones", category: "invitations", status: "done" },
  { title: "Prueba de menú con el catering", category: "reception", status: "pending", due: 9 },
  { title: "Confirmar música de la ceremonia", category: "ceremony", status: "pending", due: 16 },
  { title: "Prueba final del vestido", category: "attire", status: "pending", due: 30 },
  { title: "Entregar la lista de canciones a la banda", category: "reception", status: "pending", due: 40 },
  { title: "Confirmar transporte de invitados", category: "final_preparations", status: "pending", due: 52 },
] as const;

/** Vendors: amounts in minor units (CRC céntimos, USD cents); all fictional. */
const VENDORS = [
  { key: "venue", name: "Hacienda El Roble", category: "venue", status: "booked", currency: "CRC", contracted: 450_000_000 },
  { key: "catering", name: "Sabores del Valle", category: "catering", status: "booked", currency: "CRC", contracted: 320_000_000 },
  { key: "photo", name: "Luz y Momento", category: "photography", status: "booked", currency: "USD", contracted: 240_000 },
  { key: "cake", name: "Dulce Tentación", category: "cake_desserts", status: "booked", currency: "CRC", contracted: 28_000_000 },
  { key: "flowers", name: "Flores del Campo", category: "flowers_decor", status: "quoted", currency: "CRC", quoted: 90_000_000 },
  { key: "music", name: "Banda Aurora", category: "music", status: "selected", currency: "CRC", quoted: 75_000_000 },
] as const;

/** Schedule items per vendor: label, amount, due (days from today), paid (days from today, or none). */
const SCHEDULE: Record<string, ReadonlyArray<readonly [string, number, number, number | null]>> = {
  venue: [
    ["Reserva (50 %)", 225_000_000, -60, -62],
    ["Saldo", 225_000_000, 20, null],
  ],
  catering: [
    ["Adelanto", 96_000_000, -30, -31],
    ["Segunda cuota", 112_000_000, 6, null],
    ["Saldo", 112_000_000, 45, null],
  ],
  photo: [
    ["Adelanto", 80_000, -45, -45],
    ["Saldo", 160_000, 40, null],
  ],
  cake: [["Pago único", 28_000_000, 30, null]],
};

const TIMELINE = [
  { title: "Preparación de la novia", day: 0, start: "12:00", minutes: 120, phase: "getting_ready", location: "Suite del hotel", responsible: "Valeria" },
  { title: "Montaje de la decoración", day: 0, start: "13:00", minutes: 120, phase: "setup", location: "Jardín principal", vendor: "flowers" },
  { title: "Ceremonia", day: 0, start: "15:00", minutes: 45, phase: "ceremony", location: "Jardín principal", responsible: "Valeria" },
  { title: "Fotos familiares", day: 0, start: "15:45", minutes: 45, phase: "photos", location: "Jardín principal", vendor: "photo" },
  { title: "Cóctel de bienvenida", day: 0, start: "16:30", minutes: 60, phase: "cocktail", location: "Terraza", vendor: "catering" },
  { title: "Entrada de los novios y cena", day: 0, start: "17:30", minutes: 90, phase: "reception", location: "Salón", vendor: "catering" },
  { title: "Primer baile", day: 0, start: "19:30", minutes: 15, phase: "reception", location: "Salón" },
  { title: "Fiesta", day: 0, start: "19:45", minutes: 255, phase: "reception", location: "Salón", vendor: "music" },
  { title: "Cierre y desmontaje", day: 1, start: "00:00", minutes: 60, phase: "closing", location: "Salón", responsible: "Valeria" },
] as const;

async function seedMainWedding(ownerId: string): Promise<string> {
  return db(async (client) => {
    await client.query("begin");
    try {
      await client.query("set local session_replication_role = replica");
      const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => (await client.query<T>(sql, params)).rows;

      const [{ id }] = await q<{ id: string }>(
        `insert into public.weddings (name, wedding_date, city, time_zone, created_by)
         values ('Sofía y Andrés', $1, 'Santa Ana', $2, $3) returning id`,
        [daysFromToday(68), ZONE, ownerId],
      );
      await q("insert into public.wedding_memberships (wedding_id, user_id, role, display_name) values ($1, $2, 'owner', 'Valeria')", [id, ownerId]);

      for (const [index, item] of CHECKLIST.entries()) {
        const due = "due" in item ? daysFromToday(item.due) : null;
        await q(
          `insert into public.checklist_items (wedding_id, title, category, status, timing_mode, due_date, completed_at, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, item.title, item.category, item.status, due ? "absolute" : "none", due, item.status === "done" ? new Date() : null, index + 1],
        );
      }

      const tableIds = new Map<string, string>();
      for (const [index, table] of TABLES.entries()) {
        const [row] = await q<{ id: string }>(
          `insert into public.seating_tables (wedding_id, name, shape, capacity, layout_x, layout_y, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [id, table.name, table.shape, table.capacity, table.x, table.y, index + 1],
        );
        tableIds.set(table.name, row.id);
      }

      for (const party of PARTIES) {
        const [{ id: partyId }] = await q<{ id: string }>(
          `insert into public.guest_invitations (wedding_id, label, token_hash)
           values ($1, $2, encode(extensions.gen_random_bytes(32), 'hex')) returning id`,
          [id, party.label],
        );
        for (const [name, attending] of party.guests) {
          const [{ id: guestId }] = await q<{ id: string }>(
            "insert into public.guests (wedding_id, guest_invitation_id, name) values ($1, $2, $3) returning id",
            [id, partyId, name],
          );
          if (attending !== null) {
            await q("insert into public.rsvps (guest_id, wedding_id, attending) values ($1, $2, $3)", [guestId, id, attending]);
          }
          const table = SEATS[name];
          if (table) {
            await q("insert into public.seating_assignments (guest_id, wedding_id, seating_table_id) values ($1, $2, $3)", [
              guestId,
              id,
              tableIds.get(table),
            ]);
          }
        }
      }

      const vendorIds = new Map<string, string>();
      for (const vendor of VENDORS) {
        const [{ id: vendorId }] = await q<{ id: string }>(
          `insert into public.wedding_vendors (wedding_id, name, category, status, currency, quoted_amount_minor, contracted_amount_minor)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            id,
            vendor.name,
            vendor.category,
            vendor.status,
            vendor.currency,
            "quoted" in vendor ? vendor.quoted : null,
            "contracted" in vendor ? vendor.contracted : null,
          ],
        );
        vendorIds.set(vendor.key, vendorId);
      }
      for (const [key, items] of Object.entries(SCHEDULE)) {
        for (const [label, amount, due, paid] of items) {
          const [{ id: itemId }] = await q<{ id: string }>(
            `insert into public.vendor_payment_schedule_items (wedding_id, wedding_vendor_id, label, amount_minor, due_on)
             values ($1, $2, $3, $4, $5) returning id`,
            [id, vendorIds.get(key), label, amount, daysFromToday(due)],
          );
          if (paid !== null) {
            await q(
              `insert into public.vendor_payments (wedding_id, wedding_vendor_id, schedule_item_id, amount_minor, paid_on)
               values ($1, $2, $3, $4, $5)`,
              [id, vendorIds.get(key), itemId, amount, daysFromToday(paid)],
            );
          }
        }
      }
      await q("insert into public.wedding_budget_totals (wedding_id, currency, amount_minor) values ($1, 'CRC', 1200000000), ($1, 'USD', 300000)", [id]);
      for (const [category, amount] of [
        ["venue", 500_000_000],
        ["catering", 350_000_000],
        ["flowers_decor", 90_000_000],
        ["music", 80_000_000],
      ] as const) {
        await q("insert into public.wedding_budget_allocations (wedding_id, category, currency, amount_minor) values ($1, $2, 'CRC', $3)", [
          id,
          category,
          amount,
        ]);
      }

      for (const entry of TIMELINE) {
        await q(
          `insert into public.wedding_timeline_entries
             (wedding_id, title, day_offset, start_time, duration_minutes, phase, location, responsible_name, wedding_vendor_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            entry.title,
            entry.day,
            entry.start,
            entry.minutes,
            entry.phase,
            entry.location,
            "responsible" in entry ? entry.responsible : null,
            "vendor" in entry ? vendorIds.get(entry.vendor) : null,
          ],
        );
      }

      await client.query("commit");
      return id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

/** Creates the fictional planner, the main wedding and two more for "Mis bodas". */
export async function seedMarketingFixture(): Promise<MarketingFixture> {
  const { email, id: ownerId } = await createAccountWithId("marketing-planner");
  const mainWeddingId = await seedMainWedding(ownerId);
  await seedWedding({
    name: "Laura y Martín",
    date: daysFromToday(24),
    city: "Escazú",
    members: [{ userId: ownerId, role: "owner" }],
    overduePayments: { crc: 85_000_000 },
    overdueChecklist: 2,
    doneChecklist: 14,
  });
  await seedWedding({
    name: "Camila y José",
    date: daysFromToday(190),
    city: "Liberia",
    members: [{ userId: ownerId, role: "owner" }],
    doneChecklist: 6,
    attending: 6,
    unanswered: 10,
  });
  return { email, mainWeddingId };
}
