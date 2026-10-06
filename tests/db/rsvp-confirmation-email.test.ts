import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  emailDeliveriesFor,
  createWedding as createFixtureWedding,
  serviceRole,
  sql,
  shapedEnvelope,
} from "./support";

// LB-12: the RSVP confirmation's database boundary (ADR-005), exercised as
// real anon, authenticated and service_role callers through the Data API.
// The superuser connection only arranges fixtures and reads ground truth.

const CHECK_VIOLATION = "23514";
const CONFIRMATION_COLUMNS = [
  "rsvp_confirmation_email_provider_id",
  "rsvp_confirmation_email_sent_at",
  "rsvp_confirmation_email_sent_to",
];

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

type Party = { id: string; hash: string };

async function createParty(actor: TestUserKey, weddingId: string, label: string, contactEmail?: string): Promise<Party> {
  const { hash } = newToken();
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: ["Invitada Uno", "Invitado Dos"],
    ...(contactEmail ? { party_contact_email: contactEmail } : {}),
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, hash };
}

/** The guest's own RSVP, as anon through the capability. */
async function answer(party: Party, attending: boolean) {
  const guests = await sql<{ id: string }>(
    "select id from public.guests where guest_invitation_id = $1 order by created_at",
    [party.id],
  );
  const { error } = await as.anon.rpc("submit_guest_rsvp", {
    invitation_token_hash: party.hash,
    responses: guests.map((g) => ({ guest_id: g.id, attending, dietary_note: "nota privada" })),
  });
  if (error) throw new Error(`submit_guest_rsvp failed: ${error.message}`);
}

function setEmail(weddingId: string, partyId: string, email: string | null) {
  return as.ownerA
    .from("guest_invitations")
    .update({ contact_email: email })
    .eq("id", partyId)
    .eq("wedding_id", weddingId)
    .select("id");
}

type Actor = keyof typeof as | "service";
const client = (actor: Actor) => (actor === "service" ? serviceRole : as[actor]);

function record(
  actor: Actor,
  args: { weddingId: string; partyId: string; hash: string; recipient: string; providerId?: string },
) {
  return client(actor).rpc("record_rsvp_confirmation_email", {
    target_wedding_id: args.weddingId,
    target_invitation_id: args.partyId,
    invitation_token_hash: args.hash,
    recipient: args.recipient,
    provider_message_id: args.providerId ?? `msg_confirm_${randomUUID()}`,
  });
}

function readContext(actor: Actor, hash: string) {
  return client(actor).rpc("get_rsvp_confirmation_email_context", { invitation_token_hash: hash });
}

/** Everything the confirmation must never touch, plus its own columns. */
async function snapshot(partyId: string) {
  const [party] = await sql<Record<string, unknown>>(
    `select token_hash, token_issued_at, revoked_at, label, contact_email,
            invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id,
            rsvp_confirmation_email_sent_at, rsvp_confirmation_email_sent_to, rsvp_confirmation_email_provider_id
     from public.guest_invitations where id = $1`,
    [partyId],
  );
  const guests = await sql(
    `select g.id, g.name, r.attending, r.dietary_note from public.guests g
     left join public.rsvps r on r.guest_id = g.id
     where g.guest_invitation_id = $1 order by g.created_at`,
    [partyId],
  );
  return { party: party!, guests };
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Confirmación A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Confirmación B");
  await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad Ejemplo' where id = $1", [weddingA]);
});

// ----------------------------------------------------------------- schema

