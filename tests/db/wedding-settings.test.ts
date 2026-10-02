import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { effectiveDueDate } = await import("@/lib/checklist/timing");
const { createChecklistItem, getWeddingChecklist, initializeWeddingChecklist } = await import(
  "@/lib/checklist/service"
);
const { getWeddingDetail, updateWeddingSettings } = await import("@/lib/weddings/service");
const { parseWeddingInput } = await import("@/lib/weddings/validation");

// LB-06 wedding settings service (what the settings Server Action calls)
// against the real local stack: real Auth identity, real memberships, RLS
// underneath. Also proves the date-recalculation invariant end to end:
// moving the wedding date rewrites no checklist row.

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

async function sessionClient(user: TestUserKey | null) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  if (user) {
    const { error } = await supabase.auth.setSession({
      access_token: users[user].accessToken,
      refresh_token: users[user].refreshToken,
    });
    if (error) throw new Error(`setSession failed: ${error.message}`);
  }
  return supabase;
}

async function weddingRow(weddingId: string) {
  const rows = await sql<{ name: string; wedding_date: string | null }>(
    "select name, wedding_date::text from public.weddings where id = $1",
    [weddingId],
  );
  return rows[0];
}

function input(name: string, weddingDate: string, city = "", timeZone = "") {
  const parsed = parseWeddingInput({ name, weddingDate, city, timeZone });
  if (!parsed.ok) throw new Error("fixture input should be valid");
  return parsed.input;
}

