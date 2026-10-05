import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  serviceRole,
  shapedEnvelope,
  sql,
} from "./support";

// LB-16 (ADR-009): checklist items may be about one guest party of their own
// wedding. Exercised as real anon/authenticated users through the Data API;
// the superuser connection only arranges fixtures and reads ground truth.

/** foreign_key_violation: the party isn't one of the item's wedding. */
const FOREIGN_KEY_VIOLATION = "23503";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

type Party = { id: string; hash: string };

async function createParty(actor: TestUserKey, weddingId: string, label: string, names: string[]): Promise<Party> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: names,
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, hash };
}

async function addItem(actor: TestUserKey, weddingId: string, title: string): Promise<string> {
  const { data, error } = await as[actor]
    .from("checklist_items")
    .insert({
      wedding_id: weddingId,
      title,
      category: "invitations",
      timing_mode: "relative_to_wedding",
      relative_days: -60,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert failed: ${error?.message}`);
  return data.id;
}

function link(actor: keyof typeof as, weddingId: string, itemId: string, partyId: string | null) {
  return as[actor]
    .from("checklist_items")
    .update({ guest_invitation_id: partyId })
    .eq("id", itemId)
    .eq("wedding_id", weddingId)
    .select("id, guest_invitation_id");
}

async function linkOf(itemId: string): Promise<string | null | undefined> {
  const rows = await sql<{ guest_invitation_id: string | null }>(
    "select guest_invitation_id from public.checklist_items where id = $1",
    [itemId],
  );
  return rows[0]?.guest_invitation_id;
}

/** Every column of the item except the link and updated_at. */
async function itemState(itemId: string) {
  const [row] = await sql<Record<string, unknown>>("select * from public.checklist_items where id = $1", [itemId]);
  if (!row) return undefined;
  const rest = { ...row };
  delete rest.guest_invitation_id;
  delete rest.updated_at;
  return rest;
}

/** The party and everything hanging off it, for "linking never touches the guest domain". */
async function guestDomainState(weddingId: string) {
  const [parties, guests, rsvps, activity, secrets] = await Promise.all([
    sql("select * from public.guest_invitations where wedding_id = $1 order by id", [weddingId]),
    sql("select * from public.guests where wedding_id = $1 order by id", [weddingId]),
    sql("select * from public.rsvps where wedding_id = $1 order by guest_id", [weddingId]),
    sql("select * from public.wedding_activity where wedding_id = $1 order by id", [weddingId]),
    sql(
      `select s.* from private.guest_invitation_capability_secrets s
       join public.guest_invitations g on g.id = s.guest_invitation_id
       where g.wedding_id = $1 order by s.guest_invitation_id`,
      [weddingId],
    ),
  ]);
  return { parties, guests, rsvps, activity, secrets };
}

// ------------------------------------------------------------------ schema

describe("checklist ↔ guest work schema", () => {
  it("adds exactly one nullable uuid column on checklist_items, and no link table", async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'checklist_items'
         and column_name = 'guest_invitation_id'`,
    );
    expect(rows).toEqual([{ column_name: "guest_invitation_id", data_type: "uuid", is_nullable: "YES" }]);

    // No polymorphic pair, stored route, JSON or guest-work side table (ADR-001 §2, ADR-009).
    const generic = await sql<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'checklist_items'
         and (column_name ~* '(href|url|path|route|link|entity|target|metadata|payload|json)'
              or data_type in ('json', 'jsonb'))`,
    );
    expect(generic).toEqual([]);
    const tables = await sql(
      `select table_name from information_schema.tables
       where table_schema in ('public', 'private')
         and (table_name ~* 'guest_work' or table_name ~* 'checklist.*(guest|link|relat)')`,
    );
    expect(tables).toEqual([]);
  });

  it("the FK is composite on (party, item's wedding) and only nulls the link on party delete", async () => {
    const rows = await sql<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid = 'public.checklist_items'::regclass and c.contype = 'f'
         and c.confrelid = 'public.guest_invitations'::regclass`,
    );
    expect(rows).toEqual([
      {
        def:
          "FOREIGN KEY (guest_invitation_id, wedding_id) REFERENCES guest_invitations(id, wedding_id) ON DELETE SET NULL (guest_invitation_id)",
      },
    ]);
  });

  it("a partial index serves the party lookup", async () => {
    const rows = await sql<{ def: string }>(
      `select pg_get_indexdef(i.indexrelid) as def from pg_index i
       where i.indrelid = 'public.checklist_items'::regclass
         and pg_get_indexdef(i.indexrelid) like '%guest_invitation_id%'`,
    );
    expect(rows.map((r) => r.def)).toEqual([
      "CREATE INDEX checklist_items_guest_invitation_idx ON public.checklist_items USING btree (guest_invitation_id, wedding_id) WHERE (guest_invitation_id IS NOT NULL)",
    ]);
  });

  it("authenticated may UPDATE the link (like any checklist edit) but not INSERT it; anon nothing", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'checklist_items'
         and column_name = 'guest_invitation_id' and grantee in ('anon', 'authenticated')
         and privilege_type in ('INSERT', 'UPDATE')
       order by grantee, privilege_type`,
    );
    expect(rows).toEqual([{ grantee: "authenticated", privilege_type: "UPDATE" }]);
  });

  it("no function takes or returns the link (no RPC door, no guest-facing projection)", async () => {
    const rows = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and (pg_get_function_arguments(p.oid) ilike '%checklist%'
              or pg_get_function_result(p.oid) ilike '%checklist%'
              or p.prosrc ilike '%checklist_items%guest_invitation_id%'
              or p.prosrc ilike '%guest_invitation_id%checklist_items%')`,
    );
    expect(rows).toEqual([]);
  });
});

