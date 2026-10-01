import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectiveDueDate, timingFromColumns } from "@/lib/checklist/timing";
import type { TablesInsert } from "@/lib/supabase/database.types";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  sql,
  superuser,
  users,
  weddingExists,
} from "./support";

// LB-05 checklist: templates are reference data nobody can touch through the
// API; checklist items are wedding-owned and shared by every member; seeding
// is owner-only, atomic and at most once. Everything is exercised as real
// anon/authenticated users; the superuser connection only arranges fixtures
// and reads ground truth.

const TEMPLATE_KEY = "default-wedding-es";
const TEMPLATE_ITEM_COUNT = 38;
const CHECK_VIOLATION = "23514";

const createdWeddings: string[] = [];

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function initialize(actor: keyof typeof as, weddingId: string) {
  return as[actor].rpc("initialize_wedding_checklist", { target_wedding_id: weddingId });
}

async function initializedWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await fixtureWedding(owner, name);
  const { error } = await initialize(owner, id);
  if (error) throw new Error(`initialize failed: ${error.message}`);
  return id;
}

async function itemCount(weddingId: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    "select count(*)::int as n from public.checklist_items where wedding_id = $1",
    [weddingId],
  );
  return rows[0]?.n ?? 0;
}

async function applicationCount(weddingId: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    "select count(*)::int as n from public.wedding_checklist_template_applications where wedding_id = $1",
    [weddingId],
  );
  return rows[0]?.n ?? 0;
}

/** Inserts a custom item as `actor`, returning the row (or the error). */
async function addItem(actor: keyof typeof as, weddingId: string, title: string) {
  return as[actor]
    .from("checklist_items")
    .insert({ wedding_id: weddingId, title })
    .select("id, wedding_id, status, sort_order, created_by, source_template_item_id")
    .single();
}

type ItemRow = {
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
  title: string;
};

async function itemRow(itemId: string): Promise<ItemRow | undefined> {
  const rows = await sql<ItemRow>(
    "select status, completed_at, completed_by, title from public.checklist_items where id = $1",
    [itemId],
  );
  return rows[0];
}

// ------------------------------------------------------------- templates

describe("checklist templates (reference data)", () => {
  it("ships exactly one active Spanish default template, version 1", async () => {
    const templates = await sql<{ key: string; version: number; locale: string; is_active: boolean }>(
      "select key, version, locale, is_active from public.checklist_templates order by key, version",
    );
    expect(templates).toEqual([{ key: TEMPLATE_KEY, version: 1, locale: "es", is_active: true }]);

    const stats = await sql<{ items: number; keys: number; categories: number; dated: number }>(
      `select count(*)::int as items, count(distinct stable_key)::int as keys,
              count(distinct category)::int as categories,
              count(*) filter (where timing_mode = 'relative_to_wedding')::int as dated
       from public.checklist_template_items ti
       join public.checklist_templates t on t.id = ti.template_id
       where t.key = $1 and t.version = 1`,
      [TEMPLATE_KEY],
    );
    expect(stats[0]).toMatchObject({ items: TEMPLATE_ITEM_COUNT, keys: TEMPLATE_ITEM_COUNT, categories: 9 });
    expect(stats[0]?.dated).toBeGreaterThan(30);
  });

  it("is not readable through the API by anyone (the RPC reads it)", async () => {
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      const templates = await as[actor].from("checklist_templates").select("id");
      expect(templates.error?.code, actor).toBe(PERMISSION_DENIED);
      const items = await as[actor].from("checklist_template_items").select("id");
      expect(items.error?.code, actor).toBe(PERMISSION_DENIED);
    }
  });

  it("cannot be created, changed or deleted by ordinary users", async () => {
    const [template] = await sql<{ id: string }>(
      "select id from public.checklist_templates where key = $1",
      [TEMPLATE_KEY],
    );
    const before = await sql(
      "select title from public.checklist_template_items where template_id = $1 order by sort_order",
      [template.id],
    );

    for (const actor of ["anon", "ownerA", "outsider"] as const) {
      const insert = await as[actor]
        .from("checklist_templates")
        .insert({ key: "hacked", version: 1, locale: "es", name: "X" });
      expect(insert.error?.code, actor).toBe(PERMISSION_DENIED);

      const insertItem = await as[actor].from("checklist_template_items").insert({
        template_id: template.id,
        stable_key: "hacked.item",
        title: "X",
        category: "vendors",
        sort_order: 9999,
      });
      expect(insertItem.error?.code, actor).toBe(PERMISSION_DENIED);

      const update = await as[actor]
        .from("checklist_template_items")
        .update({ title: "Cambiado" })
        .eq("template_id", template.id);
      expect(update.error?.code, actor).toBe(PERMISSION_DENIED);

      const del = await as[actor].from("checklist_templates").delete().eq("id", template.id);
      expect(del.error?.code, actor).toBe(PERMISSION_DENIED);
    }

    expect(await sql("select 1 from public.checklist_templates where key = 'hacked'")).toEqual([]);
    expect(
      await sql(
        "select title from public.checklist_template_items where template_id = $1 order by sort_order",
        [template.id],
      ),
    ).toEqual(before);
  });
});

