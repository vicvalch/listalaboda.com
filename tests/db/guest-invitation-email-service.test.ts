import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, emailDeliveriesFor, sql, users } from "./support";

vi.mock("server-only", () => ({}));
/** LB-13: the server's (fake, test-only) link-encryption key. */
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };

const { createGuestParty, updateGuestPartyContactEmail, listGuestParties } = await import(
  "@/lib/guests/service"
);
const { sendGuestInvitationEmail, rotateLinkAndSendInvitation } = await import(
  "@/lib/guests/invitation-email"
);
const { getGuestPartyByToken, submitGuestRsvp } = await import("@/lib/rsvp/service");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { publishWeddingSite, saveContentSection, setWeddingSiteSlug, unpublishWeddingSite } = await import(
  "@/lib/wedding-site/service"
);
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");

// LB-11 services (what the Server Actions call) against the real local
// stack, with a FAKE email sender (no provider, no network, no API key) and
// the REAL server-only delivery recorder using the local stack's secret key
// (ADR-004). Authorization uses each user's own session. Every test asserts
// how many times the sender was called.

const APP_ORIGIN = "http://localhost:3100";
const RSVP_URL = /^http:\/\/localhost:3100\/rsvp\/([A-Za-z0-9_-]{43})$/;

type FakeSender = EmailSender & { sent: OutgoingEmail[] };

function fakeSender(behavior?: (email: OutgoingEmail) => Promise<EmailSendResult> | EmailSendResult): FakeSender {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
      return behavior ? behavior(email) : { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
}

/** The real recorder, counting its calls. */
function countingRecorder() {
  const real = createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
  const calls: string[] = [];
  const recorder: DeliveryRecorder = {
    async recordInvitation(entry) {
      calls.push(entry.providerMessageId);
      return real.recordInvitation(entry);
    },
    readRsvpConfirmationContext: real.readRsvpConfirmationContext,
    recordRsvpConfirmation: real.recordRsvpConfirmation,
    recordRsvpReminder: real.recordRsvpReminder,
  };
  return { recorder, calls };
}

function deliveryWith(sender: EmailSender, recorder: DeliveryRecorder = countingRecorder().recorder) {
  return { sender, appOrigin: APP_ORIGIN, recorder };
}

const createdWeddings: string[] = [];

afterAll(async () => {
  await sql("delete from public.weddings where id = any($1::uuid[])", [createdWeddings]);
});

async function fixtureWedding(owner: TestUserKey, name: string): Promise<string> {
  const id = await createFixtureWedding(owner, name);
  createdWeddings.push(id);
  return id;
}

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

function rsvpToken(email: OutgoingEmail): string {
  const url = /Confirmar asistencia: (\S+)/.exec(email.text)?.[1] ?? "";
  const token = RSVP_URL.exec(url)?.[1];
  if (!token) throw new Error("no RSVP link in the email (value redacted)");
  return token;
}

async function newParty(user: TestUserKey, weddingId: string, label: string, contactEmail: string | null) {
  const result = await createGuestParty(
    await sessionClient(user),
    weddingId,
    { label, guestNames: ["Invitada Uno", "Invitado Dos"], contactEmail },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  return result;
}

async function metadata(partyId: string) {
  const rows = await sql<{
    sent_at: Date | null;
    sent_to: string | null;
    provider_id: string | null;
    token_hash: string;
  }>(
    `select invitation_email_sent_at as sent_at, invitation_email_sent_to as sent_to,
            invitation_email_provider_id as provider_id, token_hash
     from public.guest_invitations where id = $1`,
    [partyId],
  );
  return rows[0]!;
}

async function guestsAndAnswers(partyId: string) {
  return sql<{ name: string; attending: boolean | null }>(
    `select g.name, r.attending from public.guests g
     left join public.rsvps r on r.guest_id = g.id
     where g.guest_invitation_id = $1 order by g.created_at`,
    [partyId],
  );
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Servicio Correo");
  await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad Prueba' where id = $1", [
    weddingA,
  ]);
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Ajena Correo");
});

// --------------------------------------------------------- fresh link