describe("schema: confirmation metadata lives on the party only", () => {
  it("the three columns exist on guest_invitations and nowhere else; no email on guests or RSVPs", async () => {
    const rows = await sql<{ name: string }>(
      `select table_name || '.' || column_name as name from information_schema.columns
       where table_schema = 'public' and column_name like 'rsvp_confirmation_email%' order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(CONFIRMATION_COLUMNS.map((c) => `guest_invitations.${c}`));
    const onGuests = await sql(
      `select 1 from information_schema.columns where table_schema = 'public'
       and table_name in ('guests', 'rsvps') and (column_name ilike '%email%' or column_name ilike '%token%')`,
    );
    expect(onGuests).toEqual([]);
  });

  it("the three fields are set together or not at all; sent_to and provider id are validated", async () => {
    const party = await createParty("ownerA", weddingA, "Completo");
    await expect(
      sql("update public.guest_invitations set rsvp_confirmation_email_sent_at = now() where id = $1", [party.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql(
        `update public.guest_invitations set rsvp_confirmation_email_sent_at = now(),
           rsvp_confirmation_email_sent_to = 'no valido', rsvp_confirmation_email_provider_id = 'x' where id = $1`,
        [party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql(
        `update public.guest_invitations set rsvp_confirmation_email_sent_at = now(),
           rsvp_confirmation_email_sent_to = 'a@example.com', rsvp_confirmation_email_provider_id = 'con espacios' where id = $1`,
        [party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// ---------------------------------------------------------------- privacy

describe("privacy: confirmation metadata is members-only", () => {
  it("anon can't read it", async () => {
    const party = await createParty("ownerA", weddingA, "Anon", "anon-conf@example.com");
    const read = await as.anon.from("guest_invitations").select("rsvp_confirmation_email_sent_to").eq("id", party.id);
    expect(read.error?.code).toBe(PERMISSION_DENIED);
  });

  it("members read it; outsiders and other weddings' owners see nothing", async () => {
    const party = await createParty("ownerA", weddingA, "Lectura", "lectura@example.com");
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "lectura@example.com" });
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data } = await as[actor]
        .from("guest_invitations")
        .select("rsvp_confirmation_email_sent_to")
        .eq("id", party.id);
      expect(data, actor).toEqual([{ rsvp_confirmation_email_sent_to: "lectura@example.com" }]);
    }
    for (const actor of ["outsider", "ownerB"] as const) {
      const { data } = await as[actor].from("guest_invitations").select("rsvp_confirmation_email_sent_to").eq("id", party.id);
      expect(data, actor).toEqual([]);
    }
  });

  it("guest and public functions never return it (nor the contact email)", async () => {
    const party = await createParty("ownerA", weddingA, "Funciones", "funciones@example.com");
    await answer(party, true);
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "funciones@example.com", providerId: "msg_secreto_1" });
    // Publish the site so the public function returns a real projection.
    await sql(
      `insert into public.wedding_publications (wedding_id, slug, published_at) values ($1, $2, now())
       on conflict (wedding_id) do update set published_at = now()`,
      [weddingA, `conf-${party.id.slice(0, 8)}`],
    );
    await sql(
      `insert into public.content_sections (wedding_id, kind, title, body, is_visible) values ($1, 'intro', 'Hola', 'Texto', true)
       on conflict do nothing`,
      [weddingA],
    );
    const results = [
      await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash }),
      await as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: party.hash }),
      await as.anon.rpc("get_published_wedding_site", { site_slug: `conf-${party.id.slice(0, 8)}` }),
    ];
    for (const { data, error } of results) {
      expect(error).toBeNull();
      const body = JSON.stringify(data);
      expect(body).not.toContain("funciones@example.com");
      expect(body).not.toContain("msg_secreto_1");
      expect(body).not.toContain("rsvp_confirmation");
    }
    const returned = await sql<{ name: string }>(
      `select p.proname || '.' || a.name as name
       from pg_proc p, unnest(p.proargnames) as a (name)
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('get_guest_invitation', 'get_guest_invitation_site_slug', 'get_published_wedding_site', 'submit_guest_rsvp')
         and (a.name ilike '%email%' or a.name ilike '%confirmation%' or a.name ilike '%provider%')`,
    );
    expect(returned).toEqual([]);
  });
});

// ----------------------------------------------------------- client writes

describe("no client can forge the confirmation status", () => {
  it("members can't write the columns directly", async () => {
    const party = await createParty("ownerA", weddingA, "Forja", "forja-conf@example.com");
    for (const actor of ["ownerA", "collabA"] as const) {
      for (const patch of [
        { rsvp_confirmation_email_sent_at: new Date().toISOString() },
        { rsvp_confirmation_email_sent_to: "forja-conf@example.com" },
        { rsvp_confirmation_email_provider_id: "forged" },
      ]) {
        const { error } = await as[actor].from("guest_invitations").update(patch).eq("id", party.id);
        expect(error?.code, JSON.stringify(patch)).toBe(PERMISSION_DENIED);
      }
    }
    const insert = await as.ownerA.from("guest_invitations").insert({
      wedding_id: weddingA,
      label: "Forja insert",
      token_hash: newToken().hash,
      rsvp_confirmation_email_sent_at: new Date().toISOString(),
      rsvp_confirmation_email_sent_to: "forja-conf@example.com",
      rsvp_confirmation_email_provider_id: "forged",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_sent_at).toBeNull();
  });
});

// ------------------------------------------------------------------ grants

describe("only service_role can execute the confirmation functions (ADR-005)", () => {
  it.each([
    ["record_rsvp_confirmation_email", "public.record_rsvp_confirmation_email(uuid, uuid, text, text, text)"],
    ["get_rsvp_confirmation_email_context", "public.get_rsvp_confirmation_email_context(text)"],
  ])("%s: catalog grants", async (_name, signature) => {
    const rows = await sql<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
       from (values ('anon'), ('authenticated'), ('service_role')) as r (role) order by r.role`,
      [signature],
    );
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
    const publicGrant = await sql(
      `select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0`,
      [signature],
    );
    expect(publicGrant).toEqual([]);
    const [fn] = await sql<{ definer: boolean; config: string[] }>(
      "select prosecdef as definer, proconfig as config from pg_proc where oid = $1::regprocedure",
      [signature],
    );
    expect(fn).toEqual({ definer: true, config: ['search_path=""'] });
  });

  it("live calls: anon, owner, collaborator and outsider are all refused, even with every argument right", async () => {
    const party = await createParty("ownerA", weddingA, "Sin RPC", "rpc-conf@example.com");
    await answer(party, true);
    const args = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rpc-conf@example.com" };
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      expect((await record(actor, args)).error?.code, `record as ${actor}`).toBe(PERMISSION_DENIED);
      expect((await readContext(actor, party.hash)).error?.code, `context as ${actor}`).toBe(PERMISSION_DENIED);
    }
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_sent_at).toBeNull();
  });
});