describe("updateWeddingSettings", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda de ajustes");
    await addMember(weddingId, "collabA", "collaborator");
  });

  it("the owner renames the wedding (trimmed) and sets the date", async () => {
    const result = await updateWeddingSettings(
      await sessionClient("ownerA"),
      weddingId,
      input("  Boda de ajustes renombrada  ", "2027-08-14"),
    );
    expect(result).toEqual({ ok: true });
    expect(await weddingRow(weddingId)).toEqual({
      name: "Boda de ajustes renombrada",
      wedding_date: "2027-08-14",
    });
  });

  it("the owner changes the date", async () => {
    const supabase = await sessionClient("ownerA");
    expect(
      await updateWeddingSettings(supabase, weddingId, input("Boda de ajustes renombrada", "2028-02-29")),
    ).toEqual({ ok: true });
    expect((await weddingRow(weddingId)).wedding_date).toBe("2028-02-29");
  });

  it("a blank date clears it to NULL, not an empty string", async () => {
    const supabase = await sessionClient("ownerA");
    expect(
      await updateWeddingSettings(supabase, weddingId, input("Boda de ajustes renombrada", "  ")),
    ).toEqual({ ok: true });
    const rows = await sql<{ is_null: boolean }>(
      "select wedding_date is null as is_null from public.weddings where id = $1",
      [weddingId],
    );
    expect(rows[0]?.is_null).toBe(true);
    const detail = await getWeddingDetail(supabase, weddingId);
    expect(detail?.weddingDate).toBeNull();
  });

  it("validation rejects blank and over-long names before the database", () => {
    expect(parseWeddingInput({ name: "   ", weddingDate: "", city: "", timeZone: "" }).ok).toBe(false);
    expect(parseWeddingInput({ name: "x".repeat(201), weddingDate: "", city: "", timeZone: "" }).ok).toBe(false);
    expect(parseWeddingInput({ name: "x".repeat(200), weddingDate: "", city: "", timeZone: "" }).ok).toBe(true);
  });

  it("the database stays authoritative for blank and over-long names", async () => {
    const supabase = await sessionClient("ownerA");
    const before = await weddingRow(weddingId);
    expect(
      await updateWeddingSettings(supabase, weddingId, { name: "   ", weddingDate: null, city: null, timeZone: null }),
    ).toEqual({ ok: false, reason: "invalid_name" });
    expect(
      await updateWeddingSettings(supabase, weddingId, { name: "x".repeat(201), weddingDate: null, city: null, timeZone: null }),
    ).toEqual({ ok: false, reason: "invalid_name" });
    expect(await weddingRow(weddingId)).toEqual(before);
  });

  it("a collaborator is forbidden; nothing changes", async () => {
    const before = await weddingRow(weddingId);
    const result = await updateWeddingSettings(
      await sessionClient("collabA"),
      weddingId,
      input("Boda cambiada por colaborador", "2030-01-01"),
    );
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(await weddingRow(weddingId)).toEqual(before);
  });

  it("an outsider gets not_found (no disclosure); nothing changes", async () => {
    const before = await weddingRow(weddingId);
    const result = await updateWeddingSettings(
      await sessionClient("outsider"),
      weddingId,
      input("Boda cambiada por extraño", "2030-01-01"),
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(await weddingRow(weddingId)).toEqual(before);
  });

  it("another wedding's owner gets not_found", async () => {
    const result = await updateWeddingSettings(
      await sessionClient("ownerB"),
      weddingId,
      input("Boda cambiada por otra boda", "2030-01-01"),
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("anonymous callers are unauthenticated; nothing changes", async () => {
    const before = await weddingRow(weddingId);
    const result = await updateWeddingSettings(
      await sessionClient(null),
      weddingId,
      input("Boda cambiada sin sesión", "2030-01-01"),
    );
    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await weddingRow(weddingId)).toEqual(before);
  });

  it("a malformed wedding id is not_found", async () => {
    const result = await updateWeddingSettings(
      await sessionClient("ownerA"),
      "not-a-uuid",
      input("Boda", "2030-01-01"),
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("wedding date changes and checklist dates", () => {
  type ItemRow = {
    id: string;
    timing_mode: string;
    relative_days: number | null;
    due_date: string | null;
    updated_at: string;
  };

  async function itemRows(weddingId: string): Promise<ItemRow[]> {
    return sql<ItemRow>(
      `select id, timing_mode::text, relative_days, due_date::text, updated_at::text
         from public.checklist_items where wedding_id = $1 order by id`,
      [weddingId],
    );
  }

  async function dueDates(weddingId: string) {
    const supabase = await sessionClient("collabA");
    const access = await requireWeddingMembership(supabase, weddingId);
    if (!access.ok) throw new Error(`no access: ${access.reason}`);
    const [checklist, detail] = await Promise.all([
      getWeddingChecklist(supabase, access.access),
      getWeddingDetail(supabase, weddingId),
    ]);
    if (!checklist || !detail) throw new Error("failed to load");
    return new Map(
      checklist.items.map((item) => [item.title, effectiveDueDate(item.timing, detail.weddingDate)]),
    );
  }

  it("relative dates follow the current wedding date; rows and absolute dates never change", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda que se mueve");
    await addMember(weddingId, "collabA", "collaborator");
    const owner = await sessionClient("ownerA");
    expect(await updateWeddingSettings(owner, weddingId, input("Boda que se mueve", "2027-08-14"))).toEqual({
      ok: true,
    });
    expect((await initializeWeddingChecklist(owner, weddingId)).ok).toBe(true);
    expect(
      await createChecklistItem(await sessionClient("collabA"), weddingId, {
        title: "Pagar el anticipo",
        description: null,
        category: null,
        timing: { mode: "absolute", dueDate: "2027-03-01" },
      }),
    ).toEqual({ ok: true });

    const rowsBefore = await itemRows(weddingId);
    let dates = await dueDates(weddingId);
    expect(dates.get("Definir el presupuesto aproximado")).toBe("2026-08-14"); // −365
    expect(dates.get("Enviar agradecimientos")).toBe("2027-09-13"); // +30
    expect(dates.get("Pagar el anticipo")).toBe("2027-03-01");

    // Date B: across a leap day (2028-02-29 lies inside the year before).
    expect(await updateWeddingSettings(owner, weddingId, input("Boda que se mueve", "2028-06-10"))).toEqual({
      ok: true,
    });
    dates = await dueDates(weddingId);
    expect(dates.get("Definir el presupuesto aproximado")).toBe("2027-06-11");
    expect(dates.get("Enviar agradecimientos")).toBe("2028-07-10");
    expect(dates.get("Pagar el anticipo")).toBe("2027-03-01");
    expect(await itemRows(weddingId)).toEqual(rowsBefore);

    // No date: relative items keep their rule but have no calendar date.
    expect(await updateWeddingSettings(owner, weddingId, input("Boda que se mueve", ""))).toEqual({
      ok: true,
    });
    dates = await dueDates(weddingId);
    expect(dates.get("Definir el presupuesto aproximado")).toBeNull();
    expect(dates.get("Pagar el anticipo")).toBe("2027-03-01");
    expect(await itemRows(weddingId)).toEqual(rowsBefore);
    const relative = rowsBefore.filter((row) => row.timing_mode === "relative_to_wedding");
    expect(relative.length).toBeGreaterThan(30);
    expect(relative.every((row) => row.relative_days !== null && row.due_date === null)).toBe(true);
  });
});
