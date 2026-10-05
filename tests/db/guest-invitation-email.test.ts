import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  serviceRole,
  sql,
  shapedEnvelope,
} from "./support";

// LB-11: the party's contact email and its invitation-email send metadata,
// exercised as real anon and authenticated users through the Data API. The
// superuser connection only arranges fixtures and reads ground truth.

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

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

type Party = { id: string; hash: string };

async function createParty(
  actor: TestUserKey,
  weddingId: string,
  label: string,
  contactEmail?: string,
): Promise<Party> {
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

type Row = {
  contact_email: string | null;
  token_hash: string;
  token_issued_at: Date;
  revoked_at: Date | null;
  invitation_email_sent_at: Date | null;
  invitation_email_sent_to: string | null;
  invitation_email_provider_id: string | null;
};

async function row(partyId: string): Promise<Row> {
  const rows = await sql<Row>(
    `select contact_email, token_hash, token_issued_at, revoked_at, invitation_email_sent_at,
            invitation_email_sent_to, invitation_email_provider_id
     from public.guest_invitations where id = $1`,
    [partyId],
  );
  if (!rows[0]) throw new Error("party not found");
  return rows[0];
}

function setEmail(actor: keyof typeof as, weddingId: string, partyId: string, email: string | null) {
  return as[actor]
    .from("guest_invitations")
    .update({ contact_email: email })
    .eq("id", partyId)
    .eq("wedding_id", weddingId)
    .select("id");
}

/** `actor` "service" = the server-only recorder's role (ADR-004). */
function record(
  actor: keyof typeof as | "service",
  args: {
    weddingId: string;
    partyId: string;
    hash: string;
    recipient: string;
    providerId?: string;
  },
) {
  const client = actor === "service" ? serviceRole : as[actor];
  return client.rpc("record_guest_invitation_email", {
    target_wedding_id: args.weddingId,
    target_invitation_id: args.partyId,
    invitation_token_hash: args.hash,
    recipient: args.recipient,
    provider_message_id: args.providerId ?? "msg_0123456789",
  });
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Correo A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Correo B");
});

// ---------------------------------------------------------- contact email