// ------------------------------------------------------------- behaviour

describe("linking a checklist item to a guest party", () => {
  let weddingA: string;
  let weddingB: string;
  let partyA1: Party;
  let partyA2: Party;
  let partyB: Party;

  beforeAll(async () => {
    weddingA = await fixtureWedding("ownerA", "Boda pendientes e invitados A");
    await addMember(weddingA, "collabA", "collaborator");
    weddingB = await fixtureWedding("ownerB", "Boda pendientes e invitados B");
    partyA1 = await createParty("ownerA", weddingA, "Familia Pérez", ["Ana", "Carlos"]);
    partyA2 = await createParty("ownerA", weddingA, "Familia Gómez", ["Lucía"]);
    partyB = await createParty("ownerB", weddingB, "Familia Ajena", ["Otro"]);
  });

  it.each(["ownerA", "collabA"] as const)("%s links, changes and unlinks (zero or one party, atomically)", async (actor) => {
    const itemId = await addItem("ownerA", weddingA, `Transporte (${actor})`);
    expect(await linkOf(itemId)).toBeNull();

    const first = await link(actor, weddingA, itemId, partyA1.id);
    expect(first.error).toBeNull();
    expect(first.data).toEqual([{ id: itemId, guest_invitation_id: partyA1.id }]);

    // Change = one UPDATE of one column: the item can never point at two parties.
    const changed = await link(actor, weddingA, itemId, partyA2.id);
    expect(changed.data).toEqual([{ id: itemId, guest_invitation_id: partyA2.id }]);

    // Same target again is a harmless no-op.
    expect((await link(actor, weddingA, itemId, partyA2.id)).data).toEqual([
      { id: itemId, guest_invitation_id: partyA2.id },
    ]);

    const removed = await link(actor, weddingA, itemId, null);
    expect(removed.data).toEqual([{ id: itemId, guest_invitation_id: null }]);
    expect(await linkOf(itemId)).toBeNull();
  });

  it("a party may be the subject of several items", async () => {
    const one = await addItem("ownerA", weddingA, "Hotel de los Pérez");
    const two = await addItem("ownerA", weddingA, "Mesa de los Pérez");
    await link("ownerA", weddingA, one, partyA1.id);
    await link("collabA", weddingA, two, partyA1.id);
    const rows = await sql<{ id: string }>(
      "select id from public.checklist_items where guest_invitation_id = $1 and id = any($2::uuid[]) order by id",
      [partyA1.id, [one, two]],
    );
    expect(rows.map((r) => r.id).sort()).toEqual([one, two].sort());
  });

  it("a party of ANOTHER wedding is refused by the database (forged cross-wedding link)", async () => {
    const itemId = await addItem("ownerA", weddingA, "Intento cruzado");
    const forged = await link("ownerA", weddingA, itemId, partyB.id);
    expect(forged.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await linkOf(itemId)).toBeNull();

    // An unknown id fails exactly the same way: the error doesn't reveal that partyB exists.
    const unknown = await link("ownerA", weddingA, itemId, "00000000-0000-4000-8000-000000000000");
    expect(unknown.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(unknown.error?.message).toBe(forged.error?.message);
    expect(await linkOf(itemId)).toBeNull();
  });

  it("the same-wedding rule holds even for privileged writes (not just RLS)", async () => {
    const itemId = await addItem("ownerA", weddingA, "Intento privilegiado");
    await expect(
      sql("update public.checklist_items set guest_invitation_id = $2 where id = $1", [itemId, partyB.id]),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    const service = await serviceRole
      .from("checklist_items")
      .update({ guest_invitation_id: partyB.id })
      .eq("id", itemId)
      .select("id");
    expect(service.error?.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(await linkOf(itemId)).toBeNull();
  });

  it("members of another wedding, outsiders and anon can't link (or see) the item", async () => {
    const itemId = await addItem("ownerA", weddingA, "Solo para la boda A");
    for (const actor of ["ownerB", "outsider"] as const) {
      // RLS hides the row: zero rows, nothing written. Even with their own party.
      const own = await link(actor, weddingA, itemId, actor === "ownerB" ? partyB.id : partyA1.id);
      expect(own.data ?? []).toEqual([]);
    }
    const anon = await link("anon", weddingA, itemId, partyA1.id);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);
    expect(await linkOf(itemId)).toBeNull();
  });

  it("the guest capability never reaches the checklist", async () => {
    const itemId = await addItem("ownerA", weddingA, "Pendiente privado");
    await link("ownerA", weddingA, itemId, partyA1.id);
    const { data, error } = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: partyA1.hash });
    expect(error).toBeNull();
    expect(JSON.stringify(data)).not.toContain(itemId);
    expect(JSON.stringify(data)).not.toContain("Pendiente privado");
    const read = await as.anon.from("checklist_items").select("id").eq("id", itemId);
    expect(read.error?.code).toBe(PERMISSION_DENIED);
  });

  it("items are created unlinked: the link isn't an INSERT column", async () => {
    const { error } = await as.ownerA
      .from("checklist_items")
      .insert({ wedding_id: weddingA, title: "Creado ya vinculado", guest_invitation_id: partyA1.id });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it.each(["pending", "done", "not_applicable"] as const)(
    "linking, changing and unlinking keep a %s item exactly as it was",
    async (status) => {
      const itemId = await addItem("ownerA", weddingA, `Estado ${status}`);
      await as.collabA.from("checklist_items").update({ status }).eq("id", itemId);
      const before = await itemState(itemId);
      expect(before?.status).toBe(status);
      if (status === "done") expect(before?.completed_at).not.toBeNull();

      for (const target of [partyA1.id, partyA2.id, null]) {
        await link("ownerA", weddingA, itemId, target);
        expect(await itemState(itemId)).toEqual(before);
      }
    },
  );

  it("linking never touches the party, its guests, RSVPs, link, emails or history", async () => {
    // An RSVP and a contact email exist, so there is something to (not) change.
    const guests = await sql<{ id: string }>(
      "select id from public.guests where guest_invitation_id = $1 order by created_at",
      [partyA2.id],
    );
    await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: partyA2.hash,
      responses: guests.map((g) => ({ guest_id: g.id, attending: true, dietary_note: "sin gluten" })),
    });
    await as.ownerA
      .from("guest_invitations")
      .update({ contact_email: "gomez@example.test" })
      .eq("id", partyA2.id);

    const itemId = await addItem("ownerA", weddingA, "Seguimiento Gómez");
    const before = await guestDomainState(weddingA);
    await link("ownerA", weddingA, itemId, partyA2.id);
    await link("collabA", weddingA, itemId, partyA1.id);
    await link("ownerA", weddingA, itemId, null);
    expect(await guestDomainState(weddingA)).toEqual(before);
  });

  it("guest events (an RSVP) never complete a linked item", async () => {
    const party = await createParty("ownerA", weddingA, "Familia Responde", ["Rita"]);
    const itemId = await addItem("ownerA", weddingA, "Esperar respuesta");
    await link("ownerA", weddingA, itemId, party.id);
    const before = await itemState(itemId);
    const guests = await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [party.id]);
    const { error } = await as.anon.rpc("submit_guest_rsvp", {
      invitation_token_hash: party.hash,
      responses: guests.map((g) => ({ guest_id: g.id, attending: true })),
    });
    expect(error).toBeNull();
    expect(await itemState(itemId)).toEqual(before);
    expect(await linkOf(itemId)).toBe(party.id);
  });
});

