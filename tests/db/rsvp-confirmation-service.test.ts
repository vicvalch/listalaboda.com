import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { EmailDelivery } from "@/lib/email/delivery";
import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import { es } from "@/lib/i18n/messages/es";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));
/** LB-13: the server's (fake, test-only) link-encryption key. */
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };

const { createGuestParty, listGuestParties, updateGuestPartyContactEmail } = await import("@/lib/guests/service");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { revokeGuestPartyLink } = await import("@/lib/guests/service");
const { publishWeddingSite, saveContentSection, setWeddingSiteSlug } = await import("@/lib/wedding-site/service");
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");

// LB-12 orchestration (what the RSVP Server Action calls) against the real
// local stack: the guest's own anon client + capability, a FAKE email sender
// (no provider, no network) that inspects the database from INSIDE send(),
// and the REAL server-only recorder with the local stack's secret key
// (ADR-005). Every test asserts how many times the sender was called.

const APP_ORIGIN = "http://localhost:3100";
const status = es.rsvp.status;

type Snapshot = Array<{ name: string; attending: boolean | null }>;
type FakeSender = EmailSender & { sent: OutgoingEmail[]; seenAtSend: Snapshot[] };

function fakeSender(
  partyId: () => string,
  behavior?: (email: OutgoingEmail) => Promise<EmailSendResult> | EmailSendResult,
): FakeSender {
  const sent: OutgoingEmail[] = [];
  const seenAtSend: Snapshot[] = [];
  return {
    sent,
    seenAtSend,
    async send(email) {
      // Commit-before-send: read the persisted answers through an independent
      // connection while the provider is "being called".
      seenAtSend.push(await answers(partyId()));
      sent.push(email);
      return behavior ? behavior(email) : { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
}

function countingRecorder(fail = false) {
  const real = createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
  const calls: string[] = [];
  const recorder: DeliveryRecorder = {
    recordInvitation: real.recordInvitation,
    readRsvpConfirmationContext: real.readRsvpConfirmationContext,
    async recordRsvpConfirmation(entry) {
      calls.push(entry.providerMessageId);
      return fail ? { ok: false } : real.recordRsvpConfirmation(entry);
    },
  };
  return { recorder, calls };
}

function deliveryWith(sender: EmailSender, recorder: DeliveryRecorder): EmailDelivery {
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

async function newParty(weddingId: string, label: string, contactEmail: string | null) {
  const result = await createGuestParty(
    await sessionClient("ownerA"),
    weddingId,
    { label, guestNames: ["Ana Prueba", "Carlos Prueba"], contactEmail },
    APP_ORIGIN,
    ENCRYPTION,
  );
  if (!result.ok) throw new Error(`createGuestParty failed: ${result.reason}`);
  const guestIds = (
    await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1 order by created_at", [
      result.guestInvitationId,
    ])
  ).map((g) => g.id);
  return { ...result, guestIds };
}

async function answers(partyId: string): Promise<Snapshot> {
  return sql<{ name: string; attending: boolean | null }>(
    `select g.name, r.attending from public.guests g left join public.rsvps r on r.guest_id = g.id
     where g.guest_invitation_id = $1 order by g.created_at`,
    [partyId],
  );
}

async function metadata(partyId: string) {
  const rows = await sql<{
    sent_at: Date | null;
    sent_to: string | null;
    provider_id: string | null;
    invitation_sent_at: Date | null;
    rsvp_rows: number;
  }>(
    `select rsvp_confirmation_email_sent_at as sent_at, rsvp_confirmation_email_sent_to as sent_to,
            rsvp_confirmation_email_provider_id as provider_id, invitation_email_sent_at as invitation_sent_at,
            (select count(*)::int from public.rsvps r join public.guests g on g.id = r.guest_id
              where g.guest_invitation_id = i.id) as rsvp_rows
     from public.guest_invitations i where id = $1`,
    [partyId],
  );
  return rows[0]!;
}

const both = (ids: string[], a: boolean, b: boolean) => [
  { guestId: ids[0]!, attending: a, dietaryNote: "nota privada" },
  { guestId: ids[1]!, attending: b, dietaryNote: null },
];

let weddingA: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Confirmación Servicio");
  await addMember(weddingA, "collabA", "collaborator");
  await sql("update public.weddings set wedding_date = '2090-06-01', city = 'Ciudad Ejemplo' where id = $1", [weddingA]);
});