describe("contact email: optional party data", () => {
  it("is optional: a party without one works exactly as before", async () => {
    const party = await createParty("ownerA", weddingA, "Sin correo");
    expect((await row(party.id)).contact_email).toBeNull();
    const { data } = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    expect(data).toHaveLength(2);
  });

  it("can be set when the party is created, atomically", async () => {
    const party = await createParty("collabA", weddingA, "Con correo", "familia@example.com");
    expect((await row(party.id)).contact_email).toBe("familia@example.com");

    // An invalid email fails the whole creation: no party, no guests.
    const { hash } = newToken();
    const { error } = await as.ownerA.rpc("create_guest_invitation", {
      target_wedding_id: weddingA,
      party_label: "Correo malo",
      invitation_token_hash: hash,
      invitation_token_ciphertext: shapedEnvelope(),
      guest_names: ["Uno"],
      party_contact_email: "no es un correo",
    });
    expect(error?.code).toBe(CHECK_VIOLATION);
    expect(await sql("select 1 from public.guest_invitations where token_hash = $1", [hash])).toEqual([]);
  });

  it("owners and collaborators set, change and remove it", async () => {
    const party = await createParty("ownerA", weddingA, "Editable");

    const byOwner = await setEmail("ownerA", weddingA, party.id, "Ana.Perez+boda@example.com");
    expect(byOwner.error).toBeNull();
    expect(byOwner.data).toHaveLength(1);
    // The local part keeps its case: only the domain is normalized.
    expect((await row(party.id)).contact_email).toBe("Ana.Perez+boda@example.com");

    const byCollaborator = await setEmail("collabA", weddingA, party.id, "otra@example.org");
    expect(byCollaborator.data).toHaveLength(1);
    expect((await row(party.id)).contact_email).toBe("otra@example.org");

    const read = await as.collabA.from("guest_invitations").select("contact_email").eq("id", party.id);
    expect(read.data).toEqual([{ contact_email: "otra@example.org" }]);

    const removed = await setEmail("collabA", weddingA, party.id, null);
    expect(removed.data).toHaveLength(1);
    expect((await row(party.id)).contact_email).toBeNull();
  });

  it("outsiders and other weddings' owners can't read or change it", async () => {
    const party = await createParty("ownerA", weddingA, "Privada", "privado@example.com");

    for (const actor of ["outsider", "ownerB"] as const) {
      const write = await setEmail(actor, weddingA, party.id, "intruso@example.com");
      expect(write.data ?? []).toEqual([]);
      const read = await as[actor].from("guest_invitations").select("contact_email").eq("id", party.id);
      expect(read.data ?? []).toEqual([]);
    }
    // Cross-wedding: an owner of B naming B as the wedding still can't reach A's party.
    const crossed = await setEmail("ownerB", weddingB, party.id, "intruso@example.com");
    expect(crossed.data ?? []).toEqual([]);
    expect((await row(party.id)).contact_email).toBe("privado@example.com");
  });

  it("anon has no access at all", async () => {
    const party = await createParty("ownerA", weddingA, "Anon", "anon@example.com");
    const read = await as.anon.from("guest_invitations").select("contact_email").eq("id", party.id);
    expect(read.error?.code).toBe(PERMISSION_DENIED);
    const write = await setEmail("anon", weddingA, party.id, "x@example.com");
    expect(write.error?.code).toBe(PERMISSION_DENIED);
  });

  it.each([
    ["no at sign", "familia.example.com"],
    ["no domain dot", "familia@example"],
    ["uppercase domain (not stored form)", "familia@Example.com"],
    ["leading space", " familia@example.com"],
    ["inner space", "fam ilia@example.com"],
    ["control character", "fami\u0007lia@example.com"],
    ["line break (header injection)", "familia@example.com\r\nBcc: x@example.com"],
    ["two at signs", "a@b@example.com"],
    ["local part over 64", `${"a".repeat(65)}@example.com`],
    ["over 254 characters", `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(10)}.com`],
    ["non-ASCII domain", "familia@pérez.com"],
    ["empty", ""],
  ])("rejects an invalid email: %s", async (_case, email) => {
    const party = await createParty("ownerA", weddingA, "Validación");
    const { error } = await setEmail("ownerA", weddingA, party.id, email);
    expect(error?.code).toBe(CHECK_VIOLATION);
    expect((await row(party.id)).contact_email).toBeNull();
  });

  it("is never returned by the guest or public functions", async () => {
    const party = await createParty("ownerA", weddingA, "Pública", "secreto-publico@example.com");
    const guest = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    expect(guest.data).toHaveLength(2);
    expect(JSON.stringify(guest.data)).not.toContain("secreto-publico");
    const slug = await as.anon.rpc("get_guest_invitation_site_slug", { invitation_token_hash: party.hash });
    expect(JSON.stringify(slug.data)).not.toContain("secreto-publico");
  });

  it("changing or removing it never rotates, revokes or touches answers", async () => {
    const party = await createParty("ownerA", weddingA, "Estable");
    const before = await row(party.id);

    await setEmail("collabA", weddingA, party.id, "estable@example.com");
    await setEmail("collabA", weddingA, party.id, null);

    const after = await row(party.id);
    expect(after.token_hash).toBe(before.token_hash);
    expect(after.token_issued_at).toEqual(before.token_issued_at);
    expect(after.revoked_at).toBeNull();
    const { data } = await as.anon.rpc("get_guest_invitation", { invitation_token_hash: party.hash });
    expect(data).toHaveLength(2);
  });

  it("is not unique: one address may receive several invitations", async () => {
    await createParty("ownerA", weddingA, "Repetido 1", "repetido@example.com");
    await createParty("ownerA", weddingA, "Repetido 2", "repetido@example.com");
    await createParty("ownerB", weddingB, "Repetido 3", "repetido@example.com");
  });
});

// ---------------------------------------------------------- send metadata

