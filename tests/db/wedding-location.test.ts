import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  ctx,
  sql,
  users,
} from "./support";

vi.mock("server-only", () => ({}));
const { createWedding, getWeddingDetail, updateWeddingSettings } = await import(
  "@/lib/weddings/service"
);
const { parseWeddingInput } = await import("@/lib/weddings/validation");

// LB-08: optional wedding city and explicit IANA time zone, against the real
// local stack. Clients act as real users through the Data API (RPC and
// direct table writes); the superuser connection only arranges fixtures and
// reads ground truth.

const CHECK_VIOLATION = "23514";
const INVALID_PARAMETER_VALUE = "22023";

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

type Location = { city: string | null; time_zone: string | null };

async function location(weddingId: string): Promise<Location | undefined> {
  const rows = await sql<Location>("select city, time_zone from public.weddings where id = $1", [
    weddingId,
  ]);
  return rows[0];
}

/** Weddings with this exact name, and their memberships (for atomicity checks). */
async function weddingsNamed(name: string) {
  const weddings = await sql<{ id: string }>("select id from public.weddings where name = $1", [
    name,
  ]);
  const memberships = await sql(
    `select 1 from public.wedding_memberships m join public.weddings w on w.id = m.wedding_id
     where w.name = $1`,
    [name],
  );
  return { weddings: weddings.length, memberships: memberships.length };
}

function rpcCreate(
  actor: keyof typeof as,
  args: Database["public"]["Functions"]["create_wedding"]["Args"],
) {
  return as[actor].rpc("create_wedding", args);
}

// ------------------------------------------------------------ schema

describe("wedding city and time zone schema", () => {
  it("both columns are nullable text", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'weddings'
         and column_name in ('city', 'time_zone') order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "city", data_type: "text", is_nullable: "YES" },
      { column_name: "time_zone", data_type: "text", is_nullable: "YES" },
    ]);
  });

  it("a wedding created without them has NULL city and time zone (nothing is inferred)", async () => {
    const id = await fixtureWedding("ownerA", "Boda sin ciudad ni zona");
    expect(await location(id)).toEqual({ city: null, time_zone: null });
  });
});

// ---------------------------------------------------- create_wedding

describe("create_wedding with city and time zone", () => {
  it("creates the wedding with city and zone, and the caller as owner", async () => {
    const { data, error } = await rpcCreate("ownerA", {
      wedding_name: "Boda en San José",
      wedding_date: "2027-08-14",
      wedding_city: "San José",
      wedding_time_zone: "America/Costa_Rica",
    });
    expect(error).toBeNull();
    if (!data) throw new Error("no wedding");
    createdWeddings.push(data.id);
    expect(data.city).toBe("San José");
    expect(data.time_zone).toBe("America/Costa_Rica");
    const roles = await sql<{ role: string }>(
      "select role from public.wedding_memberships where wedding_id = $1 and user_id = $2",
      [data.id, users.ownerA.id],
    );
    expect(roles).toEqual([{ role: "owner" }]);
  });

  it("trims the city and stores blank city and zone as NULL", async () => {
    const { data, error } = await rpcCreate("ownerA", {
      wedding_name: "Boda con espacios",
      wedding_city: "   Ciudad de México  ",
      wedding_time_zone: "",
    });
    expect(error).toBeNull();
    if (!data) throw new Error("no wedding");
    createdWeddings.push(data.id);
    expect(await location(data.id)).toEqual({ city: "Ciudad de México", time_zone: null });

    const blank = await rpcCreate("ownerA", { wedding_name: "Boda ciudad en blanco", wedding_city: " \t " });
    expect(blank.error).toBeNull();
    if (!blank.data) throw new Error("no wedding");
    createdWeddings.push(blank.data.id);
    expect(await location(blank.data.id)).toEqual({ city: null, time_zone: null });
  });

  it("keeps Unicode city names exactly as typed (no lowercasing)", async () => {
    for (const city of ["Bogotá", "São Paulo", "Ñuñoa", "ZÜRICH"]) {
      const { data, error } = await rpcCreate("ownerA", { wedding_name: `Boda en ${city}`, wedding_city: city });
      expect(error, city).toBeNull();
      if (!data) throw new Error("no wedding");
      createdWeddings.push(data.id);
      expect((await location(data.id))?.city).toBe(city);
    }
  });

  it.each([
    ["an over-long city", { wedding_city: "x".repeat(121) }, CHECK_VIOLATION],
    ["a city with control characters", { wedding_city: "San\u0007José" }, CHECK_VIOLATION],
    ["an invalid time zone", { wedding_time_zone: "Mars/Olympus" }, INVALID_PARAMETER_VALUE],
    ["an offset as time zone", { wedding_time_zone: "-06:00" }, INVALID_PARAMETER_VALUE],
  ] as const)("rolls back entirely on %s: no wedding, no owner membership", async (label, extra, code) => {
    const name = `Boda que no debe existir: ${label}`;
    const { data, error } = await rpcCreate("ownerA", { wedding_name: name, ...extra });
    expect(data).toBeNull();
    expect(error?.code).toBe(code);
    expect(await weddingsNamed(name)).toEqual({ weddings: 0, memberships: 0 });
  });

  it("accepts exactly 120 characters of city", async () => {
    const { data, error } = await rpcCreate("ownerA", {
      wedding_name: "Boda ciudad larga",
      wedding_city: "á".repeat(120),
    });
    expect(error).toBeNull();
    if (!data) throw new Error("no wedding");
    createdWeddings.push(data.id);
  });

  it("anonymous callers cannot create weddings", async () => {
    const { error } = await rpcCreate("anon", {
      wedding_name: "Boda anónima",
      wedding_time_zone: "America/Lima",
    });
    expect(error).not.toBeNull();
  });

  it("the service creates a wedding with city and zone; invalid zones fail safely", async () => {
    const supabase = await sessionClient("ownerA");
    const result = await createWedding(supabase, {
      name: "Boda del servicio en Lima",
      weddingDate: "2027-05-01",
      city: "Lima",
      timeZone: "America/Lima",
    });
    if (!result.ok) throw new Error(result.reason);
    createdWeddings.push(result.weddingId);
    expect(await location(result.weddingId)).toEqual({ city: "Lima", time_zone: "America/Lima" });

    const name = "Boda del servicio con zona inválida";
    expect(
      await createWedding(supabase, { name, weddingDate: null, city: null, timeZone: "Mars/Olympus" }),
    ).toEqual({ ok: false, reason: "invalid_time_zone" });
    expect(
      await createWedding(supabase, { name, weddingDate: null, city: "x".repeat(121), timeZone: null }),
    ).toEqual({ ok: false, reason: "invalid_city" });
    expect(await weddingsNamed(name)).toEqual({ weddings: 0, memberships: 0 });
  });
});

