import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import type { TimelineFormValues } from "@/lib/timeline/validation";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { createTimelineEntry, deleteTimelineEntry, getTimelineData, updateTimelineEntry } = await import(
  "@/lib/timeline/service"
);
const { EMPTY_TIMELINE_FORM, parseTimelineInput } = await import("@/lib/timeline/validation");
const { sortTimelineEntries, timelineNow, timelineSections } = await import("@/lib/timeline/summary");

// LB-23 services (what the Server Actions and the page call) against the real
// local stack: identity from the real Auth server, authority from real
// memberships, RLS, the CHECKs and the same-wedding vendor FK underneath.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

/** A session client that counts every Data API request it makes. */
async function sessionClient(user: TestUserKey) {
  const counter = { rest: 0 };
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname.startsWith("/rest/v1/")) counter.rest += 1;
        return fetch(input, init);
      },
    },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return { supabase, counter };
}

async function accessOf(user: TestUserKey, weddingId: string) {
  const { supabase, counter } = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  return { supabase, counter, access: access.access };
}

function input(overrides: Partial<TimelineFormValues>) {
  const result = parseTimelineInput({ ...EMPTY_TIMELINE_FORM, title: "Ceremonia", ...overrides });
  if (!result.ok) throw new Error(JSON.stringify(result.fieldErrors));
  return result.input;
}

