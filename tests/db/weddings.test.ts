import { beforeAll, describe, expect, it } from "vitest";

import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding,
  membershipRole,
  sql,
  users,
  weddingExists,
} from "./support";

describe("wedding creation boundary (create_wedding)", () => {
  it("creates the wedding and the caller's owner membership atomically", async () => {
    const { data, error } = await as.ownerA.rpc("create_wedding", {
      wedding_name: "  Boda en el jardín  ",
      wedding_date: "2027-06-12",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({
      name: "Boda en el jardín",
      wedding_date: "2027-06-12",
      created_by: users.ownerA.id,
    });

    const weddingId = data?.id ?? "";
    const memberships = await sql<{ user_id: string; role: string }>(
      "select user_id, role from public.wedding_memberships where wedding_id = $1",
      [weddingId],
    );
    expect(memberships).toEqual([{ user_id: users.ownerA.id, role: "owner" }]);

    const created = await sql<{ created_by: string }>(
      "select created_by from public.weddings where id = $1",
      [weddingId],
    );
    expect(created).toEqual([{ created_by: users.ownerA.id }]);
  });

  it("allows creating a wedding without a date", async () => {
    const { data, error } = await as.ownerA.rpc("create_wedding", {
      wedding_name: "Boda sin fecha",
    });
    expect(error).toBeNull();
    expect(data?.wedding_date).toBeNull();
  });

  it("rolls back entirely on failure (blank name): no wedding, no membership", async () => {
    const counts = () =>
      sql<{ weddings: number; memberships: number }>(
        `select (select count(*)::int from public.weddings where created_by = $1) as weddings,
                (select count(*)::int from public.wedding_memberships where user_id = $1) as memberships`,
        [users.outsider.id],
      );
    const before = await counts();
    for (const blank of ["", "   ", "\t\n"]) {
      const { error } = await as.outsider.rpc("create_wedding", { wedding_name: blank });
      expect(error?.code).toBe("23514");
    }
    expect(await counts()).toEqual(before);
  });

  it("rejects anonymous callers", async () => {
    const { data, error } = await as.anon.rpc("create_wedding", { wedding_name: "Anónima" });
    expect(data).toBeNull();
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("denies direct inserts into weddings", async () => {
    const { error } = await as.ownerA
      .from("weddings")
      .insert({ name: "Insertada a mano", created_by: users.ownerA.id });
    expect(error?.code).toBe(PERMISSION_DENIED);

    const { error: anonError } = await as.anon.from("weddings").insert({ name: "Anónima" });
    expect(anonError?.code).toBe(PERMISSION_DENIED);

    const rows = await sql("select 1 from public.weddings where name in ($1, $2)", [
      "Insertada a mano",
      "Anónima",
    ]);
    expect(rows).toHaveLength(0);
  });

  it("denies direct inserts into wedding_memberships", async () => {
    const weddingB = await createWedding("ownerB");
    for (const actor of ["ownerA", "outsider", "anon"] as const) {
      const { error } = await as[actor].from("wedding_memberships").insert({
        wedding_id: weddingB,
        user_id: actor === "anon" ? users.outsider.id : users[actor].id,
        role: "owner",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
    // Even an owner can't add members directly; only invites do that.
    const { error } = await as.ownerB.from("wedding_memberships").insert({
      wedding_id: weddingB,
      user_id: users.outsider.id,
      role: "collaborator",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await membershipRole(weddingB, "outsider")).toBeNull();
    expect(await membershipRole(weddingB, "ownerA")).toBeNull();
  });
});

describe("weddings RLS", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await createWedding("ownerA", "Boda A");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await createWedding("ownerB", "Boda B");
  });

  async function visibleWeddingIds(actor: keyof typeof as): Promise<string[]> {
    const { data } = await as[actor].from("weddings").select("id").in("id", [weddingA, weddingB]);
    return (data ?? []).map((w) => w.id).sort();
  }

  it("anon cannot read any wedding", async () => {
    const { data, error } = await as.anon.from("weddings").select("id");
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it("members see only their own weddings", async () => {
    expect(await visibleWeddingIds("ownerA")).toEqual([weddingA]);
    expect(await visibleWeddingIds("collabA")).toEqual([weddingA]);
    expect(await visibleWeddingIds("ownerB")).toEqual([weddingB]);
    expect(await visibleWeddingIds("outsider")).toEqual([]);
  });

  it("owner can update wedding settings", async () => {
    const { error } = await as.ownerA
      .from("weddings")
      .update({ name: "Boda A (actualizada)", wedding_date: "2027-09-04" })
      .eq("id", weddingA);
    expect(error).toBeNull();
    const rows = await sql<{ name: string }>("select name from public.weddings where id = $1", [
      weddingA,
    ]);
    expect(rows[0]?.name).toBe("Boda A (actualizada)");
  });

  it("owner cannot blank the wedding name", async () => {
    const { error } = await as.ownerA.from("weddings").update({ name: "  " }).eq("id", weddingA);
    expect(error?.code).toBe("23514");
  });

  it("owner cannot rewrite provenance or ids", async () => {
    const { error } = await as.ownerA
      .from("weddings")
      .update({ created_by: users.outsider.id })
      .eq("id", weddingA);
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("collaborator cannot update wedding settings", async () => {
    const { data, error } = await as.collabA
      .from("weddings")
      .update({ name: "Cambiada por colaborador" })
      .eq("id", weddingA)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const rows = await sql<{ name: string }>("select name from public.weddings where id = $1", [
      weddingA,
    ]);
    expect(rows[0]?.name).not.toBe("Cambiada por colaborador");
  });

  it("cross-wedding: owner A cannot update or delete wedding B", async () => {
    const { data } = await as.ownerA
      .from("weddings")
      .update({ name: "Hackeada" })
      .eq("id", weddingB)
      .select("id");
    expect(data).toEqual([]);

    const { data: deleted } = await as.ownerA
      .from("weddings")
      .delete()
      .eq("id", weddingB)
      .select("id");
    expect(deleted).toEqual([]);

    const rows = await sql<{ name: string }>("select name from public.weddings where id = $1", [
      weddingB,
    ]);
    expect(rows).toEqual([{ name: "Boda B" }]);
  });

  it("outsider and anon cannot update or delete any wedding", async () => {
    for (const actor of ["outsider", "anon"] as const) {
      await as[actor].from("weddings").update({ name: "X" }).eq("id", weddingA);
      await as[actor].from("weddings").delete().eq("id", weddingA);
    }
    expect(await weddingExists(weddingA)).toBe(true);
  });

  it("collaborator cannot delete the wedding", async () => {
    await as.collabA.from("weddings").delete().eq("id", weddingA);
    expect(await weddingExists(weddingA)).toBe(true);
  });

  it("owner can delete the wedding; memberships and invites cascade", async () => {
    const doomed = await createWedding("ownerA", "Boda que se borra");
    await addMember(doomed, "collabA", "collaborator");
    await addMember(doomed, "ownerB", "owner");
    await sql(
      `insert into public.membership_invites (wedding_id, token_hash, expires_at, created_by)
       values ($1, repeat('a', 64), now() + interval '1 day', $2)`,
      [doomed, users.ownerA.id],
    );

    const { error } = await as.ownerA.from("weddings").delete().eq("id", doomed);
    expect(error).toBeNull();

    expect(await weddingExists(doomed)).toBe(false);
    expect(
      await sql("select 1 from public.wedding_memberships where wedding_id = $1", [doomed]),
    ).toHaveLength(0);
    expect(
      await sql("select 1 from public.membership_invites where wedding_id = $1", [doomed]),
    ).toHaveLength(0);
  });
});
