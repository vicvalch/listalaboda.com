import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  emailDeliveriesFor,
  serviceRole,
  shapedEnvelope,
  sql,
  users,
} from "./support";

// LB-18.1 (ADR-011): the email delivery ledger's own guarantees (identity,
// uniqueness, tenancy, privileges, deletion), exercised as real anon,
// authenticated and service_role callers. That each record function writes
// exactly one row is proven next to each recorder's own tests. The superuser
// connection only arranges fixtures and reads ground truth, except where a
// test proves the guard holds even for it.

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const IDENTITY_IMMUTABLE = "55000";

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

type Party = { id: string; hash: string; weddingId: string };

async function createParty(actor: TestUserKey, weddingId: string, label: string, contactEmail: string): Promise<Party> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const { data, error } = await as[actor].rpc("create_guest_invitation", {
    target_wedding_id: weddingId,
    party_label: label,
    invitation_token_hash: hash,
    invitation_token_ciphertext: shapedEnvelope(),
    guest_names: ["Invitada Uno"],
    party_contact_email: contactEmail,
  });
  if (error || !data) throw new Error(`create_guest_invitation failed: ${error?.message}`);
  return { id: data, hash, weddingId };
}

/** One recorded invitation email, through the real service_role-only record function. */
function recordInvitation(party: Party, recipient: string, providerId: string, actingUser: TestUserKey = "ownerA") {
  return serviceRole.rpc("record_guest_invitation_email", {
    target_wedding_id: party.weddingId,
    target_invitation_id: party.id,
    invitation_token_hash: party.hash,
    recipient,
    provider_message_id: providerId,
    acting_user_id: users[actingUser].id,
  });
}

/** A party with one recorded invitation email; returns its ledger row id. */
async function recordedParty(weddingId: string, label: string, actor: TestUserKey = "ownerA") {
  const email = `${label.toLowerCase().replace(/\W+/g, "-")}@example.com`;
  const party = await createParty(actor, weddingId, label, email);
  const providerId = `msg_${randomUUID()}`;
  const { error } = await recordInvitation(party, email, providerId, actor);
  if (error) throw new Error(`record failed: ${error.message}`);
  const [delivery] = await sql<{ id: string }>("select id from public.email_deliveries where guest_invitation_id = $1", [
    party.id,
  ]);
  return { party, email, providerId, deliveryId: delivery!.id };
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Ledger A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Ledger B");
});

describe("shape", () => {
  it("the kinds are exactly the four application emails", async () => {
    const rows = await sql<{ label: string }>(
      `select e.enumlabel as label from pg_enum e
       where e.enumtypid = 'public.email_delivery_kind'::regtype order by e.enumsortorder`,
    );
    expect(rows.map((r) => r.label)).toEqual([
      "guest_invitation",
      "rsvp_confirmation",
      "rsvp_reminder_manual",
      "rsvp_reminder_automatic",
    ]);
  });

  it("stores identity plus LB-18.2's delivery status: no payload, body, token or link columns", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'email_deliveries' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id",
      "wedding_id",
      "guest_invitation_id",
      "kind",
      "provider_message_id",
      "recipient",
      "accepted_at",
      "status",
      "status_event_at",
    ]);
  });
});