describe("sendGuestInvitationEmail (fresh link, any member)", () => {
  it("a collaborator emails a just-created party's link; the send is recorded; the link works", async () => {
    const created = await newParty("collabA", weddingA, "Familia Fresca", "fresca@example.com");
    const sender = fakeSender();
    const counting = countingRecorder();

    const outcome = await sendGuestInvitationEmail(
      await sessionClient("collabA"),
      weddingA,
      created.guestInvitationId,
      created.token,
      deliveryWith(sender, counting.recorder),
    );

    expect(outcome).toMatchObject({ outcome: "sent", recipient: "fresca@example.com" });
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0]!;
    expect(email.to).toBe("fresca@example.com");
    expect(email.subject).toBe("Tu invitación a Boda Servicio Correo");
    // The emailed link is the same capability the organizer was shown.
    expect(rsvpToken(email)).toBe(created.token);
    expect(email.text).toContain("Familia Fresca");
    expect(email.text).toContain("1 de junio de 2090");
    expect(email.text).toContain("Ciudad Prueba");
    // Never other parties, answers or member data.
    expect(email.text).not.toContain("Invitada Uno");

    const stored = await metadata(created.guestInvitationId);
    expect(stored.sent_to).toBe("fresca@example.com");
    expect(stored.provider_id).toMatch(/^fake-/);
    // Recorded once, by the privileged recorder, with the provider's own id.
    expect(counting.calls).toEqual([stored.provider_id]);
    expect(stored.sent_at).not.toBeNull();
    // LB-18.1 (ADR-011): and one ledger row for that send, written by the same record.
    expect((await emailDeliveriesFor(created.guestInvitationId)).map((d) => [d.kind, d.provider_message_id, d.recipient])).toEqual([
      ["guest_invitation", stored.provider_id, "fresca@example.com"],
    ]);

    const party = await getGuestPartyByToken(anonClient(), rsvpToken(email));
    expect(party.ok).toBe(true);
  });

  it("never calls the provider before every check passes", async () => {
    const created = await newParty("ownerA", weddingA, "Antes de enviar", "antes@example.com");
    const noEmail = await newParty("ownerA", weddingA, "Sin correo", null);
    const sender = fakeSender();
    const counting = countingRecorder();
    const delivery = deliveryWith(sender, counting.recorder);
    const owner = await sessionClient("ownerA");

    const cases: Array<[string, Promise<{ outcome: string; reason?: string }>, string]> = [
      ["no session", sendGuestInvitationEmail(anonClient(), weddingA, created.guestInvitationId, created.token, delivery), "unauthenticated"],
      ["outsider", sendGuestInvitationEmail(await sessionClient("outsider"), weddingA, created.guestInvitationId, created.token, delivery), "not_found"],
      ["other wedding's owner", sendGuestInvitationEmail(await sessionClient("ownerB"), weddingA, created.guestInvitationId, created.token, delivery), "not_found"],
      ["party of another wedding", sendGuestInvitationEmail(await sessionClient("ownerB"), weddingB, created.guestInvitationId, created.token, delivery), "invalid_target"],
      ["malformed party id", sendGuestInvitationEmail(owner, weddingA, "nope", created.token, delivery), "invalid_target"],
      ["malformed token", sendGuestInvitationEmail(owner, weddingA, created.guestInvitationId, "x".repeat(10), delivery), "invalid_token"],
      ["someone else's token", sendGuestInvitationEmail(owner, weddingA, created.guestInvitationId, noEmail.token, delivery), "invalid_token"],
      ["no contact email", sendGuestInvitationEmail(owner, weddingA, noEmail.guestInvitationId, noEmail.token, delivery), "missing_email"],
      ["email not configured", sendGuestInvitationEmail(owner, weddingA, created.guestInvitationId, created.token, null), "configuration_error"],
    ];
    for (const [label, pending, reason] of cases) {
      expect(await pending, label).toEqual({ outcome: "failed", reason });
    }
    expect(sender.sent).toHaveLength(0);
    expect(counting.calls).toEqual([]);
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();
  });

  it("refuses a link that is no longer current (rotated or revoked)", async () => {
    const created = await newParty("ownerA", weddingA, "Enlace viejo", "viejo@example.com");
    await sql("update public.guest_invitations set revoked_at = now() where id = $1", [created.guestInvitationId]);
    const sender = fakeSender();
    expect(
      await sendGuestInvitationEmail(
        await sessionClient("ownerA"),
        weddingA,
        created.guestInvitationId,
        created.token,
        deliveryWith(sender),
      ),
    ).toEqual({ outcome: "failed", reason: "invalid_token" });
    expect(sender.sent).toHaveLength(0);
  });

  it("provider failure: the recorder is never called, nothing recorded, the link keeps working", async () => {
    const created = await newParty("collabA", weddingA, "Proveedor caído", "caido@example.com");
    const sender = fakeSender(() => ({ ok: false, reason: "provider_failure" }));
    const counting = countingRecorder();
    expect(
      await sendGuestInvitationEmail(
        await sessionClient("collabA"),
        weddingA,
        created.guestInvitationId,
        created.token,
        deliveryWith(sender, counting.recorder),
      ),
    ).toEqual({ outcome: "failed", reason: "provider_failed" });
    expect(sender.sent).toHaveLength(1);
    expect(counting.calls).toEqual([]);
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();
    expect((await getGuestPartyByToken(anonClient(), created.token)).ok).toBe(true);
  });

  it("provider throws: treated as a provider failure", async () => {
    const created = await newParty("collabA", weddingA, "Proveedor lanza", "lanza@example.com");
    const sender = fakeSender(() => {
      throw new Error("boom");
    });
    expect(
      await sendGuestInvitationEmail(
        await sessionClient("collabA"),
        weddingA,
        created.guestInvitationId,
        created.token,
        deliveryWith(sender),
      ),
    ).toEqual({ outcome: "failed", reason: "provider_failed" });
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();
  });

  it("provider accepted but the status can't be recorded: sent_but_unrecorded, one call only", async () => {
    const created = await newParty("ownerA", weddingA, "Sin registro", "sinregistro@example.com");
    // While the email is "in flight", someone changes the address: the
    // record no longer matches and the database refuses it.
    const sender = fakeSender(async () => {
      await sql("update public.guest_invitations set contact_email = 'cambio@example.com' where id = $1", [
        created.guestInvitationId,
      ]);
      return { ok: true, messageId: "fake-unrecorded" };
    });
    expect(
      await sendGuestInvitationEmail(
        await sessionClient("ownerA"),
        weddingA,
        created.guestInvitationId,
        created.token,
        deliveryWith(sender),
      ),
    ).toEqual({ outcome: "sent_but_unrecorded", recipient: "sinregistro@example.com" });
    expect(sender.sent).toHaveLength(1);
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();
    expect(await emailDeliveriesFor(created.guestInvitationId)).toEqual([]);
  });

  it("links the public website only while it is published", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda Con Sitio");
    const owner = await sessionClient("ownerA");
    const created = await newParty("ownerA", wedding, "Con sitio", "sitio@example.com");
    const slug = `correo-${randomUUID().slice(0, 8)}`;

    const unpublished = fakeSender();
    await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, deliveryWith(unpublished));
    expect(unpublished.sent[0]!.text).not.toContain("/boda/");
    expect(unpublished.sent[0]!.html).not.toContain("/boda/");

    expect(await setWeddingSiteSlug(owner, wedding, slug)).toMatchObject({ ok: true });
    // An address alone isn't publishing.
    const slugOnly = fakeSender();
    await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, deliveryWith(slugOnly));
    expect(slugOnly.sent[0]!.text).not.toContain(slug);

    await saveContentSection(owner, wedding, { kind: "intro", title: null, body: "Hola", isVisible: true });
    expect(await publishWeddingSite(owner, wedding)).toEqual({ ok: true });
    const published = fakeSender();
    await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, deliveryWith(published));
    expect(published.sent[0]!.text).toContain(`${APP_ORIGIN}/boda/${slug}`);
    expect(published.sent[0]!.html).toContain(`${APP_ORIGIN}/boda/${slug}`);

    expect(await unpublishWeddingSite(owner, wedding)).toEqual({ ok: true });
    const again = fakeSender();
    await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, deliveryWith(again));
    expect(again.sent[0]!.text).not.toContain(slug);
  });
});