// ------------------------------------------------------- narrow context read

describe("get_rsvp_confirmation_email_context: one live link, the minimum", () => {
  it("returns the party's ids, contact email and wedding name/date/city — nothing else", async () => {
    const party = await createParty("collabA", weddingA, "Contexto", "contexto@example.com");
    await answer(party, true);
    const { data, error } = await readContext("service", party.hash);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        wedding_id: weddingA,
        guest_invitation_id: party.id,
        contact_email: "contexto@example.com",
        wedding_name: "Boda Confirmación A",
        wedding_date: "2090-06-01",
        wedding_city: "Ciudad Ejemplo",
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("nota privada");
    expect(JSON.stringify(data)).not.toContain(party.hash);
  });

  it("no contact email → the row says so (null)", async () => {
    const party = await createParty("ownerA", weddingA, "Sin correo");
    const { data } = await readContext("service", party.hash);
    expect(data?.[0]?.contact_email).toBeNull();
  });

  it("unknown, revoked and expired links return nothing", async () => {
    expect((await readContext("service", newToken().hash)).data).toEqual([]);
    const revoked = await createParty("ownerA", weddingA, "Revocado", "rev@example.com");
    await sql("update public.guest_invitations set revoked_at = now() where id = $1", [revoked.id]);
    expect((await readContext("service", revoked.hash)).data).toEqual([]);
    const expired = await createParty("ownerB", weddingB, "Vencido", "venc@example.com");
    await sql("update public.weddings set wedding_date = '2000-01-01' where id = $1", [weddingB]);
    expect((await readContext("service", expired.hash)).data).toEqual([]);
    await sql("update public.weddings set wedding_date = null where id = $1", [weddingB]);
  });
});

// --------------------------------------------------------- narrow recorder