describe("uniqueness and tenancy", () => {
  it("a reused provider id fails the whole record: no metadata, no activity, no ledger row", async () => {
    const first = await recordedParty(weddingA, "Primero");
    const second = await createParty("ownerA", weddingA, "Segundo", "segundo@example.com");

    const { error } = await recordInvitation(second, "segundo@example.com", first.providerId);
    expect(error).not.toBeNull();
    // Uniform error; the provider id isn't echoed back.
    expect(error!.message).toBe("email_delivery_not_recorded");
    expect(JSON.stringify(error)).not.toContain(first.providerId);

    const [party] = await sql<{ at: Date | null; to: string | null; provider: string | null }>(
      `select invitation_email_sent_at as at, invitation_email_sent_to as to, invitation_email_provider_id as provider
       from public.guest_invitations where id = $1`,
      [second.id],
    );
    expect(party).toEqual({ at: null, to: null, provider: null });
    expect(
      await sql("select 1 from public.wedding_activity where guest_invitation_id = $1 and event_type = 'guest_invitation_email_sent'", [
        second.id,
      ]),
    ).toEqual([]);
    expect(await emailDeliveriesFor(second.id)).toEqual([]);
    // The first send is untouched.
    expect(await emailDeliveriesFor(first.party.id)).toHaveLength(1);
  });

  it("the unique constraint holds for direct inserts too", async () => {
    const { party, email, providerId } = await recordedParty(weddingA, "Directo");
    await expect(
      sql(
        `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient)
         values ($1, $2, 'rsvp_confirmation', $3, $4)`,
        [weddingA, party.id, providerId, email],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it("a party of another wedding (or a made-up one) is impossible, for every role", async () => {
    const other = await createParty("ownerB", weddingB, "Otra boda", "otra-boda@example.com");
    for (const [label, partyId] of [
      ["another wedding's party", other.id],
      ["made-up party", randomUUID()],
    ] as const) {
      await expect(
        sql(
          `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient)
           values ($1, $2, 'guest_invitation', $3, 'cruzado@example.com')`,
          [weddingA, partyId, `msg_${randomUUID()}`],
        ),
        label,
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    }
  });

  it("recipient and provider id follow the repository's storage invariants", async () => {
    const party = await createParty("ownerA", weddingA, "Invariantes", "invariantes@example.com");
    for (const [label, providerId, recipient] of [
      ["bad provider id", "id con espacios", "invariantes@example.com"],
      ["URL as provider id", "https://x/rsvp/abc", "invariantes@example.com"],
      ["bad recipient", `msg_${randomUUID()}`, "no valido"],
      ["recipient with a display name", `msg_${randomUUID()}`, "Ana <ana@example.com>"],
      ["uppercase domain", `msg_${randomUUID()}`, "ana@Example.com"],
    ] as const) {
      await expect(
        sql(
          `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient)
           values ($1, $2, 'guest_invitation', $3, $4)`,
          [weddingA, party.id, providerId, recipient],
        ),
        label,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});

describe("reads: wedding members only, never the provider id", () => {
  it("owners and collaborators read their wedding's rows; outsiders and other weddings see none", async () => {
    const { party, email, deliveryId } = await recordedParty(weddingA, "Lectura");
    const columns = "id, wedding_id, guest_invitation_id, kind, recipient, accepted_at";

    for (const actor of ["ownerA", "collabA"] as const) {
      const { data, error } = await as[actor].from("email_deliveries").select(columns).eq("guest_invitation_id", party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([
        expect.objectContaining({ id: deliveryId, wedding_id: weddingA, kind: "guest_invitation", recipient: email }),
      ]);
    }
    for (const actor of ["outsider", "ownerB"] as const) {
      const { data, error } = await as[actor].from("email_deliveries").select(columns).eq("guest_invitation_id", party.id);
      expect(error, actor).toBeNull();
      expect(data, actor).toEqual([]);
    }
  });

  it("anon has no access at all", async () => {
    const { party } = await recordedParty(weddingA, "Anonimo");
    const { data, error } = await as.anon.from("email_deliveries").select("id").eq("guest_invitation_id", party.id);
    expect(error?.code).toBe(PERMISSION_DENIED);
    expect(data).toBeNull();
  });

  it("no client can read the provider id, not even the owner", async () => {
    const { party } = await recordedParty(weddingA, "Sin id");
    for (const actor of ["ownerA", "collabA"] as const) {
      const { error } = await as[actor].from("email_deliveries").select("provider_message_id").eq("guest_invitation_id", party.id);
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
      const star = await as[actor].from("email_deliveries").select("*").eq("guest_invitation_id", party.id);
      expect(star.error?.code, actor).toBe(PERMISSION_DENIED);
    }
  });
});

describe("writes: no client role, ever", () => {
  it("authenticated (members included) and anon can't INSERT, UPDATE or DELETE", async () => {
    const { party, email, deliveryId } = await recordedParty(weddingA, "Escritura");
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      const inserted = await as[actor].from("email_deliveries").insert({
        wedding_id: weddingA,
        guest_invitation_id: party.id,
        kind: "guest_invitation",
        provider_message_id: `msg_${randomUUID()}`,
        recipient: email,
      });
      expect(inserted.error?.code, `${actor} insert`).toBe(PERMISSION_DENIED);

      const updated = await as[actor].from("email_deliveries").update({ recipient: "otra@example.com" }).eq("id", deliveryId);
      expect(updated.error?.code, `${actor} update`).toBe(PERMISSION_DENIED);

      const deleted = await as[actor].from("email_deliveries").delete().eq("id", deliveryId);
      expect(deleted.error?.code, `${actor} delete`).toBe(PERMISSION_DENIED);
    }
    expect(await emailDeliveriesFor(party.id)).toEqual([
      expect.objectContaining({ kind: "guest_invitation", recipient: email }),
    ]);
  });
});

describe("identity is immutable at the database boundary", () => {
  it("no identity column can change, even for the superuser", async () => {
    const { deliveryId, party } = await recordedParty(weddingA, "Inmutable");
    const sibling = await createParty("ownerA", weddingA, "Hermano", "hermano@example.com");
    const before = await emailDeliveriesFor(party.id);
    const changes: Array<[string, string, unknown[]]> = [
      ["id", "id = $2", [randomUUID()]],
      ["wedding_id", "wedding_id = $2", [weddingB]],
      ["guest_invitation_id", "guest_invitation_id = $2", [sibling.id]],
      ["kind", "kind = 'rsvp_confirmation'", []],
      ["provider_message_id", "provider_message_id = $2", [`msg_${randomUUID()}`]],
      ["recipient", "recipient = 'otra@example.com'", []],
      ["accepted_at", "accepted_at = accepted_at - interval '1 day'", []],
    ];
    for (const [column, assignment, params] of changes) {
      await expect(
        sql(`update public.email_deliveries set ${assignment} where id = $1`, [deliveryId, ...params]),
        column,
      ).rejects.toMatchObject({ code: IDENTITY_IMMUTABLE });
    }
    expect(await emailDeliveriesFor(party.id)).toEqual(before);
  });

  it("service_role can't change or delete a row either", async () => {
    const { deliveryId, party } = await recordedParty(weddingA, "Servicio");
    const before = await emailDeliveriesFor(party.id);

    const updated = await serviceRole.from("email_deliveries").update({ recipient: "otra@example.com" }).eq("id", deliveryId);
    expect(updated.error?.code).toBe(IDENTITY_IMMUTABLE);
    const rekind = await serviceRole.from("email_deliveries").update({ kind: "rsvp_reminder_manual" }).eq("id", deliveryId);
    expect(rekind.error?.code).toBe(IDENTITY_IMMUTABLE);
    const deleted = await serviceRole.from("email_deliveries").delete().eq("id", deliveryId);
    expect(deleted.error?.code).toBe(IDENTITY_IMMUTABLE);
    await expect(sql("delete from public.email_deliveries where id = $1", [deliveryId])).rejects.toMatchObject({
      code: IDENTITY_IMMUTABLE,
    });

    expect(await emailDeliveriesFor(party.id)).toEqual(before);
  });

  it("accepted_at is always the database clock, whatever an insert supplies", async () => {
    const party = await createParty("ownerA", weddingA, "Reloj", "reloj@example.com");
    const [row] = await sql<{ accepted_at: Date; now: Date }>(
      `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient, accepted_at)
       values ($1, $2, 'guest_invitation', $3, 'reloj@example.com', '2001-01-01T00:00:00Z')
       returning accepted_at, now() as now`,
      [weddingA, party.id, `msg_${randomUUID()}`],
    );
    expect(row!.accepted_at).toEqual(row!.now);
  });
});

describe("deletion follows the owning entities", () => {
  it("deleting the party (a member's normal delete) deletes its ledger rows, and only those", async () => {
    const doomed = await recordedParty(weddingA, "Borrado", "collabA");
    const kept = await recordedParty(weddingA, "Conservado");
    const deleted = await as.collabA.from("guest_invitations").delete().eq("id", doomed.party.id).select("id");
    expect(deleted.error).toBeNull();
    expect(deleted.data).toHaveLength(1);
    expect(await sql("select 1 from public.email_deliveries where id = $1", [doomed.deliveryId])).toEqual([]);
    expect(await emailDeliveriesFor(kept.party.id)).toHaveLength(1);
  });

  it("deleting the wedding deletes its ledger rows, and no other wedding's", async () => {
    const doomedWedding = await fixtureWedding("ownerA", "Boda Ledger Borrada");
    const doomed = await recordedParty(doomedWedding, "Boda borrada");
    const kept = await recordedParty(weddingA, "Otra boda sigue");
    await sql("delete from public.weddings where id = $1", [doomedWedding]);
    expect(await sql("select 1 from public.email_deliveries where wedding_id = $1", [doomedWedding])).toEqual([]);
    expect(await sql("select 1 from public.email_deliveries where id = $1", [doomed.deliveryId])).toEqual([]);
    expect(await emailDeliveriesFor(kept.party.id)).toHaveLength(1);
  });
});
