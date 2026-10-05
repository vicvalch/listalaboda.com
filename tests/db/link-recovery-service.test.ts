import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));

const { createGuestParty, revokeGuestPartyLink, rotateGuestPartyLink } = await import("@/lib/guests/service");
const { recoverGuestPartyLink } = await import("@/lib/guests/link-recovery");
const { sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");
const { getGuestPartyByToken } = await import("@/lib/rsvp/service");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");

// LB-13 (ADR-006) end to end through the services the Server Actions call,
// against the real local stack: the link a party gets at creation can be
// recovered later — from the persisted envelope alone, in a fresh request —
// and is EXACTLY the same capability. Keys are fake, test-only values.
// Failures of recovery never touch the guest's link.

const APP_ORIGIN = "http://localhost:3100";
const RSVP_URL = /^http:\/\/localhost:3100\/rsvp\/([A-Za-z0-9_-]{43})$/;
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const CONFIG = { appOrigin: APP_ORIGIN, encryption: ENCRYPTION };
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

/** A brand-new client per call: nothing survives between "requests". */
async function sessionClient(user: TestUserKey) {
  const supabase = createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.setSession({
    access_token: users[user].accessToken,
    refresh_token: users[user].refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return supabase;
}

function anonClient() {
  return createClient<Database>(ctx.apiUrl, ctx.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function tokenOf(link: string): string {
  const token = RSVP_URL.exec(link)?.[1];
  if (!token) throw new Error("unexpected link shape (value redacted)");
  return token;
}

/**
 * Creates a party in one "request" and returns only what an organizer
 * could have copied from the screen: its id and the link string.
 */
async function createdInAnEarlierRequest(user: TestUserKey, weddingId: string, label: string, contactEmail?: string) {
  const result = await createGuestParty(
    await sessionClient(user),
    weddingId,
    { label, guestNames: ["Invitada Uno", "Invitado Dos"], ...(contactEmail ? { contactEmail } : {}) },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  return { guestInvitationId: result.guestInvitationId, originalLink: result.link };
}

async function recover(user: TestUserKey, weddingId: string, partyId: string, config = CONFIG) {
  return recoverGuestPartyLink(await sessionClient(user), weddingId, partyId, config);
}

async function storedState(partyId: string) {
  const [link] = await sql<{ token_hash: string; token_issued_at: Date; revoked_at: Date | null }>(
    "select token_hash, token_issued_at, revoked_at from public.guest_invitations where id = $1",
    [partyId],
  );
  const [secret] = await sql<{ token_hash: string; token_ciphertext: string; updated_at: Date }>(
    `select token_hash, token_ciphertext, updated_at from ${SECRETS} where guest_invitation_id = $1`,
    [partyId],
  );
  return { link, secret };
}

async function guestLinkWorks(link: string): Promise<boolean> {
  return (await getGuestPartyByToken(anonClient(), tokenOf(link))).ok;
}

type FakeSender = EmailSender & { sent: OutgoingEmail[] };

function fakeSender(): FakeSender {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
      return { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
}

function delivery(sender: EmailSender) {
  const recorder: DeliveryRecorder = createDeliveryRecorder({
    supabaseUrl: ctx.apiUrl,
    serviceRoleKey: ctx.secretKey,
  });
  return { sender, appOrigin: APP_ORIGIN, recorder };
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda recuperar enlace");
  weddingB = await fixtureWedding("ownerB", "Boda recuperar enlace B");
  await addMember(weddingA, "collabA", "collaborator");
  await sql("update public.weddings set wedding_date = '2090-06-01' where id = any($1::uuid[])", [
    [weddingA, weddingB],
  ]);
});

describe("same-link recovery (central LB-13 proof)", () => {
  it("the link recovered later is EXACTLY the link created, for owners and collaborators", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("collabA", weddingA, "Familia Igual");
    // Later, fresh requests: no React state, no creation memory, no fresh-link panel.
    for (const user of ["ownerA", "collabA"] as const) {
      expect(await recover(user, weddingA, guestInvitationId), user).toEqual({ ok: true, link: originalLink });
    }
    // And it is the working capability.
    expect(await guestLinkWorks(originalLink)).toBe(true);
    // Recovering again doesn't change anything (no rotation, no rewrite).
    const before = await storedState(guestInvitationId);
    expect(await recover("ownerA", weddingA, guestInvitationId)).toEqual({ ok: true, link: originalLink });
    expect(await storedState(guestInvitationId)).toEqual(before);
  });

  it("the plaintext token is not stored anywhere: only its hash and its envelope", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Sin texto plano");
    const token = tokenOf(originalLink);
    const dump = JSON.stringify(
      await sql(
        `select i.*, s.* from public.guest_invitations i
         left join ${SECRETS} s on s.guest_invitation_id = i.id where i.id = $1`,
        [guestInvitationId],
      ),
    );
    expect(dump).not.toContain(token);
  });

  it("outsiders, anon and other weddings can't recover", async () => {
    const { guestInvitationId } = await createdInAnEarlierRequest("ownerA", weddingA, "Privada");
    expect(await recover("outsider", weddingA, guestInvitationId)).toEqual({ ok: false, reason: "not_found" });
    expect(await recover("ownerB", weddingA, guestInvitationId)).toEqual({ ok: false, reason: "not_found" });
    expect(await recover("ownerB", weddingB, guestInvitationId)).toEqual({ ok: false, reason: "invalid_target" });
    expect(await recoverGuestPartyLink(anonClient(), weddingA, guestInvitationId, CONFIG)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });

  it("a revoked link is never handed out", async () => {
    const { guestInvitationId } = await createdInAnEarlierRequest("ownerA", weddingA, "Revocada");
    expect(await revokeGuestPartyLink(await sessionClient("ownerA"), weddingA, guestInvitationId)).toEqual({ ok: true });
    expect(await recover("collabA", weddingA, guestInvitationId)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("rotation", () => {
  it("old link dies, new link works, and recovery returns exactly the NEW link", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Rotada");
    const rotated = await rotateGuestPartyLink(
      await sessionClient("ownerA"),
      weddingA,
      guestInvitationId,
      APP_ORIGIN,
      ENCRYPTION,
    );
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(rotated.link).not.toBe(originalLink);
    expect(await guestLinkWorks(originalLink)).toBe(false);
    expect(await guestLinkWorks(rotated.link)).toBe(true);
    expect(await recover("collabA", weddingA, guestInvitationId)).toEqual({ ok: true, link: rotated.link });
  });

  it("collaborators recover but can't rotate", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Solo dueños");
    expect(
      await rotateGuestPartyLink(await sessionClient("collabA"), weddingA, guestInvitationId, APP_ORIGIN, ENCRYPTION),
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(await recover("collabA", weddingA, guestInvitationId)).toEqual({ ok: true, link: originalLink });
  });

  it("without the key, creating and rotating write nothing; the old link stays current", async () => {
    const supabase = await sessionClient("ownerA");
    const countBefore = await sql("select 1 from public.guest_invitations where wedding_id = $1", [weddingA]);
    expect(
      await createGuestParty(supabase, weddingA, { label: "Sin llave", guestNames: ["X"] }, APP_ORIGIN, null),
    ).toEqual({ ok: false, reason: "configuration_error" });
    expect(await sql("select 1 from public.guest_invitations where wedding_id = $1", [weddingA])).toHaveLength(
      countBefore.length,
    );

    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Sin rotar");
    const before = await storedState(guestInvitationId);
    expect(await rotateGuestPartyLink(supabase, weddingA, guestInvitationId, APP_ORIGIN, null)).toEqual({
      ok: false,
      reason: "configuration_error",
    });
    expect(await storedState(guestInvitationId)).toEqual(before);
    expect(await guestLinkWorks(originalLink)).toBe(true);
  });
});

describe("recovery failures never touch the guest's link", () => {
  it("a different server key: `unrecoverable`, nothing rotated/revoked/rewritten, the guest link still works", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Otra llave");
    const before = await storedState(guestInvitationId);
    const result = await recover("ownerA", weddingA, guestInvitationId, {
      appOrigin: APP_ORIGIN,
      encryption: { key: WRONG_TEST_RSVP_CAPABILITY_KEY },
    });
    expect(result).toEqual({ ok: false, reason: "unrecoverable" });
    expect(JSON.stringify(result)).not.toMatch(/tag|auth|cipher|decrypt|key/i);
    expect(await storedState(guestInvitationId)).toEqual(before);
    // Validation is the hash, independent of the key.
    expect(await guestLinkWorks(originalLink)).toBe(true);
    // With the right key it is still recoverable.
    expect(await recover("ownerA", weddingA, guestInvitationId)).toEqual({ ok: true, link: originalLink });
  });

  it("a tampered envelope: `unrecoverable`, and the guest link still works", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Manipulada");
    const { secret } = await storedState(guestInvitationId);
    const parts = secret!.token_ciphertext.split(".");
    const ct = Buffer.from(parts[2]!, "base64url");
    ct[0] = ct[0]! ^ 0x01;
    parts[2] = ct.toString("base64url");
    // Controlled fixture: a privileged write keeping the v1 shape.
    await sql(`update ${SECRETS} set token_ciphertext = $2 where guest_invitation_id = $1`, [
      guestInvitationId,
      parts.join("."),
    ]);
    expect(await recover("collabA", weddingA, guestInvitationId)).toEqual({ ok: false, reason: "unrecoverable" });
    expect(await guestLinkWorks(originalLink)).toBe(true);
    // The link's hash never moved.
    expect((await storedState(guestInvitationId)).link?.token_hash).toBe(
      createHash("sha256").update(tokenOf(originalLink), "utf8").digest("hex"),
    );
  });

  it("an envelope swapped in from another party: `unrecoverable`", async () => {
    const mine = await createdInAnEarlierRequest("ownerA", weddingA, "Mía");
    const theirs = await createdInAnEarlierRequest("ownerA", weddingA, "Suya");
    const { secret } = await storedState(theirs.guestInvitationId);
    await sql(`update ${SECRETS} set token_ciphertext = $2 where guest_invitation_id = $1`, [
      mine.guestInvitationId,
      secret!.token_ciphertext,
    ]);
    expect(await recover("ownerA", weddingA, mine.guestInvitationId)).toEqual({ ok: false, reason: "unrecoverable" });
    expect(await guestLinkWorks(mine.originalLink)).toBe(true);
  });
});

describe("legacy (pre-LB-13) links", () => {
  it("keep working for guests, can't be recovered, and become recoverable only by an owner's rotation", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest("ownerA", weddingA, "Legado");
    await sql(`delete from ${SECRETS} where guest_invitation_id = $1`, [guestInvitationId]);
    const before = await storedState(guestInvitationId);

    for (const user of ["ownerA", "collabA"] as const) {
      expect(await recover(user, weddingA, guestInvitationId), user).toEqual({ ok: false, reason: "legacy" });
    }
    // No silent mutation: still the same hash-only link, still working.
    expect(await storedState(guestInvitationId)).toEqual(before);
    expect(await guestLinkWorks(originalLink)).toBe(true);
    // A collaborator can't repair it.
    expect(
      await rotateGuestPartyLink(await sessionClient("collabA"), weddingA, guestInvitationId, APP_ORIGIN, ENCRYPTION),
    ).toEqual({ ok: false, reason: "forbidden" });

    const rotated = await rotateGuestPartyLink(
      await sessionClient("ownerA"),
      weddingA,
      guestInvitationId,
      APP_ORIGIN,
      ENCRYPTION,
    );
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(await guestLinkWorks(originalLink)).toBe(false);
    expect(await guestLinkWorks(rotated.link)).toBe(true);
    expect(await recover("collabA", weddingA, guestInvitationId)).toEqual({ ok: true, link: rotated.link });
  });
});

describe("email regressions", () => {
  it("the invitation email carries the party's current link, and recovery later returns that same link", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest(
      "collabA",
      weddingA,
      "Con correo",
      "recupera@example.com",
    );
    const sender = fakeSender();
    const outcome = await sendGuestInvitationEmail(
      await sessionClient("collabA"),
      weddingA,
      guestInvitationId,
      tokenOf(originalLink),
      delivery(sender),
    );
    expect(outcome).toMatchObject({ outcome: "sent" });
    const emailed = /Confirmar asistencia: (\S+)/.exec(sender.sent[0]!.text)?.[1];
    expect(emailed).toBe(originalLink);
    // Sending didn't create another token.
    expect(await recover("ownerA", weddingA, guestInvitationId)).toEqual({ ok: true, link: originalLink });
  });

  it("the RSVP confirmation email still carries no capability", async () => {
    const { guestInvitationId, originalLink } = await createdInAnEarlierRequest(
      "ownerA",
      weddingA,
      "Confirma",
      "confirma@example.com",
    );
    const guestIds = (
      await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1 order by created_at, id", [
        guestInvitationId,
      ])
    ).map((g) => g.id);
    const sender = fakeSender();
    const result = await submitRsvpWithConfirmation(
      anonClient(),
      tokenOf(originalLink),
      guestIds.map((guestId) => ({ guestId, attending: true, dietaryNote: null })),
      () => delivery(sender),
    );
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    const email = sender.sent[0]!;
    const { secret } = await storedState(guestInvitationId);
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("/rsvp/");
      expect(part).not.toContain(tokenOf(originalLink));
      expect(part).not.toContain(secret!.token_ciphertext);
      expect(part).not.toContain(secret!.token_hash);
    }
  });
});
