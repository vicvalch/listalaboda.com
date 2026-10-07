import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  sql,
  users,
} from "./support";

// LB-07: checklist assignment and wedding-scoped display names, exercised as
// real anon/authenticated users through the Data API. The superuser
// connection only arranges fixtures and reads ground truth.

/** foreign_key_violation: the assignee isn't a membership of the item's wedding. */
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

async function membershipId(weddingId: string, user: TestUserKey): Promise<string> {
  const rows = await sql<{ id: string }>(
    "select id from public.wedding_memberships where wedding_id = $1 and user_id = $2",
    [weddingId, users[user].id],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no membership for ${user}`);
  return id;
}

async function addItem(weddingId: string, title: string): Promise<string> {
  const { data, error } = await as.ownerA
    .from("checklist_items")
    .insert({
      wedding_id: weddingId,
      title,
      category: "vendors",
      timing_mode: "relative_to_wedding",
      relative_days: -90,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert failed: ${error?.message}`);
  return data.id;
}

function assign(actor: keyof typeof as, weddingId: string, itemId: string, assignee: string | null) {
  return as[actor]
    .from("checklist_items")
    .update({ assignee_membership_id: assignee })
    .eq("id", itemId)
    .eq("wedding_id", weddingId)
    .select("id, assignee_membership_id");
}

type ItemState = {
  assignee_membership_id: string | null;
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
  timing_mode: string;
  relative_days: number | null;
  due_date: string | null;
  sort_order: number;
  title: string;
  wedding_id: string;
};

async function itemState(itemId: string): Promise<ItemState | undefined> {
  const rows = await sql<ItemState>(
    `select assignee_membership_id, status, completed_at, completed_by, timing_mode,
            relative_days, due_date::text, sort_order, title, wedding_id
     from public.checklist_items where id = $1`,
    [itemId],
  );
  return rows[0];
}

async function displayName(weddingId: string, user: TestUserKey): Promise<string | null> {
  const rows = await sql<{ display_name: string | null }>(
    "select display_name from public.wedding_memberships where wedding_id = $1 and user_id = $2",
    [weddingId, users[user].id],
  );
  return rows[0]?.display_name ?? null;
}

function setName(actor: keyof typeof as, weddingId: string, name: string) {
  return as[actor].rpc("set_wedding_display_name", {
    target_wedding_id: weddingId,
    new_display_name: name,
  });
}

// ------------------------------------------------------------ schema