// ------------------------------------------------------ rotate + send

describe("rotateLinkAndSendInvitation (owner only)", () => {
  it("replaces the link, emails the new one; the old one dies; guests and answers stay", async () => {
    const created = await newParty("ownerA", weddingA, "Rotar y enviar", "rotar@example.com");
    const [first, second] = (await sql<{ id: string }>(
      "select id from public.guests where guest_invitation_id = $1 order by created_at",
      [created.guestInvitationId],
    )).map((g) => g.id);
    await submitGuestRsvp(anonClient(), created.token, [
      { guestId: first!, attending: true, dietaryNote: null },
      { guestId: second!, attending: false, dietaryNote: null },
    ]);
    const before = await guestsAndAnswers(created.guestInvitationId);
    const sender = fakeSender();

    const outcome = await rotateLinkAndSendInvitation(
      await sessionClient("ownerA"),
      weddingA,
      created.guestInvitationId,
      deliveryWith(sender),
      ENCRYPTION,
    );

    expect(outcome).toMatchObject({ outcome: "sent", recipient: "rotar@example.com" });
    expect(sender.sent).toHaveLength(1);
    const newToken = rsvpToken(sender.sent[0]!);
    expect(newToken).not.toBe(created.token);
    expect(outcome.link?.token).toBe(newToken);
    expect((await getGuestPartyByToken(anonClient(), created.token)).ok).toBe(false);
    expect((await getGuestPartyByToken(anonClient(), newToken)).ok).toBe(true);
    expect(await guestsAndAnswers(created.guestInvitationId)).toEqual(before);
    expect((await metadata(created.guestInvitationId)).sent_to).toBe("rotar@example.com");
  });

  it("a collaborator is refused before anything happens, even calling the service directly", async () => {
    const created = await newParty("collabA", weddingA, "Colaboración", "colabora@example.com");
    const hashBefore = (await metadata(created.guestInvitationId)).token_hash;
    const sender = fakeSender();
    expect(
      await rotateLinkAndSendInvitation(
        await sessionClient("collabA"),
        weddingA,
        created.guestInvitationId,
        deliveryWith(sender),
        ENCRYPTION,
      ),
    ).toEqual({ outcome: "failed", reason: "forbidden" });
    expect(sender.sent).toHaveLength(0);
    expect((await metadata(created.guestInvitationId)).token_hash).toBe(hashBefore);
    expect((await getGuestPartyByToken(anonClient(), created.token)).ok).toBe(true);
  });

  it("checks the recipient and configuration BEFORE rotating: a doomed send never kills a link", async () => {
    const noEmail = await newParty("ownerA", weddingA, "Rotar sin correo", null);
    const withEmail = await newParty("ownerA", weddingA, "Rotar sin configuración", "config@example.com");
    const sender = fakeSender();
    const owner = await sessionClient("ownerA");

    expect(await rotateLinkAndSendInvitation(owner, weddingA, noEmail.guestInvitationId, deliveryWith(sender), ENCRYPTION)).toEqual({
      outcome: "failed",
      reason: "missing_email",
    });
    expect(await rotateLinkAndSendInvitation(owner, weddingA, withEmail.guestInvitationId, null, ENCRYPTION)).toEqual({
      outcome: "failed",
      reason: "configuration_error",
    });
    expect(
      await rotateLinkAndSendInvitation(owner, weddingB, withEmail.guestInvitationId, deliveryWith(sender), ENCRYPTION),
    ).toEqual({ outcome: "failed", reason: "not_found" });
    expect(sender.sent).toHaveLength(0);
    expect((await getGuestPartyByToken(anonClient(), noEmail.token)).ok).toBe(true);
    expect((await getGuestPartyByToken(anonClient(), withEmail.token)).ok).toBe(true);
  });

  it("provider failure after rotating: no rollback, the new link is returned and works, nothing recorded", async () => {
    const created = await newParty("ownerA", weddingA, "Rotar y fallar", "falla@example.com");
    const sender = fakeSender(() => ({ ok: false, reason: "provider_failure" }));

    const outcome = await rotateLinkAndSendInvitation(
      await sessionClient("ownerA"),
      weddingA,
      created.guestInvitationId,
      deliveryWith(sender),
      ENCRYPTION,
    );

    expect(outcome).toMatchObject({ outcome: "failed", reason: "provider_failed" });
    expect(sender.sent).toHaveLength(1);
    const fresh = outcome.link;
    if (!fresh) throw new Error("the new link must be returned");
    expect(fresh.link).toBe(`${APP_ORIGIN}/rsvp/${fresh.token}`);
    expect((await getGuestPartyByToken(anonClient(), created.token)).ok).toBe(false);
    expect((await getGuestPartyByToken(anonClient(), fresh.token)).ok).toBe(true);
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();

    // The returned link can be retried by any member.
    const retry = fakeSender();
    expect(
      await sendGuestInvitationEmail(
        await sessionClient("collabA"),
        weddingA,
        created.guestInvitationId,
        fresh.token,
        deliveryWith(retry),
      ),
    ).toMatchObject({ outcome: "sent" });
  });
});

