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

// LB-14 (ADR-007): the RSVP reminder's database boundary, exercised as real
// anon, authenticated and service_role callers through the Data API. The
// superuser connection only arranges fixtures and reads ground truth.

const CHECK_VIOLATION = "23514";
const REMINDER_COLUMNS = [
  "rsvp_reminder_email_provider_id",
  "rsvp_reminder_email_sent_at",
  "rsvp_reminder_email_sent_to",
];
const SIGNATURE = "public.record_rsvp_reminder_email(uuid, uuid, text, text, text)";
const SECRETS = "private.guest_invitation_capability_secrets";

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
  return client(actor).rpc("record_rsvp_reminder_email", {
    target_wedding_id: args.weddingId,
    target_invitation_id: args.partyId,
    invitation_token_hash: args.hash,
    recipient: args.recipient,
    provider_message_id: args.providerId ?? "msg_reminder_0123",
  });
}

/** Everything the reminder must never touch, plus its own columns. */
async function snapshot(partyId: string) {
  const [party] = await sql<Record<string, unknown>>("select * from public.guest_invitations where id = $1", [partyId]);
  const guests = await sql(
    `select g.id, g.name, g.updated_at, r.attending, r.dietary_note, r.updated_at as rsvp_updated_at
     from public.guests g left join public.rsvps r on r.guest_id = g.id
     where g.guest_invitation_id = $1 order by g.created_at`,
    [partyId],
  );
  const secrets = await sql(`select * from ${SECRETS} where guest_invitation_id = $1`, [partyId]);
  return { party: party!, guests, secrets };
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Recordatorio A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Recordatorio B");
  await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad Ejemplo' where id = $1", [weddingA]);
});

// ----------------------------------------------------------------- schema