// ------------------------------------------------------ time-zone validation

describe("time-zone validation in the database", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda con zona horaria");
  });

  function setZone(zone: string | null) {
    return as.ownerA.from("weddings").update({ time_zone: zone }).eq("id", weddingId).select("time_zone");
  }

  it.each(["America/Costa_Rica", "America/Lima", "America/New_York", "Europe/Madrid", "Asia/Tokyo"])(
    "accepts %s",
    async (zone) => {
      const { data, error } = await setZone(zone);
      expect(error).toBeNull();
      expect(data).toEqual([{ time_zone: zone }]);
    },
  );

  it("accepts UTC, which Postgres knows as a zone", async () => {
    const { error } = await setZone("UTC");
    expect(error).toBeNull();
  });

  it.each([
    "Mars/Olympus",
    "America/Not_A_Real_Place",
    "garbage",
    "GMT-Definitely-Fake",
    "-06:00",
    "GMT-6",
    "america/lima",
    " America/Lima",
    "posix/America/Lima",
    "",
  ])("rejects %j through a direct write; the stored zone is unchanged", async (zone) => {
    await setZone("Europe/Madrid");
    const { data, error } = await setZone(zone);
    expect(data).toBeNull();
    expect(error?.code).toBe(INVALID_PARAMETER_VALUE);
    expect(error?.message).toBe("invalid_time_zone");
    expect((await location(weddingId))?.time_zone).toBe("Europe/Madrid");
  });

  it("clearing the zone (NULL) is allowed", async () => {
    const { error } = await setZone(null);
    expect(error).toBeNull();
    expect((await location(weddingId))?.time_zone).toBeNull();
  });

  it("even a superuser write cannot store an invalid zone (trigger, not just grants)", async () => {
    await expect(
      sql("update public.weddings set time_zone = 'Mars/Olympus' where id = $1", [weddingId]),
    ).rejects.toThrow(/invalid_time_zone/);
  });
});

// ------------------------------------------------------ city validation

describe("city validation in the database", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda con ciudad");
  });

  function setCity(city: string | null) {
    return as.ownerA.from("weddings").update({ city }).eq("id", weddingId).select("city");
  }

  it("the owner sets and clears the city", async () => {
    expect((await setCity("Madrid")).data).toEqual([{ city: "Madrid" }]);
    expect((await setCity(null)).data).toEqual([{ city: null }]);
  });

  it.each(["", "   ", " Madrid", "Madrid ", "x".repeat(121), "Ma\ndrid", "Ma\u001fdrid", "Ma\u0085drid"])(
    "rejects an unnormalized or invalid city %j",
    async (city) => {
      await setCity("Lima");
      const { error } = await setCity(city);
      expect(error?.code).toBe(CHECK_VIOLATION);
      expect((await location(weddingId))?.city).toBe("Lima");
    },
  );
});