// ------------------------------------------- contact email and RSVPs

describe("contact email and RSVP regressions", () => {
  it("changing or removing the email never rotates, revokes or sends", async () => {
    const created = await newParty("ownerA", weddingA, "Solo correo", "solo@example.com");
    const hash = (await metadata(created.guestInvitationId)).token_hash;
    const collab = await sessionClient("collabA");

    expect(await updateGuestPartyContactEmail(collab, weddingA, created.guestInvitationId, "nuevo@example.com")).toEqual({
      ok: true,
    });
    expect(await updateGuestPartyContactEmail(collab, weddingA, created.guestInvitationId, null)).toEqual({ ok: true });
    expect((await metadata(created.guestInvitationId)).token_hash).toBe(hash);
    expect((await getGuestPartyByToken(anonClient(), created.token)).ok).toBe(true);

    expect(
      await updateGuestPartyContactEmail(await sessionClient("outsider"), weddingA, created.guestInvitationId, "x@example.com"),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await updateGuestPartyContactEmail(await sessionClient("ownerB"), weddingB, created.guestInvitationId, "x@example.com"),
    ).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("the organizer list shows the contact email and the last send", async () => {
    const created = await newParty("ownerA", weddingA, "Lista correo", "lista@example.com");
    await sendGuestInvitationEmail(
      await sessionClient("ownerA"),
      weddingA,
      created.guestInvitationId,
      created.token,
      deliveryWith(fakeSender()),
    );
    const collab = await sessionClient("collabA");
    const access = await requireWeddingMembership(collab, weddingA);
    if (!access.ok) throw new Error(access.reason);
    const party = (await listGuestParties(collab, access.access))?.find((p) => p.id === created.guestInvitationId);
    expect(party?.contactEmail).toBe("lista@example.com");
    expect(party?.invitationEmail?.sentTo).toBe("lista@example.com");
  });

  it("an RSVP confirmation (LB-12) never touches the invitation-email status", async () => {
    const created = await newParty("ownerA", weddingA, "Sin confirmación", "confirma@example.com");
    const sender = fakeSender();
    const guestIds = (await sql<{ id: string }>(
      "select id from public.guests where guest_invitation_id = $1 order by created_at",
      [created.guestInvitationId],
    )).map((g) => g.id);

    const result = await submitRsvpWithConfirmation(
      anonClient(),
      created.token,
      guestIds.map((guestId) => ({ guestId, attending: true, dietaryNote: null })),
      () => deliveryWith(sender),
    );
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(sender.sent).toHaveLength(1);
    // The confirmation is a different email: never the invitation's link.
    expect(sender.sent[0]!.text).not.toContain("/rsvp/");
    expect((await metadata(created.guestInvitationId)).sent_at).toBeNull();
  });
});