describe("schema: reminder metadata lives on the party only", () => {
  it("the three columns exist on guest_invitations and nowhere else; no phone/WhatsApp model", async () => {
    const rows = await sql<{ name: string }>(
      `select table_name || '.' || column_name as name from information_schema.columns
       where table_schema = 'public' and column_name like 'rsvp_reminder_email%' order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(REMINDER_COLUMNS.map((c) => `guest_invitations.${c}`));
    const phone = await sql(
      `select 1 from information_schema.columns where table_schema in ('public', 'private')
       and (column_name ilike '%phone%' or column_name ilike '%whatsapp%' or column_name ilike '%country_code%')`,
    );
    expect(phone).toEqual([]);
  });

  it("the three fields are set together or not at all; sent_to and provider id are validated", async () => {
    const party = await createParty("ownerA", weddingA, "Completo");
    await expect(
      sql("update public.guest_invitations set rsvp_reminder_email_sent_at = now() where id = $1", [party.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql(
        `update public.guest_invitations set rsvp_reminder_email_sent_at = now(),
           rsvp_reminder_email_sent_to = 'no valido', rsvp_reminder_email_provider_id = 'x' where id = $1`,
        [party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql(
        `update public.guest_invitations set rsvp_reminder_email_sent_at = now(),
           rsvp_reminder_email_sent_to = 'a@example.com', rsvp_reminder_email_provider_id = 'con espacios' where id = $1`,
        [party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// ---------------------------------------------------------------- privacy

describe("privacy: reminder metadata is members-only", () => {
  it("anon can't read it", async () => {
    const party = await createParty("ownerA", weddingA, "Anon", "anon-rec@example.com");
    const read = await as.anon.from("guest_invitations").select("rsvp_reminder_email_sent_to").eq("id", party.id);
    expect(read.error?.code).toBe(PERMISSION_DENIED);
  });

  it("members read it; outsiders and other weddings' owners see nothing", async () => {
    const party = await createParty("ownerA", weddingA, "Lectura", "lectura-rec@example.com");
    expect((await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "lectura-rec@example.com" })).error).toBeNull();
    for (const actor of ["ownerA", "collabA"] as const) {
      const { data } = await as[actor].from("guest_invitations").select("rsvp_reminder_email_sent_to").eq("id", party.id);
      expect(data, actor).toEqual([{ rsvp_reminder_email_sent_to: "lectura-rec@example.com" }]);
    }
    for (const actor of ["outsider", "ownerB"] as const) {
      const { data } = await as[actor].from("guest_invitations").select("rsvp_reminder_email_sent_to").eq("id", party.id);
      expect(data, actor).toEqual([]);
    }
  });

  it("guest and public functions never return it", async () => {
    const party = await createParty("ownerA", weddingA, "Funciones", "funciones-rec@example.com");
    await record("service", {
      weddingId: weddingA,
      partyId: party.id,
      hash: party.hash,
      recipient: "funciones-rec@example.com",
      providerId: "msg_secreto_rec",
    });
    const results = [
      await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash }),
      await as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: party.hash }),
    ];
    for (const { data, error } of results) {
      expect(error).toBeNull();
      const body = JSON.stringify(data);
      expect(body).not.toContain("funciones-rec@example.com");
      expect(body).not.toContain("msg_secreto_rec");
      expect(body).not.toContain("reminder");
    }
  });
});

// ----------------------------------------------------------- client writes

describe("no client can forge the reminder status", () => {
  it("owners and collaborators can't write the columns directly", async () => {
    const party = await createParty("ownerA", weddingA, "Forja", "forja-rec@example.com");
    for (const actor of ["ownerA", "collabA"] as const) {
      for (const patch of [
        { rsvp_reminder_email_sent_at: new Date().toISOString() },
        { rsvp_reminder_email_sent_to: "forja-rec@example.com" },
        { rsvp_reminder_email_provider_id: "forged" },
        {
          rsvp_reminder_email_sent_at: new Date().toISOString(),
          rsvp_reminder_email_sent_to: "forja-rec@example.com",
          rsvp_reminder_email_provider_id: "forged",
        },
      ]) {
        const { error } = await as[actor].from("guest_invitations").update(patch).eq("id", party.id);
        expect(error?.code, `${actor} ${JSON.stringify(patch)}`).toBe(PERMISSION_DENIED);
      }
    }
    expect((await snapshot(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("no column privilege on the reminder columns except SELECT for authenticated", async () => {
    const rows = await sql<{ grantee: string; privilege_type: string; column_name: string }>(
      `select grantee, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'guest_invitations'
         and column_name like 'rsvp_reminder_email%' and grantee in ('anon', 'authenticated', 'PUBLIC')
       order by grantee, privilege_type, column_name`,
    );
    expect(rows).toEqual(
      REMINDER_COLUMNS.map((column_name) => ({ grantee: "authenticated", privilege_type: "SELECT", column_name })),
    );
  });
});

// ------------------------------------------------------------------ grants

describe("only service_role can execute record_rsvp_reminder_email (ADR-007)", () => {
  it("catalog: PUBLIC, anon and authenticated can't; service_role can; definer with empty search_path", async () => {
    const rows = await sql<{ role: string; can: boolean }>(
      `select r.role, has_function_privilege(r.role, $1::regprocedure, 'execute') as can
       from (values ('anon'), ('authenticated'), ('service_role')) as r (role) order by r.role`,
      [SIGNATURE],
    );
    expect(rows).toEqual([
      { role: "anon", can: false },
      { role: "authenticated", can: false },
      { role: "service_role", can: true },
    ]);
    const publicGrant = await sql(
      `select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = $1::regprocedure and a.grantee = 0`,
      [SIGNATURE],
    );
    expect(publicGrant).toEqual([]);
    const [fn] = await sql<{ definer: boolean; config: string[] }>(
      "select prosecdef as definer, proconfig as config from pg_proc where oid = $1::regprocedure",
      [SIGNATURE],
    );
    expect(fn).toEqual({ definer: true, config: ['search_path=""'] });
  });

  it("live calls: anon, owner, collaborator and outsider are all refused, even with every argument right", async () => {
    const party = await createParty("ownerA", weddingA, "Sin RPC", "rpc-rec@example.com");
    const args = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rpc-rec@example.com" };
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      expect((await record(actor, args)).error?.code, `record as ${actor}`).toBe(PERMISSION_DENIED);
    }
    expect((await snapshot(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });
});

// --------------------------------------------------------- narrow recorder

describe("record_rsvp_reminder_email: narrow even for service_role", () => {
  it("records on the database clock and changes ONLY the three reminder columns", async () => {
    const party = await createParty("ownerA", weddingA, "Registro", "registro-rec@example.com");
    await answer(party, false);
    await sql(
      `update public.guest_invitations set invitation_email_sent_at = now() - interval '2 day',
         invitation_email_sent_to = 'registro-rec@example.com', invitation_email_provider_id = 'msg_inv',
         rsvp_confirmation_email_sent_at = now() - interval '1 day',
         rsvp_confirmation_email_sent_to = 'registro-rec@example.com', rsvp_confirmation_email_provider_id = 'msg_conf'
       where id = $1`,
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
      recipient: "registro-rec@example.com",
      providerId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    });
    expect(error).toBeNull();

    const after = await snapshot(party.id);
    expect(new Date(data as string)).toEqual(after.party.rsvp_reminder_email_sent_at);
    expect((after.party.rsvp_reminder_email_sent_at as Date).getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(after.party.rsvp_reminder_email_sent_to).toBe("registro-rec@example.com");
    expect(after.party.rsvp_reminder_email_provider_id).toBe("4ef9a417-02e9-4d39-ad75-9611e0fcc33c");

    // Token hash, issue time, revocation, contact, invitation and
    // confirmation metadata: unchanged (updated_at is the row trigger's).
    const strip = (p: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("rsvp_reminder_email") && k !== "updated_at"));
    expect(strip(after.party)).toEqual(strip(before.party));
    expect(after.guests).toEqual(before.guests);
    expect(after.secrets).toEqual(before.secrets);
    expect(await sql("select * from public.wedding_publications where wedding_id = $1", [weddingA])).toEqual(publication);
    expect(await sql("select * from public.weddings where id = $1", [weddingA])).toEqual(wedding);
  });

  it("a later reminder replaces the latest one (no history)", async () => {
    const party = await createParty("ownerA", weddingA, "Reemplazo", "reemplazo-rec@example.com");
    const base = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "reemplazo-rec@example.com" };
    expect((await record("service", { ...base, providerId: "msg_primero" })).error).toBeNull();
    expect((await record("service", { ...base, providerId: "msg_segundo" })).error).toBeNull();
    expect((await snapshot(party.id)).party.rsvp_reminder_email_provider_id).toBe("msg_segundo");
  });

  it("rejects the wrong wedding, another wedding's party, an unknown party, a wrong or missing recipient, a bad id", async () => {
    const party = await createParty("ownerA", weddingA, "Rechazos", "rechazos-rec@example.com");
    const other = await createParty("ownerB", weddingB, "Otra boda", "rechazos-rec@example.com");
    const base = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rechazos-rec@example.com" };
    const attempts: Array<[string, Parameters<typeof record>[1]]> = [
      ["wrong wedding", { ...base, weddingId: weddingB }],
      ["made-up wedding", { ...base, weddingId: "00000000-0000-4000-8000-000000000000" }],
      ["another wedding's party", { ...base, partyId: other.id }],
      ["another wedding's party with its own hash", { ...base, partyId: other.id, hash: other.hash }],
      ["unknown party", { ...base, partyId: "00000000-0000-4000-8000-000000000001" }],
      ["another party's link", { ...base, hash: other.hash }],
      ["unknown link", { ...base, hash: newToken().hash }],
      ["different recipient", { ...base, recipient: "otra@example.com" }],
      ["recipient case-changed", { ...base, recipient: "Rechazos-rec@example.com" }],
      ["provider id too long", { ...base, providerId: "a".repeat(201) }],
      ["provider id with spaces", { ...base, providerId: "id con espacios" }],
      ["provider id with a URL", { ...base, providerId: "https://x/rsvp/abc" }],
      ["empty provider id", { ...base, providerId: "" }],
    ];
    for (const [label, args] of attempts) {
      const { error } = await record("service", args);
      expect(error, label).not.toBeNull();
    }
    expect((await snapshot(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
    expect((await snapshot(other.id)).party.rsvp_reminder_email_sent_at).toBeNull();

    // Without a current contact email nothing can be recorded.
    await setEmail(weddingA, party.id, null);
    expect((await record("service", { ...base })).error).not.toBeNull();
    expect((await snapshot(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("a rotated, revoked or expired link can't be recorded as reminded", async () => {
    const rotated = await createParty("ownerA", weddingA, "Rotado", "rotado-rec@example.com");
    const fresh = newToken();
    const rotation = await as.ownerA.rpc("rotate_guest_invitation_link", {
      target_wedding_id: weddingA,
      target_invitation_id: rotated.id,
      invitation_token_hash: fresh.hash,
      invitation_token_ciphertext: shapedEnvelope(),
    });
    expect(rotation.data).toBe(true);
    const oldLink = { weddingId: weddingA, partyId: rotated.id, hash: rotated.hash, recipient: "rotado-rec@example.com" };
    expect((await record("service", oldLink)).error, "stale hash").not.toBeNull();
    expect((await record("service", { ...oldLink, hash: fresh.hash })).error, "current hash").toBeNull();

    const revoked = await createParty("ownerA", weddingA, "Revocado", "revocado-rec@example.com");
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", revoked.id);
    expect(
      (await record("service", { weddingId: weddingA, partyId: revoked.id, hash: revoked.hash, recipient: "revocado-rec@example.com" })).error,
      "revoked",
    ).not.toBeNull();
    expect((await snapshot(revoked.id)).party.rsvp_reminder_email_sent_at).toBeNull();

    const expired = await createParty("ownerB", weddingB, "Vencido", "vencido-rec@example.com");
    await sql("update public.weddings set wedding_date = '2000-01-01' where id = $1", [weddingB]);
    expect(
      (await record("service", { weddingId: weddingB, partyId: expired.id, hash: expired.hash, recipient: "vencido-rec@example.com" })).error,
      "expired",
    ).not.toBeNull();
    await sql("update public.weddings set wedding_date = null where id = $1", [weddingB]);
    expect((await snapshot(expired.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("changing or removing the contact email keeps the last reminder (where it actually went)", async () => {
    const party = await createParty("ownerA", weddingA, "Historial", "historial-rec@example.com");
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "historial-rec@example.com" });
    await setEmail(weddingA, party.id, "nuevo-rec@example.com");
    expect((await snapshot(party.id)).party.rsvp_reminder_email_sent_to).toBe("historial-rec@example.com");
    await setEmail(weddingA, party.id, null);
    const after = await snapshot(party.id);
    expect(after.party.contact_email).toBeNull();
    expect(after.party.rsvp_reminder_email_sent_to).toBe("historial-rec@example.com");
    expect(after.party.revoked_at).toBeNull();
  });

  it("is separate from the invitation and confirmation records", async () => {
    const party = await createParty("ownerA", weddingA, "Separado", "separado-rec@example.com");
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "separado-rec@example.com" });
    const after = (await snapshot(party.id)).party;
    expect(after.rsvp_reminder_email_sent_at).not.toBeNull();
    expect(after.invitation_email_sent_at).toBeNull();
    expect(after.rsvp_confirmation_email_sent_at).toBeNull();
  });
});