describe("submitRsvpWithConfirmation against the real database", () => {
  it("success: the RSVP is persisted BEFORE the provider is called; then the send is recorded", async () => {
    const party = await newParty(weddingA, "Familia Éxito", "exito@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder, calls } = countingRecorder();

    const result = await submitRsvpWithConfirmation(
      anonClient(),
      party.token,
      both(party.guestIds, true, false),
      () => deliveryWith(sender, recorder),
    );

    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(sender.sent).toHaveLength(1);
    // Seen from inside send(): the answers were already committed.
    expect(sender.seenAtSend).toEqual([
      [
        { name: "Ana Prueba", attending: true },
        { name: "Carlos Prueba", attending: false },
      ],
    ]);
    const email = sender.sent[0]!;
    expect(email.to).toBe("exito@example.com");
    expect(email.subject).toBe("Confirmación de asistencia — Boda Confirmación Servicio");
    expect(email.text).toContain("Hola, Familia Éxito:");
    expect(email.text).toContain(`- Ana Prueba: ${status.attending}`);
    expect(email.text).toContain(`- Carlos Prueba: ${status.not_attending}`);
    expect(email.text).toContain("1 de junio de 2090");
    expect(email.text).toContain("Ciudad Ejemplo");
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("/rsvp/");
      expect(part).not.toContain(party.token);
      expect(part).not.toContain("nota privada");
      expect(part).not.toContain(party.guestInvitationId);
    }

    expect(calls).toHaveLength(1);
    const stored = await metadata(party.guestInvitationId);
    expect(stored.sent_to).toBe("exito@example.com");
    expect(stored.provider_id).toBe(calls[0]);
    expect(stored.sent_at).not.toBeNull();
    // The invitation-email status is a different thing and stays untouched.
    expect(stored.invitation_sent_at).toBeNull();
  });

  it("provider failure: RSVP persisted, metadata unchanged, recorder never called", async () => {
    const party = await newParty(weddingA, "Familia Falla", "falla@example.com");
    const sender = fakeSender(() => party.guestInvitationId, () => ({ ok: false, reason: "provider_failure" }));
    const { recorder, calls } = countingRecorder();

    const result = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, true), () =>
      deliveryWith(sender, recorder),
    );

    expect(result).toMatchObject({ rsvp: "saved", confirmation: "provider_failed" });
    expect(sender.sent).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(await answers(party.guestInvitationId)).toEqual([
      { name: "Ana Prueba", attending: true },
      { name: "Carlos Prueba", attending: true },
    ]);
    expect((await metadata(party.guestInvitationId)).sent_at).toBeNull();
  });

  it("recorder failure: RSVP persisted, ONE provider call, no resend, sent_but_unrecorded", async () => {
    const party = await newParty(weddingA, "Familia Registro", "registro-srv@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder, calls } = countingRecorder(true);

    const result = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, false, false), () =>
      deliveryWith(sender, recorder),
    );

    expect(result).toMatchObject({ rsvp: "saved", confirmation: "sent_but_unrecorded" });
    expect(sender.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect((await answers(party.guestInvitationId)).map((g) => g.attending)).toEqual([false, false]);
    expect((await metadata(party.guestInvitationId)).sent_at).toBeNull();
  });

  it("update: one current row per guest, email #2 shows the new state, metadata points to send #2", async () => {
    const party = await newParty(weddingA, "Familia Cambio", "cambio@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder, calls } = countingRecorder();
    const delivery = () => deliveryWith(sender, recorder);

    await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, true), delivery);
    const first = await metadata(party.guestInvitationId);
    const second = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, false), delivery);

    expect(second).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]!.text).toContain(`- Carlos Prueba: ${status.attending}`);
    expect(sender.sent[1]!.text).toContain(`- Carlos Prueba: ${status.not_attending}`);
    expect(sender.sent[1]!.text).toContain(`- Ana Prueba: ${status.attending}`);
    const latest = await metadata(party.guestInvitationId);
    expect(latest.rsvp_rows).toBe(2);
    expect(calls).toHaveLength(2);
    expect(latest.provider_id).toBe(calls[1]);
    expect(latest.sent_at!.getTime()).toBeGreaterThanOrEqual(first.sent_at!.getTime());
  });

  it("no contact email: RSVP saved, provider 0, recorder 0", async () => {
    const party = await newParty(weddingA, "Familia Sin Correo", null);
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder, calls } = countingRecorder();
    const result = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, false), () =>
      deliveryWith(sender, recorder),
    );
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "skipped_no_email" });
    expect(sender.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await answers(party.guestInvitationId)).map((g) => g.attending)).toEqual([true, false]);
  });

  it("email not configured: RSVP saved, provider 0", async () => {
    const party = await newParty(weddingA, "Familia Sin Configuración", "sinconf@example.com");
    const result = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, false, true), () => null);
    expect(result).toMatchObject({ rsvp: "saved", confirmation: "not_configured" });
    expect((await answers(party.guestInvitationId)).map((g) => g.attending)).toEqual([false, true]);
    expect((await metadata(party.guestInvitationId)).sent_at).toBeNull();
  });

  it("uses the CURRENT contact email from the database, and skips once it's removed", async () => {
    const party = await newParty(weddingA, "Familia Correo Nuevo", "viejo@example.com");
    const owner = await sessionClient("ownerA");
    const changed = await updateGuestPartyContactEmail(owner, weddingA, party.guestInvitationId, "nuevo@example.com");
    expect(changed.ok).toBe(true);
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder } = countingRecorder();
    await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, true), () =>
      deliveryWith(sender, recorder),
    );
    expect(sender.sent.map((e) => e.to)).toEqual(["nuevo@example.com"]);

    await updateGuestPartyContactEmail(owner, weddingA, party.guestInvitationId, null);
    const again = await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, false, false), () =>
      deliveryWith(sender, recorder),
    );
    expect(again).toMatchObject({ rsvp: "saved", confirmation: "skipped_no_email" });
    expect(sender.sent).toHaveLength(1);
    // The last confirmation keeps saying where it actually went.
    expect((await metadata(party.guestInvitationId)).sent_to).toBe("nuevo@example.com");
  });

  it("links the website only while it is published", async () => {
    const wedding = await fixtureWedding("ownerA", "Boda Confirmación Sitio");
    const owner = await sessionClient("ownerA");
    const party = await newParty(wedding, "Familia Sitio", "sitio-conf@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder } = countingRecorder();
    const delivery = () => deliveryWith(sender, recorder);

    await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, true), delivery);
    expect(sender.sent[0]!.text).not.toContain("/boda/");

    const slug = `conf-sitio-${randomUUID().slice(0, 8)}`;
    expect((await setWeddingSiteSlug(owner, wedding, slug)).ok).toBe(true);
    expect((await saveContentSection(owner, wedding, { kind: "intro", title: null, body: "Hola", isVisible: true })).ok).toBe(true);
    expect((await publishWeddingSite(owner, wedding)).ok).toBe(true);

    await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, false), delivery);
    expect(sender.sent[1]!.text).toContain(`${APP_ORIGIN}/boda/${slug}`);
    expect(sender.sent[1]!.html).toContain(`${APP_ORIGIN}/boda/${slug}`);
    for (const email of sender.sent) {
      expect(email.text).not.toContain("/rsvp/");
      expect(email.html).not.toContain("/rsvp/");
    }
  });

  it("invalid capability (malformed, unknown, revoked, expired): RSVP not saved, provider 0, recorder 0", async () => {
    const party = await newParty(weddingA, "Familia Inválida", "invalida@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder, calls } = countingRecorder();
    const delivery = vi.fn(() => deliveryWith(sender, recorder));
    const attempt = (token: string) =>
      submitRsvpWithConfirmation(anonClient(), token, both(party.guestIds, true, true), delivery);

    expect(await attempt("malformado")).toEqual({ rsvp: "failed", reason: "unavailable" });
    expect(await attempt("A".repeat(43))).toEqual({ rsvp: "failed", reason: "unavailable" });

    const revoked = await revokeGuestPartyLink(await sessionClient("ownerA"), weddingA, party.guestInvitationId);
    expect(revoked.ok).toBe(true);
    expect(await attempt(party.token)).toEqual({ rsvp: "failed", reason: "unavailable" });

    const expiredWedding = await fixtureWedding("ownerA", "Boda Vencida");
    const expired = await newParty(expiredWedding, "Familia Vencida", "vencida@example.com");
    await sql("update public.weddings set wedding_date = '2000-01-01' where id = $1", [expiredWedding]);
    const expiredResult = await submitRsvpWithConfirmation(anonClient(), expired.token, both(expired.guestIds, true, true), delivery);
    expect(expiredResult).toEqual({ rsvp: "failed", reason: "unavailable" });

    expect(delivery).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await answers(party.guestInvitationId)).every((g) => g.attending === null)).toBe(true);
    expect((await answers(expired.guestInvitationId)).every((g) => g.attending === null)).toBe(true);
  });

  it("organizers see the latest confirmation, separately from the invitation status", async () => {
    const party = await newParty(weddingA, "Familia Lista", "lista-conf@example.com");
    const sender = fakeSender(() => party.guestInvitationId);
    const { recorder } = countingRecorder();
    await submitRsvpWithConfirmation(anonClient(), party.token, both(party.guestIds, true, true), () =>
      deliveryWith(sender, recorder),
    );
    const collab = await sessionClient("collabA");
    const access = await requireWeddingMembership(collab, weddingA);
    if (!access.ok) throw new Error("no access");
    const listed = (await listGuestParties(collab, access.access))?.find((p) => p.id === party.guestInvitationId);
    expect(listed?.invitationEmail).toBeNull();
    expect(listed?.rsvpConfirmationEmail?.sentTo).toBe("lista-conf@example.com");
  });
});
