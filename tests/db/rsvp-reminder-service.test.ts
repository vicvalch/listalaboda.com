import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));

const { createGuestParty, revokeGuestPartyLink, rotateGuestPartyLink, updateGuestPartyContactEmail } = await import(
  "@/lib/guests/service"
);
const { recoverGuestPartyLink } = await import("@/lib/guests/link-recovery");
const { prepareRsvpReminderMessage, sendRsvpReminderEmail } = await import("@/lib/guests/rsvp-reminder");
const { getGuestPartyByToken } = await import("@/lib/rsvp/service");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");

// LB-14 (ADR-007) end to end through the services the Server Actions call,
// against the real local stack: a reminder carries the party's SAME current
// link (recovered from the persisted envelope, in a fresh request), goes to
// its CURRENT contact email, is recorded by the real service_role recorder
// only after the (fake) provider accepted, and never changes the link.
// Tokens are compared, never printed.

const APP_ORIGIN = "http://localhost:3100";
const RSVP_LINE = /^Confirmar asistencia: (http:\/\/localhost:3100\/rsvp\/([A-Za-z0-9_-]{43}))$/m;
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
  const token = /\/rsvp\/([A-Za-z0-9_-]{43})$/.exec(link)?.[1];
  if (!token) throw new Error("unexpected link shape (value redacted)");
  return token;
}

/** Creates a party in one "request"; returns its id and the link the organizer saw. */
async function createdInAnEarlierRequest(user: TestUserKey, weddingId: string, label: string, contactEmail?: string) {
  const result = await createGuestParty(
    await sessionClient(user),
    weddingId,
    { label, guestNames: ["Invitada Uno", "Invitado Dos"], ...(contactEmail ? { contactEmail } : {}) },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  return { id: result.guestInvitationId, link: result.link };
}

async function linkState(partyId: string) {
  const [party] = await sql<Record<string, unknown>>(
    `select token_hash, token_issued_at, revoked_at, contact_email,
            invitation_email_sent_at, rsvp_confirmation_email_sent_at,
            rsvp_reminder_email_sent_at, rsvp_reminder_email_sent_to, rsvp_reminder_email_provider_id
     from public.guest_invitations where id = $1`,
    [partyId],
  );
  const secrets = await sql(`select token_hash, token_ciphertext from ${SECRETS} where guest_invitation_id = $1`, [partyId]);
  return { party: party!, secrets };
}

/** The link's own fields (what a reminder must never change). */
const linkOnly = (s: Awaited<ReturnType<typeof linkState>>) => ({
  hash: s.party.token_hash,
  issued: s.party.token_issued_at,
  revoked: s.party.revoked_at,
  secrets: s.secrets,
});

async function guestLinkWorks(link: string): Promise<boolean> {
  return (await getGuestPartyByToken(anonClient(), tokenOf(link))).ok;
}

type FakeSender = EmailSender & { sent: OutgoingEmail[] };

function fakeSender(result?: EmailSendResult): FakeSender {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
      return result ?? { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
}

/** The real service_role recorder (optionally failing), counting its calls. */
function deliveryWith(sender: EmailSender, opts: { recorderFails?: boolean } = {}) {
  const real = createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
  const calls: string[] = [];
  const recorder: DeliveryRecorder = {
    ...real,
    async recordRsvpReminder(entry) {
      calls.push(entry.providerMessageId);
      return opts.recorderFails ? { ok: false } : real.recordRsvpReminder(entry);
    },
  };
  return { delivery: { sender, appOrigin: APP_ORIGIN, recorder }, calls };
}

function emailedLink(email: OutgoingEmail | undefined): string | undefined {
  return RSVP_LINE.exec(email?.text ?? "")?.[1];
}

let weddingA: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda recordatorio servicio");
  await addMember(weddingA, "collabA", "collaborator");
  await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad Ejemplo' where id = $1", [weddingA]);
});