// ---------------------------------------------------------------- deletion

describe("checklist ↔ guest work deletion", () => {
  let weddingId: string;

  beforeAll(async () => {
    weddingId = await fixtureWedding("ownerA", "Boda borrados pendientes e invitados");
    await addMember(weddingId, "collabA", "collaborator");
  });

  it("deleting the party keeps the item (status included) and just clears the link", async () => {
    const party = await createParty("ownerA", weddingId, "Familia Borrada", ["Uno"]);
    const other = await createParty("ownerA", weddingId, "Familia Intacta", ["Dos"]);
    const doneItem = await addItem("ownerA", weddingId, "Hecho y vinculado");
    const otherItem = await addItem("ownerA", weddingId, "Vinculado a otra");
    await as.ownerA.from("checklist_items").update({ status: "done" }).eq("id", doneItem);
    await link("ownerA", weddingId, doneItem, party.id);
    await link("ownerA", weddingId, otherItem, other.id);
    const before = await itemState(doneItem);

    // The real organizer path: any member may delete a party.
    const deleted = await as.collabA.from("guest_invitations").delete().eq("id", party.id).select("id");
    expect(deleted.data).toEqual([{ id: party.id }]);

    expect(await linkOf(doneItem)).toBeNull();
    expect(await itemState(doneItem)).toEqual(before);
    // No retargeting: the other item still points at its own party.
    expect(await linkOf(otherItem)).toBe(other.id);
  });

  it("deleting the item leaves the party and everything under it untouched", async () => {
    const party = await createParty("ownerA", weddingId, "Familia Sigue", ["Tres"]);
    const itemId = await addItem("ownerA", weddingId, "Borrar este pendiente");
    await link("ownerA", weddingId, itemId, party.id);
    const before = await guestDomainState(weddingId);

    const del = await as.collabA.from("checklist_items").delete().eq("id", itemId).select("id");
    expect(del.data).toEqual([{ id: itemId }]);
    expect(await linkOf(itemId)).toBeUndefined();
    expect(await guestDomainState(weddingId)).toEqual(before);
  });

  it("deleting the wedding removes both sides with their tenant", async () => {
    const doomed = await createFixtureWedding("ownerA", "Boda que se elimina (vínculos)");
    const party = await createParty("ownerA", doomed, "Familia Final", ["Cuatro"]);
    const itemId = await addItem("ownerA", doomed, "Último pendiente");
    await link("ownerA", doomed, itemId, party.id);
    await sql("delete from public.weddings where id = $1", [doomed]);
    expect(await linkOf(itemId)).toBeUndefined();
    expect(await sql("select 1 from public.guest_invitations where id = $1", [party.id])).toEqual([]);
  });
});