describe("send metadata: written only by record_guest_invitation_email, as service_role", () => {
  it("members can read it but never write it directly (no forging)", async () => {
    const party = await createParty("ownerA", weddingA, "Forja", "forja@example.com");
    for (const actor of ["ownerA", "collabA"] as const) {
      for (const patch of [
        { invitation_email_sent_at: new Date().toISOString() },
        { invitation_email_sent_to: "forja@example.com" },
        { invitation_email_provider_id: "forged" },
      ]) {
        const { error } = await as[actor].from("guest_invitations").update(patch).eq("id", party.id);
        expect(error?.code, JSON.stringify(patch)).toBe(PERMISSION_DENIED);
      }
    }
    const { hash } = newToken();
    const insert = await as.ownerA.from("guest_invitations").insert({
      wedding_id: weddingA,
      label: "Forja insert",
      token_hash: hash,
      invitation_email_sent_at: new Date().toISOString(),
      invitation_email_sent_to: "forja@example.com",
      invitation_email_provider_id: "forged",
    });
    expect(insert.error?.code).toBe(PERMISSION_DENIED);

    const read = await as.collabA
      .from("guest_invitations")
      .select("invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id")
      .eq("id", party.id);
    expect(read.data).toEqual([
      { invitation_email_sent_at: null, invitation_email_sent_to: null, invitation_email_provider_id: null },
    ]);
  });

  it("no client can call the recorder: anon and every member get permission denied (ADR-004)", async () => {
    const party = await createParty("ownerA", weddingA, "Sin forja RPC", "rpc@example.com");
    const args = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rpc@example.com" };
    // Even a member holding the CURRENT link, with every argument right, can't.
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      const { error } = await record(actor, args);
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
    }
    expect((await row(party.id)).invitation_email_sent_at).toBeNull();
  });

  it("service_role records a send, on the database clock, touching nothing else", async () => {
    const party = await createParty("collabA", weddingA, "Registro", "registro@example.com");
    const before = await row(party.id);
    const startedAt = (await sql<{ now: Date }>("select now()"))[0]!.now;

    const { data, error } = await record("service", {
      weddingId: weddingA,
      partyId: party.id,
      hash: party.hash,
      recipient: "registro@example.com",
      providerId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    });
    expect(error).toBeNull();
    const stored = await row(party.id);
    expect(new Date(data as string)).toEqual(stored.invitation_email_sent_at);
    expect(stored.invitation_email_sent_at!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(stored.invitation_email_sent_to).toBe("registro@example.com");
    expect(stored.invitation_email_provider_id).toBe("4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
    // Recording never touches the link or the guests.
    expect(stored.token_hash).toBe(before.token_hash);
    expect(stored.token_issued_at).toEqual(before.token_issued_at);
    expect(stored.revoked_at).toBeNull();
    expect(await sql("select 1 from public.guests where guest_invitation_id = $1", [party.id])).toHaveLength(2);
  });

  it("even for service_role it stays narrow: one party, its wedding, its current link and current email", async () => {
    const party = await createParty("ownerA", weddingA, "Rechazos", "rechazos@example.com");
    const other = await createParty("ownerB", weddingB, "Otra boda", "rechazos@example.com");
    const base = { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "rechazos@example.com" };

    const attempts: Array<[string, Parameters<typeof record>[1]]> = [
      ["unknown link", { ...base, hash: newToken().hash }],
      ["fabricated recipient", { ...base, recipient: "otra@example.com" }],
      ["party under another wedding", { ...base, weddingId: weddingB }],
      ["another wedding's party with this wedding", { ...base, partyId: other.id }],
      ["another party's link", { ...base, hash: other.hash }],
      ["provider id too long", { ...base, providerId: "a".repeat(201) }],
      ["provider id with spaces", { ...base, providerId: "id con espacios" }],
      ["provider id with a URL", { ...base, providerId: "https://x/rsvp/abc" }],
    ];
    for (const [label, args] of attempts) {
      const { error } = await record("service", args);
      expect(error, label).not.toBeNull();
    }
    expect((await row(party.id)).invitation_email_sent_at).toBeNull();
    expect((await row(other.id)).invitation_email_sent_at).toBeNull();

    // Removing the email means nothing can be recorded for it.
    await setEmail("ownerA", weddingA, party.id, null);
    expect((await record("service", base)).error).not.toBeNull();
    expect((await row(party.id)).invitation_email_sent_at).toBeNull();
  });

  it("removing the email keeps the last-sent status (it records where that email went)", async () => {
    const party = await createParty("ownerA", weddingA, "Historial", "historial@example.com");
    await record("service", { weddingId: weddingA, partyId: party.id, hash: party.hash, recipient: "historial@example.com" });
    await setEmail("ownerA", weddingA, party.id, null);
    const stored = await row(party.id);
    expect(stored.contact_email).toBeNull();
    expect(stored.invitation_email_sent_to).toBe("historial@example.com");
  });

  it("the three fields are set together or not at all, and sent_to is validated", async () => {
    const party = await createParty("ownerA", weddingA, "Completo");
    await expect(
      sql("update public.guest_invitations set invitation_email_sent_at = now() where id = $1", [party.id]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql(
        `update public.guest_invitations set invitation_email_sent_at = now(),
           invitation_email_sent_to = 'no valido', invitation_email_provider_id = 'x' where id = $1`,
        [party.id],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// ------------------------------------------------------ current-link check

describe("guest_invitation_link_is_current", () => {
  function check(actor: keyof typeof as, weddingId: string, partyId: string, hash: string) {
    return as[actor].rpc("guest_invitation_link_is_current", {
      target_wedding_id: weddingId,
      target_invitation_id: partyId,
      invitation_token_hash: hash,
    });
  }

  it("is true only for the party's current, usable link, and only for its members", async () => {
    const party = await createParty("ownerA", weddingA, "Vigente");
    expect((await check("collabA", weddingA, party.id, party.hash)).data).toBe(true);
    expect((await check("ownerA", weddingA, party.id, newToken().hash)).data).toBe(false);
    expect((await check("outsider", weddingA, party.id, party.hash)).data).toBe(false);
    expect((await check("ownerB", weddingB, party.id, party.hash)).data).toBe(false);

    // Rotation (owner-only, LB-09) makes the old link stale.
    const fresh = newToken();
    const rotated = await as.ownerA.rpc("rotate_guest_invitation_link", {
      target_wedding_id: weddingA,
      target_invitation_id: party.id,
      invitation_token_hash: fresh.hash,
      invitation_token_ciphertext: shapedEnvelope(),
    });
    expect(rotated.error).toBeNull();
    expect(rotated.data).toBe(true);
    expect((await check("ownerA", weddingA, party.id, party.hash)).data).toBe(false);
    expect((await check("ownerA", weddingA, party.id, fresh.hash)).data).toBe(true);

    // Revoked links are never current.
    await as.ownerA.from("guest_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", party.id);
    expect((await check("ownerA", weddingA, party.id, fresh.hash)).data).toBe(false);
  });

  it("anon can't call it", async () => {
    const party = await createParty("ownerA", weddingA, "Anon vigente");
    expect((await check("anon", weddingA, party.id, party.hash)).error?.code).toBe(PERMISSION_DENIED);
  });

  it("link rotation and revocation stay owner-only", async () => {
    const party = await createParty("ownerA", weddingA, "Solo dueños", "solo@example.com");
    const rotate = await as.collabA.rpc("rotate_guest_invitation_link", {
      target_wedding_id: weddingA,
      target_invitation_id: party.id,
      invitation_token_hash: newToken().hash,
      invitation_token_ciphertext: shapedEnvelope(),
    });
    expect(rotate.error?.code).toBe(PERMISSION_DENIED);
    expect(rotate.error?.message).toBe("guest_link_owner_only");
    const revoke = await as.collabA
      .from("guest_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", party.id);
    expect(revoke.error?.code).toBe(PERMISSION_DENIED);
    const stored = await row(party.id);
    expect(stored.token_hash).toBe(party.hash);
    expect(stored.revoked_at).toBeNull();
  });
});