describe("sendRsvpReminderEmail (real stack)", () => {
  it.each(["ownerA", "collabA"] as const)("%s: same link, current recipient, recorded; the link is untouched", async (actor) => {
    const recipient = `same-${actor.toLowerCase()}@example.com`;
    const party = await createdInAnEarlierRequest("ownerA", weddingA, `Mismo enlace ${actor}`, recipient);
    const before = await linkState(party.id);
    const sender = fakeSender();
    const { delivery, calls } = deliveryWith(sender);

    const outcome = await sendRsvpReminderEmail(await sessionClient(actor), weddingA, party.id, delivery, ENCRYPTION);
    expect(outcome).toMatchObject({ outcome: "sent", recipient });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(recipient);
    expect(sender.sent[0]!.subject).toBe("Recordatorio de confirmación — Boda recordatorio servicio");
    expect(sender.sent[0]!.text).toContain("Ciudad Ejemplo");

    // SAME-LINK PROOF: creation link == reminder link == recoverable link.
    const reminded = emailedLink(sender.sent[0]);
    expect(reminded === party.link, "reminder link equals the original link (value redacted)").toBe(true);
    const recovered = await recoverGuestPartyLink(await sessionClient(actor), weddingA, party.id, CONFIG);
    expect(recovered.ok && recovered.link === reminded, "reminder link equals the recoverable link (value redacted)").toBe(true);
    expect(await guestLinkWorks(party.link)).toBe(true);

    const after = await linkState(party.id);
    expect(linkOnly(after)).toEqual(linkOnly(before));
    expect(after.party.rsvp_reminder_email_sent_to).toBe(recipient);
    expect(after.party.rsvp_reminder_email_provider_id).toBe(calls[0]);
    expect(after.party.invitation_email_sent_at).toBeNull();
    expect(after.party.rsvp_confirmation_email_sent_at).toBeNull();
  });

  it("an outsider is refused before anything is read, sent or recorded", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Ajeno", "ajeno@example.com");
    const sender = fakeSender();
    const { delivery, calls } = deliveryWith(sender);
    for (const actor of ["outsider", "ownerB"] as const) {
      expect(await sendRsvpReminderEmail(await sessionClient(actor), weddingA, party.id, delivery, ENCRYPTION)).toEqual({
        outcome: "failed",
        reason: "not_found",
      });
    }
    expect(sender.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await linkState(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("race: the contact email changed after the page loaded — the CURRENT one is used and recorded", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Correo cambiado", "viejo@example.com");
    // ...the organizer's page still shows viejo@; meanwhile a collaborator edits it.
    expect((await updateGuestPartyContactEmail(await sessionClient("collabA"), weddingA, party.id, "nuevo@example.com")).ok).toBe(true);
    const sender = fakeSender();
    const outcome = await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, deliveryWith(sender).delivery, ENCRYPTION);
    expect(outcome).toMatchObject({ outcome: "sent", recipient: "nuevo@example.com" });
    expect(sender.sent.map((m) => m.to)).toEqual(["nuevo@example.com"]);
    expect((await linkState(party.id)).party.rsvp_reminder_email_sent_to).toBe("nuevo@example.com");
  });

  it("race: the link was rotated after the page loaded — the reminder carries the NEW link, the old stays dead", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Rotado antes", "rotado@example.com");
    const rotated = await rotateGuestPartyLink(await sessionClient("ownerA"), weddingA, party.id, APP_ORIGIN, ENCRYPTION);
    if (!rotated.ok) throw new Error("rotation failed");
    const before = await linkState(party.id);

    const sender = fakeSender();
    await sendRsvpReminderEmail(await sessionClient("collabA"), weddingA, party.id, deliveryWith(sender).delivery, ENCRYPTION);
    const reminded = emailedLink(sender.sent[0]);
    expect(reminded === rotated.link, "the reminder carries the new link (value redacted)").toBe(true);
    expect(reminded === party.link, "never the old link (value redacted)").toBe(false);
    expect(await guestLinkWorks(party.link)).toBe(false);
    expect(await guestLinkWorks(rotated.link)).toBe(true);
    expect(linkOnly(await linkState(party.id))).toEqual(linkOnly(before));
  });

  it("legacy (hash-only) link: nothing sent, nothing rotated, the guest's link keeps working", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Antiguo", "antiguo@example.com");
    await sql(`delete from ${SECRETS} where guest_invitation_id = $1`, [party.id]);
    const before = await linkState(party.id);
    for (const actor of ["ownerA", "collabA"] as const) {
      const sender = fakeSender();
      const { delivery, calls } = deliveryWith(sender);
      expect(await sendRsvpReminderEmail(await sessionClient(actor), weddingA, party.id, delivery, ENCRYPTION)).toEqual({
        outcome: "link_unrecoverable",
      });
      expect(await prepareRsvpReminderMessage(await sessionClient(actor), weddingA, party.id, CONFIG)).toEqual({
        ok: false,
        reason: "link_unrecoverable",
      });
      expect(sender.sent).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
    expect(linkOnly(await linkState(party.id))).toEqual(linkOnly(before));
    expect(await guestLinkWorks(party.link)).toBe(true);
  });

  it("a different server key: unrecoverable, provider 0, recorder 0, link unchanged", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Otra llave", "llave@example.com");
    const before = await linkState(party.id);
    const sender = fakeSender();
    const { delivery, calls } = deliveryWith(sender);
    expect(
      await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery, { key: WRONG_TEST_RSVP_CAPABILITY_KEY }),
    ).toEqual({ outcome: "link_unrecoverable" });
    expect(sender.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(linkOnly(await linkState(party.id))).toEqual(linkOnly(before));
  });

  it("revoked and expired links: nothing sent or recorded, never re-opened", async () => {
    const revoked = await createdInAnEarlierRequest("ownerA", weddingA, "Revocado", "revocado@example.com");
    expect((await revokeGuestPartyLink(await sessionClient("ownerA"), weddingA, revoked.id)).ok).toBe(true);
    const sender = fakeSender();
    const { delivery, calls } = deliveryWith(sender);
    expect(await sendRsvpReminderEmail(await sessionClient("collabA"), weddingA, revoked.id, delivery, ENCRYPTION)).toEqual({
      outcome: "link_unavailable",
    });

    const expiredWedding = await fixtureWedding("ownerA", "Boda pasada");
    const expired = await createdInAnEarlierRequest("ownerA", expiredWedding, "Vencido", "vencido@example.com");
    await sql("update public.weddings set wedding_date = '2000-01-01' where id = $1", [expiredWedding]);
    expect(await sendRsvpReminderEmail(await sessionClient("ownerA"), expiredWedding, expired.id, delivery, ENCRYPTION)).toEqual({
      outcome: "link_unavailable",
    });
    expect(sender.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await linkState(revoked.id)).party.revoked_at).not.toBeNull();
  });

  it("no contact email: no email; the WhatsApp text still works with the same link", async () => {
    const party = await createdInAnEarlierRequest("collabA", weddingA, "Sin correo");
    const sender = fakeSender();
    expect(
      await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, deliveryWith(sender).delivery, ENCRYPTION),
    ).toEqual({ outcome: "no_email" });
    expect(sender.sent).toHaveLength(0);
    const message = await prepareRsvpReminderMessage(await sessionClient("collabA"), weddingA, party.id, CONFIG);
    if (!message.ok) throw new Error(message.reason);
    expect(message.message.split("\n").includes(party.link), "same link in the text (value redacted)").toBe(true);
    expect((await linkState(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("provider failure: nothing recorded, one attempt, the link still works", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Falla", "falla@example.com");
    const before = await linkState(party.id);
    const sender = fakeSender({ ok: false, reason: "provider_failure" });
    const { delivery, calls } = deliveryWith(sender);
    expect(await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery, ENCRYPTION)).toEqual({
      outcome: "provider_failed",
    });
    expect(sender.sent).toHaveLength(1);
    expect(calls).toHaveLength(0);
    const after = await linkState(party.id);
    expect(after.party.rsvp_reminder_email_sent_at).toBeNull();
    expect(linkOnly(after)).toEqual(linkOnly(before));
    expect(await guestLinkWorks(party.link)).toBe(true);
  });

  it("provider accepted + recorder failure: sent_but_unrecorded, no resend, nothing written", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Sin registro", "sinregistro@example.com");
    const sender = fakeSender();
    const { delivery, calls } = deliveryWith(sender, { recorderFails: true });
    expect(await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery, ENCRYPTION)).toEqual({
      outcome: "sent_but_unrecorded",
      recipient: "sinregistro@example.com",
    });
    expect(sender.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect((await linkState(party.id)).party.rsvp_reminder_email_sent_at).toBeNull();
  });

  it("the reminder carries the link; the RSVP confirmation that follows never does", async () => {
    const party = await createdInAnEarlierRequest("ownerA", weddingA, "Distintos", "distintos@example.com");
    const sender = fakeSender();
    const { delivery } = deliveryWith(sender);
    await sendRsvpReminderEmail(await sessionClient("ownerA"), weddingA, party.id, delivery, ENCRYPTION);
    const [guest] = await sql<{ id: string }>(
      "select id from public.guests where guest_invitation_id = $1 order by created_at limit 1",
      [party.id],
    );
    const guests = await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1", [party.id]);
    expect(guest).toBeDefined();
    const saved = await submitRsvpWithConfirmation(
      anonClient(),
      tokenOf(party.link),
      guests.map((g) => ({ guestId: g.id, attending: true, dietaryNote: "nota privada" })),
      () => delivery,
    );
    expect(saved).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    const [reminder, confirmation] = sender.sent;
    expect(reminder!.text).toContain("/rsvp/");
    for (const part of [confirmation!.subject, confirmation!.text, confirmation!.html]) {
      expect(part).not.toContain("/rsvp/");
      expect(part.includes(tokenOf(party.link))).toBe(false);
    }
    // Separate statuses.
    const after = (await linkState(party.id)).party;
    expect(after.rsvp_reminder_email_sent_at).not.toBeNull();
    expect(after.rsvp_confirmation_email_sent_at).not.toBeNull();
  });
});