// ------------------------------------------------------ authorization

describe("who may change city and time zone", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda con permisos de ubicación");
    await addMember(weddingId, "collabA", "collaborator");
    await sql("update public.weddings set city = 'Lima', time_zone = 'America/Lima' where id = $1", [
      weddingId,
    ]);
  });

  const unchanged = async () =>
    expect(await location(weddingId)).toEqual({ city: "Lima", time_zone: "America/Lima" });

  it("a collaborator cannot (RLS filters the row); nothing changes", async () => {
    const { data, error } = await as.collabA
      .from("weddings")
      .update({ city: "Cusco", time_zone: "Europe/Madrid" })
      .eq("id", weddingId)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await unchanged();
  });

  it("an outsider and another wedding's owner cannot; nothing changes", async () => {
    for (const actor of ["outsider", "ownerB"] as const) {
      const { data } = await as[actor]
        .from("weddings")
        .update({ city: "Cusco" })
        .eq("id", weddingId)
        .select("id");
      expect(data ?? []).toEqual([]);
    }
    await unchanged();
  });

  it("anonymous callers have no privilege at all", async () => {
    const { error } = await as.anon.from("weddings").update({ city: "Cusco" }).eq("id", weddingId);
    expect(error?.code).toBe(PERMISSION_DENIED);
    await unchanged();
  });

  it("owners still cannot rewrite provenance or ids", async () => {
    const { error } = await as.ownerA
      .from("weddings")
      .update({ created_by: users.ownerB.id })
      .eq("id", weddingId);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });
});

// ------------------------------------------------------ settings service

describe("updateWeddingSettings with city and time zone", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda de ajustes de ubicación");
    await addMember(weddingId, "collabA", "collaborator");
  });

  function input(city: string, timeZone: string) {
    const parsed = parseWeddingInput({
      name: "Boda de ajustes de ubicación",
      weddingDate: "2027-08-14",
      city,
      timeZone,
    });
    if (!parsed.ok) throw new Error("fixture input should be valid");
    return parsed.input;
  }

  it("the owner sets, changes and clears city and zone", async () => {
    const supabase = await sessionClient("ownerA");
    expect(await updateWeddingSettings(supabase, weddingId, input("  San José ", "America/Costa_Rica"))).toEqual({
      ok: true,
    });
    expect(await location(weddingId)).toEqual({ city: "San José", time_zone: "America/Costa_Rica" });
    const detail = await getWeddingDetail(supabase, weddingId);
    expect(detail).toMatchObject({ city: "San José", timeZone: "America/Costa_Rica" });

    expect(await updateWeddingSettings(supabase, weddingId, input("Madrid", "Europe/Madrid"))).toEqual({
      ok: true,
    });
    expect(await location(weddingId)).toEqual({ city: "Madrid", time_zone: "Europe/Madrid" });

    expect(await updateWeddingSettings(supabase, weddingId, input("", ""))).toEqual({ ok: true });
    expect(await location(weddingId)).toEqual({ city: null, time_zone: null });
  });

  it("the database rejects what validation would have (bypassing it): invalid_city / invalid_time_zone", async () => {
    const supabase = await sessionClient("ownerA");
    const base = { name: "Boda de ajustes de ubicación", weddingDate: null };
    expect(
      await updateWeddingSettings(supabase, weddingId, { ...base, city: "a\u0007b", timeZone: null }),
    ).toEqual({ ok: false, reason: "invalid_city" });
    expect(
      await updateWeddingSettings(supabase, weddingId, { ...base, city: null, timeZone: "Mars/Olympus" }),
    ).toEqual({ ok: false, reason: "invalid_time_zone" });
    expect(await location(weddingId)).toEqual({ city: null, time_zone: null });
  });

  it("collaborator: forbidden; outsider: not_found; anonymous: unauthenticated", async () => {
    expect(
      await updateWeddingSettings(await sessionClient("collabA"), weddingId, input("Cusco", "America/Lima")),
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(
      await updateWeddingSettings(await sessionClient("outsider"), weddingId, input("Cusco", "America/Lima")),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await updateWeddingSettings(await sessionClient(null), weddingId, input("Cusco", "America/Lima")),
    ).toEqual({ ok: false, reason: "unauthenticated" });
    expect(await location(weddingId)).toEqual({ city: null, time_zone: null });
  });
});