describe("assignment schema", () => {
  it("adds a nullable assignee and a nullable display name", async () => {
    const rows = await sql<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'checklist_items' and column_name = 'assignee_membership_id')
           or (table_name = 'wedding_memberships' and column_name = 'display_name'))
       order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: "checklist_items", column_name: "assignee_membership_id", is_nullable: "YES" },
      { table_name: "wedding_memberships", column_name: "display_name", is_nullable: "YES" },
    ]);
  });

  it("there is exactly one assignee column and no assignment side table", async () => {
    // LB-19's seating_assignments (guest → table, ADR-012) is a different
    // domain; no checklist assignment side table exists.
    const tables = await sql<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name ilike '%assign%'`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(["seating_assignments"]);
  });

  it("authenticated may UPDATE only role on memberships (display names go through the RPC)", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_schema = 'public' and table_name = 'wedding_memberships'
       order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["role"]);
  });

  it("checklist item UPDATE grants: content, status, assignee and (LB-16) guest party only", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where grantee = 'authenticated' and privilege_type = 'UPDATE'
         and table_schema = 'public' and table_name = 'checklist_items'
       order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "assignee_membership_id",
      "category",
      "description",
      "due_date",
      // LB-16 (ADR-009): the same-wedding guest party link.
      "guest_invitation_id",
      "relative_days",
      "status",
      "timing_mode",
      "title",
    ]);
  });

  it("new items and template copies start unassigned", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda recién sembrada");
    const { error } = await as.ownerA.rpc("initialize_wedding_checklist", {
      target_wedding_id: weddingId,
    });
    expect(error).toBeNull();
    const custom = await addItem(weddingId, "Pendiente propio");

    const rows = await sql<{ assigned: number; total: number }>(
      `select count(assignee_membership_id)::int as assigned, count(*)::int as total
       from public.checklist_items where wedding_id = $1`,
      [weddingId],
    );
    expect(rows[0]).toEqual({ assigned: 0, total: 39 });
    expect((await itemState(custom))?.assignee_membership_id).toBeNull();
  });
});

// -------------------------------------------------------- assignment

describe("checklist assignment", () => {
  let weddingA: string;
  let weddingB: string;
  let ownerA: string;
  let collabA: string;
  let ownerB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda con responsables");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await fixtureWedding("ownerB", "Otra boda con responsables");
    ownerA = await membershipId(weddingA, "ownerA");
    collabA = await membershipId(weddingA, "collabA");
    ownerB = await membershipId(weddingB, "ownerB");
  });

  it("owner assigns to self and to a collaborator", async () => {
    const itemId = await addItem(weddingA, "Elegir el pastel");

    const self = await assign("ownerA", weddingA, itemId, ownerA);
    expect(self.error).toBeNull();
    expect(self.data).toEqual([{ id: itemId, assignee_membership_id: ownerA }]);

    const other = await assign("ownerA", weddingA, itemId, collabA);
    expect(other.error).toBeNull();
    expect((await itemState(itemId))?.assignee_membership_id).toBe(collabA);
  });

  it("collaborator assigns to self, reassigns to the owner, and unassigns", async () => {
    const itemId = await addItem(weddingA, "Probar el menú");

    expect((await assign("collabA", weddingA, itemId, collabA)).error).toBeNull();
    expect((await itemState(itemId))?.assignee_membership_id).toBe(collabA);

    expect((await assign("collabA", weddingA, itemId, ownerA)).error).toBeNull();
    expect((await itemState(itemId))?.assignee_membership_id).toBe(ownerA);

    expect((await assign("collabA", weddingA, itemId, null)).error).toBeNull();
    expect((await itemState(itemId))?.assignee_membership_id).toBeNull();
  });

  it("CRITICAL: a membership of another wedding is rejected by the database, item unchanged", async () => {
    const itemId = await addItem(weddingA, "Contratar la música");
    await assign("ownerA", weddingA, itemId, collabA);

    // Direct PostgREST update as a legitimate member of wedding A, pointing
    // at wedding B's owner membership.
    const forged = await assign("ownerA", weddingA, itemId, ownerB);
    expect(forged.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(forged.data).toBeNull();
    expect((await itemState(itemId))?.assignee_membership_id).toBe(collabA);

    // The same from the other side: B's owner can't reach A's item at all.
    const reversed = await assign("ownerB", weddingA, itemId, ownerB);
    expect(reversed.data).toEqual([]);
    expect((await itemState(itemId))?.assignee_membership_id).toBe(collabA);
  });

  it("a nonexistent membership gets the same rejection as a foreign one", async () => {
    const itemId = await addItem(weddingA, "Reservar el hotel");
    const result = await assign("ownerA", weddingA, itemId, crypto.randomUUID());
    expect(result.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect((await itemState(itemId))?.assignee_membership_id).toBeNull();
  });

  it("the invariant holds below the API too (superuser insert/update)", async () => {
    const itemId = await addItem(weddingA, "Pedir presupuestos");
    await expect(
      sql("update public.checklist_items set assignee_membership_id = $1 where id = $2", [ownerB, itemId]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    await expect(
      sql(
        `insert into public.checklist_items (wedding_id, title, assignee_membership_id)
         values ($1, 'Forjado', $2)`,
        [weddingA, ownerB],
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it("a pending invite can't be assigned work (it is not a membership)", async () => {
    const itemId = await addItem(weddingA, "Enviar las invitaciones");
    const { data: invite, error } = await as.ownerA
      .from("membership_invites")
      .insert({
        wedding_id: weddingA,
        intended_role: "collaborator",
        token_hash: createHash("sha256").update(crypto.randomUUID()).digest("hex"),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const result = await assign("ownerA", weddingA, itemId, invite!.id);
    expect(result.error?.code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("outsiders and anonymous users can't assign", async () => {
    const itemId = await addItem(weddingA, "Comprar los anillos");

    const outsider = await assign("outsider", weddingA, itemId, ownerA);
    expect(outsider.data).toEqual([]);
    const anon = await assign("anon", weddingA, itemId, ownerA);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);

    expect((await itemState(itemId))?.assignee_membership_id).toBeNull();
  });

  it("assignment changes only the assignee: status, completion, timing and order stay", async () => {
    const itemId = await addItem(weddingA, "Elegir las flores");
    await as.ownerA.from("checklist_items").update({ status: "done" }).eq("id", itemId);
    const before = await itemState(itemId);
    expect(before?.status).toBe("done");

    for (const target of [ownerA, collabA, null]) {
      expect((await assign("collabA", weddingA, itemId, target)).error).toBeNull();
      const after = await itemState(itemId);
      expect(after).toEqual({ ...before, assignee_membership_id: target });
    }
  });

  it("status changes keep the assignment (done, not_applicable, reopen)", async () => {
    const itemId = await addItem(weddingA, "Confirmar el fotógrafo");
    await assign("ownerA", weddingA, itemId, collabA);

    for (const status of ["done", "pending", "not_applicable", "pending"] as const) {
      const { error } = await as.collabA.from("checklist_items").update({ status }).eq("id", itemId);
      expect(error).toBeNull();
      expect(await itemState(itemId)).toMatchObject({ status, assignee_membership_id: collabA });
    }
  });

  it("removing the assigned member unassigns their items; the items stay", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda donde alguien se va");
    await addMember(weddingId, "invitee", "collaborator");
    const leaving = await membershipId(weddingId, "invitee");
    const itemId = await addItem(weddingId, "Organizar la despedida");
    expect((await assign("ownerA", weddingId, itemId, leaving)).error).toBeNull();
    const before = await itemState(itemId);

    // The legitimate path: an owner removes the member (RLS: owner only).
    const { data, error } = await as.ownerA
      .from("wedding_memberships")
      .delete()
      .eq("id", leaving)
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: leaving }]);

    expect(await itemState(itemId)).toEqual({ ...before, assignee_membership_id: null });
  });

  it("the final-owner rule still holds for an assigned owner", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda con dueña asignada");
    const owner = await membershipId(weddingId, "ownerA");
    const itemId = await addItem(weddingId, "Pagar el salón");
    await assign("ownerA", weddingId, itemId, owner);

    const { error } = await as.ownerA.from("wedding_memberships").delete().eq("id", owner);
    expect(error?.code).toBe(CHECK_VIOLATION);
    expect((await itemState(itemId))?.assignee_membership_id).toBe(owner);
  });

  it("deleting the item or the wedding needs no assignment cleanup", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda que se borra");
    const owner = await membershipId(weddingId, "ownerA");
    const itemId = await addItem(weddingId, "Pendiente asignado");
    await assign("ownerA", weddingId, itemId, owner);

    const { error } = await as.ownerA.from("weddings").delete().eq("id", weddingId);
    expect(error).toBeNull();
    expect(await itemState(itemId)).toBeUndefined();
  });
});

// ------------------------------------------------------- display names

describe("wedding display names", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda con nombres");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await fixtureWedding("ownerB", "Otra boda con nombres");
  });

  it("existing memberships start without a name", async () => {
    expect(await displayName(weddingA, "ownerA")).toBeNull();
    expect(await displayName(weddingA, "collabA")).toBeNull();
  });

  it.each(["ownerA", "collabA"] as const)("%s sets their own name, trimmed", async (actor) => {
    const { data, error } = await setName(actor, weddingA, `  Nombre de ${actor}  `);
    expect(error).toBeNull();
    expect(data).toBe(`Nombre de ${actor}`);
    expect(await displayName(weddingA, actor)).toBe(`Nombre de ${actor}`);
  });

  it("members see each other's names (and nothing about the auth user)", async () => {
    const { data } = await as.collabA
      .from("wedding_memberships")
      .select("id, role, display_name")
      .eq("wedding_id", weddingA)
      .order("role");
    expect(data?.map((m) => m.display_name).sort()).toEqual([
      "Nombre de collabA",
      "Nombre de ownerA",
    ]);
  });

  it("blank or whitespace clears the name", async () => {
    await setName("collabA", weddingA, "Sofía");
    const { data, error } = await setName("collabA", weddingA, " \t ");
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(await displayName(weddingA, "collabA")).toBeNull();
  });

  it("over-long names and control characters are rejected, keeping the old name", async () => {
    await setName("collabA", weddingA, "Sofía");
    expect((await setName("collabA", weddingA, "x".repeat(81))).error?.code).toBe(CHECK_VIOLATION);
    expect((await setName("collabA", weddingA, "Sofía\u0000x")).error).not.toBeNull();
    expect((await setName("collabA", weddingA, "So\u0007fía")).error?.code).toBe(CHECK_VIOLATION);
    expect(await displayName(weddingA, "collabA")).toBe("Sofía");
    expect((await setName("collabA", weddingA, "y".repeat(80))).error).toBeNull();
  });

  it("an owner can't rename another member (no API path changes someone else's name)", async () => {
    await setName("collabA", weddingA, "Sofía");

    // Direct table update: display_name isn't an updatable column.
    const direct = await as.ownerA
      .from("wedding_memberships")
      .update({ display_name: "Renombrada" })
      .eq("wedding_id", weddingA)
      .eq("user_id", users.collabA.id)
      .select("id");
    expect(direct.error?.code).toBe(PERMISSION_DENIED);

    // The RPC only ever touches the caller's own membership.
    expect((await setName("ownerA", weddingA, "Renombrada")).error).toBeNull();
    expect(await displayName(weddingA, "collabA")).toBe("Sofía");
    expect(await displayName(weddingA, "ownerA")).toBe("Renombrada");
  });

  it("a collaborator can't rename anyone else or change roles", async () => {
    const direct = await as.collabA
      .from("wedding_memberships")
      .update({ display_name: "Otro nombre" })
      .eq("wedding_id", weddingA)
      .select("id");
    expect(direct.error?.code).toBe(PERMISSION_DENIED);

    // Role management is unchanged: still owner-only, also for one's own row.
    const promote = await as.collabA
      .from("wedding_memberships")
      .update({ role: "owner" })
      .eq("wedding_id", weddingA)
      .eq("user_id", users.collabA.id)
      .select("id");
    expect(promote.data).toEqual([]);
    const rows = await sql<{ role: string }>(
      "select role from public.wedding_memberships where wedding_id = $1 and user_id = $2",
      [weddingA, users.collabA.id],
    );
    expect(rows[0]?.role).toBe("collaborator");
  });

  it("outsiders get the same answer as a nonexistent wedding; anon is refused", async () => {
    const outsider = await setName("outsider", weddingA, "Intrusa");
    expect(outsider.error?.message).toBe("wedding_not_found");
    const missing = await setName("outsider", crypto.randomUUID(), "Intrusa");
    expect(missing.error?.message).toBe("wedding_not_found");

    const anon = await setName("anon", weddingA, "Anónima");
    expect(anon.error?.code).toBe(PERMISSION_DENIED);

    const names = await sql<{ display_name: string | null }>(
      "select display_name from public.wedding_memberships where wedding_id = $1",
      [weddingA],
    );
    expect(names.map((n) => n.display_name)).not.toContain("Intrusa");
    expect(names.map((n) => n.display_name)).not.toContain("Anónima");
  });

  it("a name is per wedding: setting it in one wedding leaves the others alone", async () => {
    await addMember(weddingB, "collabA", "collaborator");
    await setName("collabA", weddingA, "Sofía");
    await setName("collabA", weddingB, "Sofi");
    expect(await displayName(weddingA, "collabA")).toBe("Sofía");
    expect(await displayName(weddingB, "collabA")).toBe("Sofi");
  });

  it("the database refuses unnormalized names even when written directly", async () => {
    for (const value of ["", "   ", " Ana", "Ana ", "a".repeat(81)]) {
      await expect(
        sql(
          "update public.wedding_memberships set display_name = $1 where wedding_id = $2 and user_id = $3",
          [value, weddingA, users.collabA.id],
        ),
        JSON.stringify(value),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });
});