async function vendorOf(weddingId: string, name: string, fields: Record<string, unknown> = {}): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `insert into public.wedding_vendors (wedding_id, name, category, contact_name, phone, email, notes, currency, contracted_amount_minor, status)
     values ($1, $2, 'photography', $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      weddingId,
      name,
      fields.contact_name ?? "Ana",
      fields.phone ?? "8888-1234",
      fields.email ?? "secreto@proveedor.cr",
      fields.notes ?? "Nota financiera secreta",
      fields.currency ?? "USD",
      fields.contracted_amount_minor ?? 987_654,
      fields.status ?? "booked",
    ],
  );
  return row!.id;
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Servicio Cronograma A");
  weddingB = await fixtureWedding("ownerB", "Boda Servicio Cronograma B");
  await addMember(weddingA, "collabA", "collaborator");
  await sql("update public.weddings set wedding_date = '2027-08-14', time_zone = 'America/Costa_Rica' where id = $1", [
    weddingA,
  ]);
});

describe("timeline service", () => {
  it("owner and collaborator create, update and delete; the read returns the projection", async () => {
    const vendorId = await vendorOf(weddingA, "Studio Luz");
    const { supabase, access } = await accessOf("collabA", weddingA);

    const created = await createTimelineEntry(
      supabase,
      weddingA,
      input({ title: "Llega fotógrafo", startTime: "09:30", weddingVendorId: vendorId, location: "Hotel" }),
    );
    expect(created.ok).toBe(true);
    const entryId = created.ok ? created.entryId : "";

    const owner = await accessOf("ownerA", weddingA);
    expect(
      await updateTimelineEntry(owner.supabase, weddingA, entryId, input({ title: "Llega fotógrafo", startTime: "10:00", location: "Jardín" })),
    ).toEqual({ ok: true, entryId });

    const data = await getTimelineData(supabase, access);
    const entry = data?.entries.find((e) => e.id === entryId);
    expect(entry).toMatchObject({ startTime: "10:00", location: "Jardín", vendor: null });

    expect(await deleteTimelineEntry(supabase, weddingA, entryId)).toEqual({ ok: true, entryId });
    expect(await sql("select 1 from public.wedding_timeline_entries where id = $1", [entryId])).toEqual([]);
  });

  it("a vendor of another wedding is invalid_vendor and nothing is written or changed", async () => {
    const foreignVendor = await vendorOf(weddingB, "Ajeno");
    const { supabase } = await accessOf("ownerA", weddingA);
    const before = await sql("select count(*)::int as n from public.wedding_timeline_entries where wedding_id = $1", [weddingA]);
    expect(await createTimelineEntry(supabase, weddingA, input({ weddingVendorId: foreignVendor }))).toEqual({
      ok: false,
      reason: "invalid_vendor",
    });
    expect(await sql("select count(*)::int as n from public.wedding_timeline_entries where wedding_id = $1", [weddingA])).toEqual(
      before,
    );

    const created = await createTimelineEntry(supabase, weddingA, input({ title: "Sin cambios" }));
    const entryId = created.ok ? created.entryId : "";
    expect(await updateTimelineEntry(supabase, weddingA, entryId, input({ title: "Cambiado", weddingVendorId: foreignVendor }))).toEqual({
      ok: false,
      reason: "invalid_vendor",
    });
    const [row] = await sql<{ title: string; wedding_vendor_id: string | null }>(
      "select title, wedding_vendor_id from public.wedding_timeline_entries where id = $1",
      [entryId],
    );
    expect(row).toEqual({ title: "Sin cambios", wedding_vendor_id: null });
  });

  it("another wedding's entry, a deleted one and a malformed id are invalid_target; non-members get not_found", async () => {
    const owner = await accessOf("ownerB", weddingB);
    const created = await createTimelineEntry(owner.supabase, weddingB, input({ title: "De B" }));
    const foreignEntry = created.ok ? created.entryId : "";

    const { supabase } = await accessOf("ownerA", weddingA);
    for (const entryId of [foreignEntry, "00000000-0000-4000-8000-000000000000", "nope"]) {
      expect(await updateTimelineEntry(supabase, weddingA, entryId, input({}))).toEqual({ ok: false, reason: "invalid_target" });
      expect(await deleteTimelineEntry(supabase, weddingA, entryId)).toEqual({ ok: false, reason: "invalid_target" });
    }
    expect(await createTimelineEntry(supabase, weddingB, input({}))).toEqual({ ok: false, reason: "not_found" });
    expect((await sql<{ title: string }>("select title from public.wedding_timeline_entries where id = $1", [foreignEntry]))[0]?.title).toBe(
      "De B",
    );
  });

  it("the read never carries vendor email, notes or money", async () => {
    const vendorId = await vendorOf(weddingA, "Banda Privada");
    const { supabase, access } = await accessOf("ownerA", weddingA);
    await createTimelineEntry(supabase, weddingA, input({ title: "Primer baile", startTime: "21:00", weddingVendorId: vendorId }));
    const data = await getTimelineData(supabase, access);
    const text = JSON.stringify(data);
    for (const secret of ["secreto@proveedor.cr", "Nota financiera secreta", "987654", "USD"]) {
      expect(text).not.toContain(secret);
    }
    const entry = data!.entries.find((e) => e.title === "Primer baile");
    expect(entry?.vendor).toEqual({
      id: vendorId,
      name: "Banda Privada",
      category: "photography",
      customCategory: null,
      status: "booked",
      contactName: "Ana",
      phone: "8888-1234",
    });
  });

  it("a wedding date change moves the headers without touching a row; a zone change only moves 'now'", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda que cambia de fecha");
    await sql("update public.weddings set wedding_date = '2027-08-14', time_zone = 'America/Costa_Rica' where id = $1", [wedding]);
    const { supabase, access } = await accessOf("ownerA", wedding);
    await createTimelineEntry(supabase, wedding, input({ title: "Ceremonia", startTime: "15:30", durationMinutes: "45" }));
    await createTimelineEntry(supabase, wedding, input({ title: "Desmontaje", dayOffset: "1", startTime: "00:30" }));
    const snapshot = () =>
      sql("select id, day_offset, start_time::text, duration_minutes, updated_at from public.wedding_timeline_entries where wedding_id = $1 order by id", [
        wedding,
      ]);
    const rowsBefore = await snapshot();

    const before = await getTimelineData(supabase, access);
    expect(timelineSections(before!.entries, before!.weddingDate).days.map((d) => d.date)).toEqual(["2027-08-14", "2027-08-15"]);

    await sql("update public.weddings set wedding_date = '2027-09-04', time_zone = 'Europe/Madrid' where id = $1", [wedding]);
    const after = await getTimelineData(supabase, access);
    expect(timelineSections(after!.entries, after!.weddingDate).days.map((d) => d.date)).toEqual(["2027-09-04", "2027-09-05"]);
    expect(after!.entries.map((e) => e.startTime).sort()).toEqual(["00:30", "15:30"]);
    expect(await snapshot()).toEqual(rowsBefore);

    // 13:40 UTC is 15:40 in Madrid on the new date: the ceremony is current.
    const now = timelineNow(after!.entries, { weddingDate: after!.weddingDate, timeZone: after!.timeZone, now: new Date("2027-09-04T13:40:00Z") });
    expect(now?.currentEntries.map((e) => e.title)).toEqual(["Ceremonia"]);
  });

  it("150 entries and 50 vendors read in two data queries, in canonical order", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda grande de cronograma");
    await sql(
      `insert into public.wedding_vendors (wedding_id, name, category)
       select $1, 'Proveedor ' || g, 'music' from generate_series(1, 50) g`,
      [wedding],
    );
    await sql(
      `insert into public.wedding_timeline_entries (wedding_id, title, day_offset, start_time, duration_minutes, wedding_vendor_id, created_at)
       select $1, 'Actividad ' || g,
              case when g % 10 = 0 then 1 else 0 end,
              case when g % 15 = 0 then null else make_time((g * 7) % 24, (g * 13) % 60, 0) end,
              case when g % 3 = 0 then 30 else null end,
              (select id from public.wedding_vendors v where v.wedding_id = $1 order by v.name offset (g % 50) limit 1),
              now() + make_interval(secs => g)
       from generate_series(1, 150) g`,
      [wedding],
    );
    const { supabase, counter, access } = await accessOf("ownerA", wedding);
    counter.rest = 0;
    const started = performance.now();
    const data = await getTimelineData(supabase, access);
    const elapsed = performance.now() - started;
    expect(counter.rest).toBe(2);
    expect(data?.entries).toHaveLength(150);
    expect(data?.vendorOptions).toHaveLength(50);
    expect(data!.entries.every((e) => e.vendor !== null)).toBe(true);
    // The database order and the pure sorter agree.
    expect(data!.entries.map((e) => e.id)).toEqual(sortTimelineEntries(data!.entries).map((e) => e.id));
    expect(elapsed).toBeLessThan(5_000);
  });
});
