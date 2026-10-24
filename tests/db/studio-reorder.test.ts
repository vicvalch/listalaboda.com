import { afterAll, describe, expect, it } from "vitest";
import { addMember, as, createWedding, sql } from "./support";

const weddings: string[] = [];
afterAll(async () => { await sql("delete from public.weddings where id = any($1::uuid[])", [weddings]); });
async function fixture() {
  const wedding = await createWedding("ownerA", "Studio atomic reorder");
  weddings.push(wedding);
  await addMember(wedding, "collabA", "collaborator");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const result = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: wedding, kind: "gallery", variant: "grid", anchor: "intro" }).select("id").single();
    if (result.error || !result.data) throw new Error("fixture block insert failed");
    ids.push(result.data.id);
  }
  return { wedding, ids };
}
function move(wedding: string, id: string, order: string[], before?: string, actor: keyof typeof as = "ownerA", anchor = "intro") {
  return as[actor].rpc("reorder_wedding_site_photo_block", { target_wedding_id: wedding, target_block_id: id,
    expected_anchor: anchor, expected_order: order, ...(before ? { before_block_id: before } : {}) });
}
async function rows(wedding: string) {
  return sql<{ id: string; position: number; is_visible: boolean; anchor: string; title: string | null; body: string | null; updated_at: Date }>(
    "select id, position, is_visible, anchor, title, body, updated_at from public.wedding_site_photo_blocks where wedding_id = $1 order by position, id", [wedding]);
}

describe("atomic same-slot placement", () => {
  it("moves any distance, returns saved order and preserves identity, visibility, content and photo membership", async () => {
    const { wedding, ids } = await fixture();
    await as.ownerA.from("wedding_site_photo_blocks").update({ is_visible: true }).eq("id", ids[0]!);
    await sql("insert into public.wedding_photos(wedding_id,block_id,state,width,height,bytes,alt_text) values ($1,$2,'ready',640,480,100,'Fixture')", [wedding, ids[0]]);
    const before = await rows(wedding);
    const photos = await sql("select * from public.wedding_photos where wedding_id = $1", [wedding]);
    const result = await move(wedding, ids[3]!, ids, ids[0], "collabA");
    expect(result.error).toBeNull();
    expect(result.data).toEqual([ids[3], ...ids.slice(0, 3)]);
    const after = await rows(wedding);
    expect(after.map((r) => r.id)).toEqual(result.data);
    const content = (rs: typeof after) => rs.map(({ position: _p, updated_at: _t, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
    expect(content(after)).toEqual(content(before));
    expect(await sql("select * from public.wedding_photos where wedding_id = $1", [wedding])).toEqual(photos);
  });

  it("does not write for self, neighbor or already-last no-ops", async () => {
    const { wedding, ids } = await fixture();
    const before = await rows(wedding);
    for (const [id, target] of [[ids[0], ids[0]], [ids[0], ids[1]], [ids[3], undefined]]) {
      expect((await move(wedding, id!, ids, target)).error).toBeNull();
      expect(await rows(wedding)).toEqual(before);
    }
  });

  it("rejects stale order, foreign slots, invalid targets, cover moves and inaccessible weddings", async () => {
    const { wedding, ids } = await fixture();
    const { wedding: other, ids: others } = await fixture();
    const cover = await as.ownerA.from("wedding_site_photo_blocks").insert({ wedding_id: wedding, kind: "cover", variant: "standard" }).select("id").single();
    const before = await rows(wedding);
    const invalid = [
      move(wedding, ids[0]!, [...ids].reverse(), ids[2]),
      move(wedding, ids[0]!, ids, others[0]),
      move(wedding, ids[0]!, ids, ids[2], "ownerA", "faq"),
      move(wedding, cover.data!.id, ids, ids[0]),
      move(other, ids[0]!, ids, ids[2]),
      ...(["ownerB", "outsider", "anon"] as const).map((actor) => move(wedding, ids[0]!, ids, ids[2], actor)),
    ];
    for (const result of await Promise.all(invalid)) expect(result.error).not.toBeNull();
    expect(await rows(wedding)).toEqual(before);
  });

  it("rolls back all positions if a trigger fails after a position has already been updated", async () => {
    const { wedding, ids } = await fixture();
    const before = await rows(wedding);
    // TEST-ONLY fault injection on the throwaway runner DB. No production path.
    await sql(`create function private.studio_test_fail_second_update() returns trigger language plpgsql as $$
      declare n integer;
      begin
        if new.wedding_id::text = '${wedding}' then
          n := coalesce(nullif(current_setting('studio_test.updates', true), ''), '0')::integer + 1;
          perform set_config('studio_test.updates', n::text, true);
          if n = 2 then raise exception 'studio_test_forced_failure'; end if;
        end if;
        return new;
      end; $$;
      create trigger studio_test_fail_second_update before update of position on public.wedding_site_photo_blocks
      for each row execute function private.studio_test_fail_second_update()`);
    try {
      const result = await move(wedding, ids[3]!, ids, ids[0]);
      expect(result.error?.message).toContain("studio_test_forced_failure");
      expect(await rows(wedding)).toEqual(before);
    } finally {
      await sql("drop trigger studio_test_fail_second_update on public.wedding_site_photo_blocks; drop function private.studio_test_fail_second_update()");
    }
  });

  it("serializes competing reorders: exactly one expected-order request wins", async () => {
    const { wedding, ids } = await fixture();
    const results = await Promise.all([move(wedding, ids[3]!, ids, ids[0]), move(wedding, ids[0]!, ids, undefined, "collabA")]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error?.code).toBe("40001");
    expect((await rows(wedding)).map((r) => r.id)).toEqual(results.find((r) => !r.error)?.data);
  });

  it("preserves integrity alongside insertion and legacy adjacent swaps", async () => {
    const { wedding, ids } = await fixture();
    const [reorder, insert, swap] = await Promise.all([
      move(wedding, ids[3]!, ids, ids[0]),
      as.collabA.from("wedding_site_photo_blocks").insert({ wedding_id: wedding, kind: "gallery", variant: "grid", anchor: "intro" }).select("id").single(),
      as.collabA.rpc("move_wedding_site_photo_block", { target_block_id: ids[1]!, direction: "before" }),
    ]);
    expect(insert.error).toBeNull();
    if (reorder.error) expect(["40001", "40P01"]).toContain(reorder.error.code);
    if (swap.error) expect(swap.error.code).toBe("40P01");
    const after = await rows(wedding);
    expect(after.map((r) => r.id).sort()).toEqual([...ids, insert.data!.id].sort());
    expect(new Set(after.map((r) => r.position)).size).toBe(after.length);
  });
});