describe("record_rsvp_confirmation_email: narrow even for service_role", () => {
  it("records on the database clock and changes ONLY the confirmation columns", async () => {
    const party = await createParty("ownerA", weddingA, "Registro", "registro-conf@example.com");
    const providerId = randomUUID();
    await answer(party, false);
    await sql(
      `update public.guest_invitations set invitation_email_sent_at = now() - interval '1 day',
         invitation_email_sent_to = 'registro-conf@example.com', invitation_email_provider_id = 'msg_inv' where id = $1`,
      [party.id],
    );
    const publication = await sql("select * from public.wedding_publications where wedding_id = $1", [weddingA]);
    const wedding = await sql("select * from public.weddings where id = $1", [weddingA]);
    const before = await snapshot(party.id);
    const startedAt = (await sql<{ now: Date }>("select now()"))[0]!.now;

    const { data, error } = await record("service", {
      weddingId: weddingA,
      partyId: party.id,
      hash: party.hash,
      recipient: "registro-conf@example.com",
      providerId,
    });
    expect(error).toBeNull();

    const after = await snapshot(party.id);
    expect(new Date(data as string)).toEqual(after.party.rsvp_confirmation_email_sent_at);
    expect((after.party.rsvp_confirmation_email_sent_at as Date).getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(after.party.rsvp_confirmation_email_sent_to).toBe("registro-conf@example.com");
    expect(after.party.rsvp_confirmation_email_provider_id).toBe(providerId);
    // LB-18.1 (ADR-011): exactly one ledger row, same transaction and clock.
    expect(await emailDeliveriesFor(party.id)).toEqual([
      {
        wedding_id: weddingA,
        guest_invitation_id: party.id,
        kind: "rsvp_confirmation",
        provider_message_id: providerId,
        recipient: "registro-conf@example.com",
        accepted_at: after.party.rsvp_confirmation_email_sent_at,
      },
    ]);

    const strip = (p: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("rsvp_confirmation_email")));
    expect(strip(after.party)).toEqual(strip(before.party));
    expect(after.guests).toEqual(before.guests);
    expect(await sql("select * from public.wedding_publications where wedding_id = $1", [weddingA])).toEqual(publication);
    const weddingAfter = await sql("select * from public.weddings where id = $1", [weddingA]);
    expect(weddingAfter).toEqual(wedding);
  });

  it("a later confirmation replaces the latest one; the ledger keeps both sends (LB-18.1)", async () => {
    const party = await createParty("ownerA", weddingA, "Reemplazo", "reemplazo@example.com");
    const base = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "reemplazo@example.com" };
    const first = `msg_primero_${randomUUID()}`;
    const second = `msg_segundo_${randomUUID()}`;
    expect((await record("service", { ...base, providerId: first })).error).toBeNull();
    expect((await record("service", { ...base, providerId: second })).error).toBeNull();
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_provider_id).toBe(second);
    const ledger = await emailDeliveriesFor(party.id);
    expect(ledger.map((d) => [d.kind, d.provider_message_id, d.recipient])).toEqual([
      ["rsvp_confirmation", first, "reemplazo@example.com"],
      ["rsvp_confirmation", second, "reemplazo@example.com"],
    ]);
  });

  it("rejects the wrong wedding, another wedding's party, a made-up party, a different or missing recipient, a bad id", async () => {
    const party = await createParty("ownerA", weddingA, "Rechazos", "rechazos-conf@example.com");
    const other = await createParty("ownerB", weddingB, "Otra boda", "rechazos-conf@example.com");
    const base = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rechazos-conf@example.com" };
    const attempts: Array<[string, Parameters<typeof record>[1]]> = [
      ["wrong wedding", { ...base, weddingId: weddingB }],
      ["made-up wedding", { ...base, weddingId: "00000000-0000-4000-8000-000000000000" }],
      ["another wedding's party", { ...base, partyId: other.id }],
      ["made-up party", { ...base, partyId: "00000000-0000-4000-8000-000000000001" }],
      ["another party's link", { ...base, hash: other.hash }],
      ["unknown link", { ...base, hash: newToken().hash }],
      ["different recipient", { ...base, recipient: "otra@example.com" }],
      ["recipient case-changed", { ...base, recipient: "Rechazos-conf@example.com" }],
      ["provider id too long", { ...base, providerId: "a".repeat(201) }],
      ["provider id with spaces", { ...base, providerId: "id con espacios" }],
      ["provider id with a URL", { ...base, providerId: "https://x/rsvp/abc" }],
      ["empty provider id", { ...base, providerId: "" }],
    ];
    for (const [label, args] of attempts) {
      const { error } = await record("service", args);
      expect(error, label).not.toBeNull();
    }
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_sent_at).toBeNull();
    expect((await snapshot(other.id)).party.rsvp_confirmation_email_sent_at).toBeNull();
    // LB-18.1: a refused record leaves no ledger row.
    expect(await emailDeliveriesFor(party.id)).toEqual([]);
    expect(await emailDeliveriesFor(other.id)).toEqual([]);

    // Without a current contact email nothing can be recorded.
    await setEmail(weddingA, party.id, null);
    expect((await record("service", base)).error).not.toBeNull();
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_sent_at).toBeNull();
  });

  it("removing or changing the contact email keeps the last confirmation (where it actually went)", async () => {
    const party = await createParty("ownerA", weddingA, "Historial", "historial-conf@example.com");
    await answer(party, true);
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "historial-conf@example.com" });
    await setEmail(weddingA, party.id, "nuevo-conf@example.com");
    expect((await snapshot(party.id)).party.rsvp_confirmation_email_sent_to).toBe("historial-conf@example.com");
    await setEmail(weddingA, party.id, null);
    const after = await snapshot(party.id);
    expect(after.party.contact_email).toBeNull();
    expect(after.party.rsvp_confirmation_email_sent_to).toBe("historial-conf@example.com");
    // The link and the answers are untouched.
    expect(after.party.revoked_at).toBeNull();
    expect(after.guests.every((g) => (g as { attending: boolean }).attending === true)).toBe(true);
  });
});