// -------------------------------------------------------- initialization

describe("initialize_wedding_checklist", () => {
  it("copies the template into the owner's wedding, with provenance", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda con lista");
    const { data, error } = await initialize("ownerA", weddingId);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        template_key: TEMPLATE_KEY,
        template_version: 1,
        item_count: TEMPLATE_ITEM_COUNT,
        already_initialized: false,
      },
    ]);

    // Exactly the template's items, in its order, all pending, as copies.
    const mismatches = await sql(
      `select ti.stable_key from public.checklist_template_items ti
       join public.checklist_templates t on t.id = ti.template_id and t.key = $2 and t.version = 1
       full join (select * from public.checklist_items where wedding_id = $1) ci
         on ci.source_template_item_id = ti.id
        and ci.title = ti.title
        and ci.description is not distinct from ti.description
        and ci.category = ti.category
        and ci.timing_mode = ti.timing_mode
        and ci.relative_days is not distinct from ti.relative_days
        and ci.sort_order = ti.sort_order
       where ci.id is null or ti.id is null`,
      [weddingId, TEMPLATE_KEY],
    );
    expect(mismatches).toEqual([]);

    const items = await sql<{ status: string; completed_at: Date | null; created_by: string }>(
      "select distinct status, completed_at, created_by from public.checklist_items where wedding_id = $1",
      [weddingId],
    );
    expect(items).toEqual([{ status: "pending", completed_at: null, created_by: users.ownerA.id }]);

    const applications = await sql<{ key: string; version: number; applied_by: string }>(
      `select t.key, t.version, a.applied_by
       from public.wedding_checklist_template_applications a
       join public.checklist_templates t on t.id = a.template_id
       where a.wedding_id = $1`,
      [weddingId],
    );
    expect(applications).toEqual([{ key: TEMPLATE_KEY, version: 1, applied_by: users.ownerA.id }]);
  });

  it("is idempotent: a second call changes nothing", async () => {
    const weddingId = await initializedWedding("ownerA", "Boda doble clic");
    const { data, error } = await initialize("ownerA", weddingId);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ already_initialized: true, item_count: 0, template_version: 1 });
    expect(await itemCount(weddingId)).toBe(TEMPLATE_ITEM_COUNT);
    expect(await applicationCount(weddingId)).toBe(1);
  });

  it("never re-seeds a list the couple emptied", async () => {
    const weddingId = await initializedWedding("ownerA", "Boda vaciada");
    const { error } = await as.ownerA.from("checklist_items").delete().eq("wedding_id", weddingId);
    expect(error).toBeNull();
    expect(await itemCount(weddingId)).toBe(0);

    const { data } = await initialize("ownerA", weddingId);
    expect(data?.[0]?.already_initialized).toBe(true);
    expect(await itemCount(weddingId)).toBe(0);
  });

  it("concurrent calls seed exactly once", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda concurrente");
    const results = await Promise.all([1, 2, 3].map(() => initialize("ownerA", weddingId)));
    for (const result of results) expect(result.error).toBeNull();
    const fresh = results.filter((r) => r.data?.[0]?.already_initialized === false);
    expect(fresh).toHaveLength(1);
    expect(await itemCount(weddingId)).toBe(TEMPLATE_ITEM_COUNT);
    expect(await applicationCount(weddingId)).toBe(1);
  });

  it("works for a wedding without a date (relative items wait for it)", async () => {
    const weddingId = await initializedWedding("ownerA", "Boda sin fecha con lista");
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from public.checklist_items
       where wedding_id = $1 and timing_mode = 'relative_to_wedding' and due_date is null`,
      [weddingId],
    );
    expect(rows[0]?.n).toBeGreaterThan(30);
  });

  it("denies a collaborator (owner-only), changing nothing", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda colaborador no inicia");
    await addMember(weddingId, "collabA", "collaborator");
    const { data, error } = await initialize("collabA", weddingId);
    expect(data).toBeNull();
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(error?.message).toBe("checklist_initialize_forbidden");
    expect(await itemCount(weddingId)).toBe(0);
    expect(await applicationCount(weddingId)).toBe(0);
  });

  it("gives an outsider the same answer as a nonexistent wedding", async () => {
    const weddingId = await fixtureWedding("ownerB", "Boda ajena");
    const outsider = await initialize("outsider", weddingId);
    const crossOwner = await initialize("ownerA", weddingId);
    const missing = await initialize("ownerA", "00000000-0000-4000-8000-000000000000");
    for (const result of [outsider, crossOwner, missing]) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("P0002");
      expect(result.error?.message).toBe("wedding_not_found");
    }
    expect(await itemCount(weddingId)).toBe(0);
    expect(await applicationCount(weddingId)).toBe(0);
  });

  it("rejects anonymous callers", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda anónima");
    const { data, error } = await initialize("anon", weddingId);
    expect(data).toBeNull();
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(await itemCount(weddingId)).toBe(0);
  });

  it("is all-or-nothing: a failure mid-copy leaves no record and no items", async () => {
    const weddingId = await fixtureWedding("ownerA", "Boda con fallo");
    // Fixture: make the 20th copied item fail for this wedding only.
    await sql(`
      create function public.lb_test_fail_copy() returns trigger language plpgsql as $$
      begin
        if new.wedding_id = '${weddingId}'::uuid and new.sort_order = 200 then
          raise exception 'simulated failure';
        end if;
        return new;
      end $$`);
    await sql(`create trigger lb_test_fail_copy before insert on public.checklist_items
               for each row execute function public.lb_test_fail_copy()`);
    try {
      const { data, error } = await initialize("ownerA", weddingId);
      expect(data).toBeNull();
      expect(error?.message).toBe("simulated failure");
    } finally {
      await sql("drop trigger lb_test_fail_copy on public.checklist_items");
      await sql("drop function public.lb_test_fail_copy()");
    }
    expect(await itemCount(weddingId)).toBe(0);
    expect(await applicationCount(weddingId)).toBe(0);

    // And it can be retried successfully afterwards.
    const retry = await initialize("ownerA", weddingId);
    expect(retry.error).toBeNull();
    expect(await itemCount(weddingId)).toBe(TEMPLATE_ITEM_COUNT);
  });

  it("application records are readable by members only and not writable by anyone", async () => {
    const weddingId = await initializedWedding("ownerA", "Boda registro");
    await addMember(weddingId, "collabA", "collaborator");

    for (const actor of ["ownerA", "collabA"] as const) {
      const { data } = await as[actor]
        .from("wedding_checklist_template_applications")
        .select("wedding_id")
        .eq("wedding_id", weddingId);
      expect(data, actor).toEqual([{ wedding_id: weddingId }]);
    }
    const { data: hidden } = await as.outsider
      .from("wedding_checklist_template_applications")
      .select("wedding_id")
      .eq("wedding_id", weddingId);
    expect(hidden).toEqual([]);

    const fresh = await fixtureWedding("ownerA", "Boda registro falso");
    const [template] = await sql<{ id: string }>(
      "select id from public.checklist_templates where key = $1",
      [TEMPLATE_KEY],
    );
    const forged = await as.ownerA
      .from("wedding_checklist_template_applications")
      .insert({ wedding_id: fresh, template_id: template.id });
    expect(forged.error?.code).toBe(PERMISSION_DENIED);
    const removed = await as.ownerA
      .from("wedding_checklist_template_applications")
      .delete()
      .eq("wedding_id", weddingId);
    expect(removed.error?.code).toBe(PERMISSION_DENIED);
    expect(await applicationCount(weddingId)).toBe(1);
  });
});

// ------------------------------------------------------------- tenancy

describe("checklist_items RLS", () => {
  let weddingA: string;
  let weddingB: string;

  beforeAll(async () => {
    weddingA = await initializedWedding("ownerA", "Boda A con lista");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await initializedWedding("ownerB", "Boda B con lista");
  });

  async function visibleCount(actor: keyof typeof as, weddingId: string): Promise<number> {
    const { data } = await as[actor].from("checklist_items").select("id").eq("wedding_id", weddingId);
    return data?.length ?? 0;
  }

  async function firstItemId(weddingId: string): Promise<string> {
    const rows = await sql<{ id: string }>(
      "select id from public.checklist_items where wedding_id = $1 order by sort_order limit 1",
      [weddingId],
    );
    return rows[0].id;
  }

  it("members see their wedding's checklist; others see nothing", async () => {
    expect(await visibleCount("ownerA", weddingA)).toBe(TEMPLATE_ITEM_COUNT);
    expect(await visibleCount("collabA", weddingA)).toBe(TEMPLATE_ITEM_COUNT);
    expect(await visibleCount("ownerB", weddingA)).toBe(0);
    expect(await visibleCount("outsider", weddingA)).toBe(0);
    expect(await visibleCount("ownerA", weddingB)).toBe(0);

    // Unfiltered reads are scoped too: nothing from weddings you're not in.
    const { data } = await as.ownerB.from("checklist_items").select("wedding_id");
    expect(new Set((data ?? []).map((row) => row.wedding_id)).has(weddingA)).toBe(false);
  });

  it("anon has no access at all", async () => {
    const { data, error } = await as.anon.from("checklist_items").select("id");
    expect(data).toBeNull();
    expect(error?.code).toBe(PERMISSION_DENIED);
    const insert = await as.anon.from("checklist_items").insert({ wedding_id: weddingA, title: "X" });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
  });

  it.each(["ownerA", "collabA"] as const)("%s can add a custom item at the end", async (actor) => {
    const { data, error } = await addItem(actor, weddingA, `Probar el menú (${actor})`);
    expect(error).toBeNull();
    const max = await sql<{ max: number }>(
      "select max(sort_order)::int as max from public.checklist_items where wedding_id = $1",
      [weddingA],
    );
    expect(data).toMatchObject({
      wedding_id: weddingA,
      status: "pending",
      source_template_item_id: null,
      created_by: users[actor].id,
      sort_order: max[0]?.max,
    });
  });

  it.each(["ownerA", "collabA"] as const)("%s can edit, complete and delete items", async (actor) => {
    const created = await addItem(actor, weddingA, `Pendiente de ${actor}`);
    const itemId = created.data?.id ?? "";

    const edit = await as[actor]
      .from("checklist_items")
      .update({ title: "Renombrado", category: "reception", timing_mode: "absolute", due_date: "2027-03-15" })
      .eq("id", itemId)
      .select("id");
    expect(edit.data).toEqual([{ id: itemId }]);

    const done = await as[actor].from("checklist_items").update({ status: "done" }).eq("id", itemId).select("id");
    expect(done.data).toEqual([{ id: itemId }]);
    expect((await itemRow(itemId))?.status).toBe("done");

    // Template copies are as editable as custom items.
    const templateItem = await firstItemId(weddingA);
    const na = await as[actor]
      .from("checklist_items")
      .update({ status: "not_applicable" })
      .eq("id", templateItem)
      .select("id");
    expect(na.data).toEqual([{ id: templateItem }]);
    await as[actor].from("checklist_items").update({ status: "pending" }).eq("id", templateItem);

    const del = await as[actor].from("checklist_items").delete().eq("id", itemId).select("id");
    expect(del.data).toEqual([{ id: itemId }]);
    expect(await itemRow(itemId)).toBeUndefined();
  });

  it("a member can't insert into another wedding (no forged wedding_id)", async () => {
    for (const [actor, target] of [
      ["ownerA", weddingB],
      ["collabA", weddingB],
      ["outsider", weddingA],
      ["ownerB", weddingA],
    ] as const) {
      const { error } = await addItem(actor, target, "Intruso");
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
    }
    expect(
      await sql("select 1 from public.checklist_items where title = 'Intruso'"),
    ).toEqual([]);
  });

  it("items can't be moved to another wedding or have provenance/stamps forged", async () => {
    const itemId = await firstItemId(weddingA);
    const forged = [
      { wedding_id: weddingB },
      { created_by: users.outsider.id },
      { source_template_item_id: null },
      { completed_at: new Date().toISOString() },
      { completed_by: users.ownerA.id },
      { sort_order: 1 },
    ];
    for (const change of forged) {
      const { error } = await as.ownerA.from("checklist_items").update(change).eq("id", itemId);
      expect(error?.code, JSON.stringify(change)).toBe(PERMISSION_DENIED);
    }
    const base = { wedding_id: weddingA, title: "Con extras" };
    const inserts: TablesInsert<"checklist_items">[] = [
      { ...base, created_by: users.outsider.id },
      { ...base, source_template_item_id: null },
      { ...base, completed_at: new Date().toISOString() },
      { ...base, status: "done" },
      { ...base, sort_order: 1 },
    ];
    for (const insert of inserts) {
      const { error } = await as.ownerA.from("checklist_items").insert(insert);
      expect(error?.code, JSON.stringify(insert)).toBe(PERMISSION_DENIED);
    }
    const rows = await sql<{ wedding_id: string }>(
      "select wedding_id from public.checklist_items where id = $1",
      [itemId],
    );
    expect(rows).toEqual([{ wedding_id: weddingA }]);
  });

  it("cross-wedding and outsider updates/deletes affect nothing", async () => {
    const itemB = await firstItemId(weddingB);
    const before = await itemRow(itemB);
    for (const actor of ["ownerA", "collabA", "outsider"] as const) {
      const update = await as[actor]
        .from("checklist_items")
        .update({ title: "Hackeado", status: "done" })
        .eq("id", itemB)
        .select("id");
      expect(update.data, actor).toEqual([]);
      const del = await as[actor].from("checklist_items").delete().eq("id", itemB).select("id");
      expect(del.data, actor).toEqual([]);
    }
    expect(await itemRow(itemB)).toEqual(before);
  });

  it("created_by does not grant access", async () => {
    const itemB = await firstItemId(weddingB);
    await sql("update public.checklist_items set created_by = $1 where id = $2", [users.outsider.id, itemB]);
    const { data } = await as.outsider.from("checklist_items").select("id").eq("id", itemB);
    expect(data).toEqual([]);
    const update = await as.outsider
      .from("checklist_items")
      .update({ title: "Mío" })
      .eq("id", itemB)
      .select("id");
    expect(update.data).toEqual([]);
  });

  it("deleting a wedding deletes its checklist and seeding record, not the template", async () => {
    const doomed = await initializedWedding("ownerA", "Boda que se borra con lista");
    const { error } = await as.ownerA.from("weddings").delete().eq("id", doomed);
    expect(error).toBeNull();
    expect(await weddingExists(doomed)).toBe(false);
    expect(await itemCount(doomed)).toBe(0);
    expect(await applicationCount(doomed)).toBe(0);
    const template = await sql<{ n: number }>(
      "select count(*)::int as n from public.checklist_template_items",
    );
    expect(template[0]?.n).toBe(TEMPLATE_ITEM_COUNT);
  });
});

// ------------------------------------------------------------ lifecycle

describe("checklist status lifecycle and completed_at", () => {
  let weddingId: string;
  let itemId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda de estados");
    await addMember(weddingId, "collabA", "collaborator");
    const { data } = await addItem("ownerA", weddingId, "Cambiar de estado");
    itemId = data?.id ?? "";
  });

  async function setStatus(actor: keyof typeof as, status: "pending" | "done" | "not_applicable") {
    const { error } = await as[actor].from("checklist_items").update({ status }).eq("id", itemId);
    expect(error).toBeNull();
    return itemRow(itemId);
  }

  it("pending → done stamps the database clock and the actor", async () => {
    const [{ now }] = await sql<{ now: Date }>("select now() as now");
    const row = await setStatus("collabA", "done");
    expect(row?.status).toBe("done");
    expect(row?.completed_by).toBe(users.collabA.id);
    expect(row?.completed_at).toBeInstanceOf(Date);
    expect(Math.abs((row?.completed_at?.getTime() ?? 0) - now.getTime())).toBeLessThan(60_000);
  });

  it("editing a done item keeps its completion stamp", async () => {
    const before = await itemRow(itemId);
    await as.ownerA.from("checklist_items").update({ title: "Cambiar de estado (editado)" }).eq("id", itemId);
    const after = await itemRow(itemId);
    expect(after?.completed_at).toEqual(before?.completed_at);
    expect(after?.completed_by).toBe(before?.completed_by);
  });

  it("done → pending clears the stamp", async () => {
    const row = await setStatus("ownerA", "pending");
    expect(row).toMatchObject({ status: "pending", completed_at: null, completed_by: null });
  });

  it("pending → not_applicable → pending never stamps", async () => {
    expect(await setStatus("ownerA", "not_applicable")).toMatchObject({
      status: "not_applicable",
      completed_at: null,
    });
    expect(await setStatus("collabA", "pending")).toMatchObject({ status: "pending", completed_at: null });
  });

  it("done ⇄ not_applicable directly is allowed and keeps the invariant", async () => {
    await setStatus("ownerA", "done");
    expect(await setStatus("ownerA", "not_applicable")).toMatchObject({
      status: "not_applicable",
      completed_at: null,
      completed_by: null,
    });
    const row = await setStatus("ownerA", "done");
    expect(row?.completed_at).toBeInstanceOf(Date);
    await setStatus("ownerA", "pending");
  });

  it("rejects unknown statuses", async () => {
    const { error } = await as.ownerA
      .from("checklist_items")
      // @ts-expect-error: deliberately outside the generated enum.
      .update({ status: "in_progress" })
      .eq("id", itemId);
    expect(error?.code).toBe("22P02");
    expect((await itemRow(itemId))?.status).toBe("pending");
  });

  it("the database refuses done without completed_at even with triggers bypassed", async () => {
    const client = await superuser.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await expect(
        client.query("update public.checklist_items set status = 'done' where id = $1", [itemId]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

// --------------------------------------------------------------- timing

describe("checklist timing", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await createFixtureWedding("ownerA", "Boda con fecha");
    createdWeddings.push(weddingId);
    await sql("update public.weddings set wedding_date = '2027-08-14' where id = $1", [weddingId]);
  });

  async function insertTimed(values: {
    timing_mode: "none" | "relative_to_wedding" | "absolute";
    relative_days?: number | null;
    due_date?: string | null;
  }) {
    return as.ownerA
      .from("checklist_items")
      .insert({ wedding_id: weddingId, title: "Con fecha", ...values })
      .select("id")
      .single();
  }

  it("accepts each consistent timing shape", async () => {
    for (const values of [
      { timing_mode: "none" as const },
      { timing_mode: "relative_to_wedding" as const, relative_days: -30 },
      { timing_mode: "relative_to_wedding" as const, relative_days: 0 },
      { timing_mode: "relative_to_wedding" as const, relative_days: 7 },
      { timing_mode: "absolute" as const, due_date: "2027-03-15" },
    ]) {
      const { error } = await insertTimed(values);
      expect(error, JSON.stringify(values)).toBeNull();
    }
  });

  it("rejects contradictory timing", async () => {
    for (const values of [
      { timing_mode: "none" as const, relative_days: -30 },
      { timing_mode: "none" as const, due_date: "2027-03-15" },
      { timing_mode: "relative_to_wedding" as const },
      { timing_mode: "relative_to_wedding" as const, relative_days: -30, due_date: "2027-03-15" },
      { timing_mode: "absolute" as const },
      { timing_mode: "absolute" as const, due_date: "2027-03-15", relative_days: -30 },
      { timing_mode: "relative_to_wedding" as const, relative_days: 1001 },
      { timing_mode: "relative_to_wedding" as const, relative_days: -1001 },
    ]) {
      const { error } = await insertTimed(values);
      expect(error?.code, JSON.stringify(values)).toBe(CHECK_VIOLATION);
    }
  });

  it("relative dates follow the wedding date; absolute dates don't", async () => {
    const relative = await insertTimed({ timing_mode: "relative_to_wedding", relative_days: -30 });
    const absolute = await insertTimed({ timing_mode: "absolute", due_date: "2027-03-15" });

    async function effective(id: string): Promise<string | null> {
      const [wedding] = await sql<{ wedding_date: string | null }>(
        "select wedding_date::text from public.weddings where id = $1",
        [weddingId],
      );
      const { data } = await as.ownerA
        .from("checklist_items")
        .select("timing_mode, relative_days, due_date")
        .eq("id", id)
        .single();
      const timing = data ? timingFromColumns(data) : null;
      return timing ? effectiveDueDate(timing, wedding.wedding_date) : null;
    }

    expect(await effective(relative.data?.id ?? "")).toBe("2027-07-15");
    expect(await effective(absolute.data?.id ?? "")).toBe("2027-03-15");
    // Postgres date arithmetic agrees with the app's.
    const [pg] = await sql<{ d: string }>("select ('2027-08-14'::date + -30)::text as d");
    expect(pg.d).toBe("2027-07-15");

    // The owner moves the wedding: only the relative item moves.
    const { error } = await as.ownerA
      .from("weddings")
      .update({ wedding_date: "2027-09-01" })
      .eq("id", weddingId);
    expect(error).toBeNull();
    expect(await effective(relative.data?.id ?? "")).toBe("2027-08-02");
    expect(await effective(absolute.data?.id ?? "")).toBe("2027-03-15");

    // Without a wedding date, the relative item stays valid, date unknown.
    await sql("update public.weddings set wedding_date = null where id = $1", [weddingId]);
    expect(await effective(relative.data?.id ?? "")).toBeNull();
    expect(await effective(absolute.data?.id ?? "")).toBe("2027-03-15");
  });
});

// --------------------------------------------------------- independence

describe("template copy independence", () => {
  it("later template changes never touch an existing wedding's items", async () => {
    const STABLE_KEY = "venue.reception";
    const [original] = await sql<{ id: string; title: string }>(
      `select ti.id, ti.title from public.checklist_template_items ti
       join public.checklist_templates t on t.id = ti.template_id
       where t.key = $1 and t.version = 1 and ti.stable_key = $2`,
      [TEMPLATE_KEY, STABLE_KEY],
    );

    const weddingA = await initializedWedding("ownerA", "Boda sembrada antes");
    const copyTitle = async (weddingId: string) => {
      const { data } = await as.ownerA
        .from("checklist_items")
        .select("title")
        .eq("wedding_id", weddingId)
        .eq("source_template_item_id", original.id)
        .single();
      return data?.title;
    };
    expect(await copyTitle(weddingA)).toBe(original.title);

    // Privileged local fixture: edit the system template row, then restore it.
    await sql("update public.checklist_template_items set title = $1 where id = $2", [
      "Título cambiado en la plantilla",
      original.id,
    ]);
    try {
      expect(await copyTitle(weddingA)).toBe(original.title);

      // A wedding seeded now copies the template as it is now.
      const weddingB = await initializedWedding("ownerA", "Boda sembrada después");
      expect(await copyTitle(weddingB)).toBe("Título cambiado en la plantilla");
    } finally {
      await sql("update public.checklist_template_items set title = $1 where id = $2", [
        original.title,
        original.id,
      ]);
    }

    // And the other way round: editing the wedding's copy leaves the template alone.
    await as.ownerA
      .from("checklist_items")
      .update({ title: "Nuestro salón" })
      .eq("wedding_id", weddingA)
      .eq("source_template_item_id", original.id);
    const [template] = await sql<{ title: string }>(
      "select title from public.checklist_template_items where id = $1",
      [original.id],
    );
    expect(template.title).toBe(original.title);
  });
});
