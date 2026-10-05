import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeliveryRecorder } from "@/lib/email/delivery-recorder";
import type { EmailSendResult, EmailSender, OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import { addMember, createWedding as createFixtureWedding, ctx, sql, users } from "./support";

vi.mock("server-only", () => ({}));

const {
  createGuestParty,
  deleteGuestParty,
  revokeGuestPartyLink,
  rotateGuestPartyLink,
  updateGuestPartyContactEmail,
} = await import("@/lib/guests/service");
const { sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");
const { prepareRsvpReminderMessage, sendRsvpReminderEmail } = await import("@/lib/guests/rsvp-reminder");
const { getGuestPartyByToken } = await import("@/lib/rsvp/service");
const { submitRsvpWithConfirmation } = await import("@/lib/rsvp/confirmation");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");
const { listWeddingActivity } = await import("@/lib/activity/service");
const { requireWeddingMembership } = await import("@/lib/authz/wedding");
const { activityActorLabel, activityActorLine, activityEventLabel, activityPartyLabel } = await import(
  "@/lib/activity/presentation"
);
const { labelMembers } = await import("@/lib/weddings/members");
const { listWeddingMembers } = await import("@/lib/weddings/service");

// LB-15 (ADR-008) end to end through the services the Server Actions and the
// Activity page call, against the real local stack: every organizer action,
// guest RSVP and recorded email appends exactly one history row in its own
// database transaction; failed and unrecorded sends append nothing; members
// read it, outsiders can't. Emails go to a fake sender; the recorder is the
// real service_role one. Tokens are compared, never printed.

const APP_ORIGIN = "http://localhost:3100";
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };
const CONFIG = { appOrigin: APP_ORIGIN, encryption: ENCRYPTION };

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

function fakeSender(result?: EmailSendResult): EmailSender & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
      return result ?? { ok: true, messageId: `fake-${randomUUID()}` };
    },
  };
}

/** The real service_role recorder; `failing` makes every record report failure (sent_but_unrecorded). */
function delivery(sender: EmailSender, failing = false) {
  const real = createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
  const recorder: DeliveryRecorder = failing
    ? {
        ...real,
        recordInvitation: async () => ({ ok: false }),
        recordRsvpConfirmation: async () => ({ ok: false }),
        recordRsvpReminder: async () => ({ ok: false }),
      }
    : real;
  return { sender, appOrigin: APP_ORIGIN, recorder };
}

/** What the Activity page loads, as `user`: [event label, party label, actor line], newest first. */
async function activityPage(user: TestUserKey, weddingId: string) {
  const supabase = await sessionClient(user);
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) return access.reason;
  const [entries, members] = await Promise.all([
    listWeddingActivity(supabase, access.access),
    listWeddingMembers(supabase, access.access),
  ]);
  if (!entries) throw new Error("activity failed to load");
  const labeled = labelMembers(members ?? []);
  return entries.map((e) => [
    activityEventLabel(e.eventType),
    activityPartyLabel(e.partyLabel),
    activityActorLine(activityActorLabel(e.actorKind, e.actorMembershipId, labeled)),
  ]);
}

async function rowCount(weddingId: string): Promise<number> {
  const [row] = await sql<{ n: number }>("select count(*)::int as n from public.wedding_activity where wedding_id = $1", [
    weddingId,
  ]);
  return row?.n ?? 0;
}

async function guestIdsOf(partyId: string): Promise<string[]> {
  return (
    await sql<{ id: string }>("select id from public.guests where guest_invitation_id = $1 order by created_at, id", [
      partyId,
    ])
  ).map((r) => r.id);
}

let wedding: string;

beforeAll(async () => {
  wedding = await fixtureWedding("ownerA", "Boda historial servicio");
  await addMember(wedding, "collabA", "collaborator");
  await sql("update public.wedding_memberships set display_name = 'Sofía' where wedding_id = $1 and user_id = $2", [
    wedding,
    users.collabA.id,
  ]);
});

describe("activity history through the real services", () => {
  it("records the whole party lifecycle once each, attributed, newest first; members read it, outsiders can't", async () => {
    const recipient = "familia-historial@example.com";

    // A collaborator creates the party and emails its fresh link.
    const created = await createGuestParty(
      await sessionClient("collabA"),
      wedding,
      { label: "Familia Historial", guestNames: ["Ana", "Luis"], contactEmail: recipient },
      APP_ORIGIN,
      ENCRYPTION,
    );
    if (!created.ok) throw new Error(created.reason);
    const invitation = await sendGuestInvitationEmail(
      await sessionClient("collabA"),
      wedding,
      created.guestInvitationId,
      created.token,
      delivery(fakeSender()),
    );
    expect(invitation).toMatchObject({ outcome: "sent" });

    // The party answers, then changes its answer (each with a confirmation).
    const ids = await guestIdsOf(created.guestInvitationId);
    for (const attending of [true, false]) {
      const saved = await submitRsvpWithConfirmation(
        anonClient(),
        created.token,
        ids.map((guestId) => ({ guestId, attending, dietaryNote: "sin gluten" })),
        () => delivery(fakeSender()),
      );
      expect(saved).toMatchObject({ rsvp: "saved", confirmation: "sent" });
    }

    // The owner reminds the party, a collaborator fixes the address, the owner replaces then revokes the link.
    expect(
      await sendRsvpReminderEmail(await sessionClient("ownerA"), wedding, created.guestInvitationId, delivery(fakeSender()), ENCRYPTION),
    ).toMatchObject({ outcome: "sent" });
    expect(
      (await updateGuestPartyContactEmail(await sessionClient("collabA"), wedding, created.guestInvitationId, "nuevo@example.com"))
        .ok,
    ).toBe(true);
    const rotated = await rotateGuestPartyLink(await sessionClient("ownerA"), wedding, created.guestInvitationId, APP_ORIGIN, ENCRYPTION);
    expect(rotated.ok).toBe(true);
    expect((await revokeGuestPartyLink(await sessionClient("ownerA"), wedding, created.guestInvitationId)).ok).toBe(true);
    // Revoking again is a no-op: nothing new is recorded.
    expect((await revokeGuestPartyLink(await sessionClient("ownerA"), wedding, created.guestInvitationId)).ok).toBe(true);

    const expected = [
      ["Acceso RSVP revocado", "Familia Historial", "Por ti"],
      ["Enlace personal regenerado", "Familia Historial", "Por ti"],
      ["Correo de contacto actualizado", "Familia Historial", "Por Sofía"],
      ["Recordatorio RSVP enviado", "Familia Historial", "Por ti"],
      ["Confirmación RSVP enviada", "Familia Historial", "Por el grupo, con su enlace personal"],
      ["RSVP actualizado", "Familia Historial", "Por el grupo, con su enlace personal"],
      ["Confirmación RSVP enviada", "Familia Historial", "Por el grupo, con su enlace personal"],
      ["RSVP recibido", "Familia Historial", "Por el grupo, con su enlace personal"],
      ["Invitación enviada por correo", "Familia Historial", "Por Sofía"],
      ["Invitación creada", "Familia Historial", "Por Sofía"],
    ];
    expect(await activityPage("ownerA", wedding)).toEqual(expected);
    // The collaborator sees the same history; only "Tú"/"Sofía" swap perspective.
    const asCollab = await activityPage("collabA", wedding);
    if (!Array.isArray(asCollab)) throw new Error(asCollab);
    expect(asCollab.map((r) => r.slice(0, 2))).toEqual(expected.map((r) => r.slice(0, 2)));
    expect(asCollab[0]?.[2]).toMatch(/^Por /);
    expect(asCollab[0]?.[2]).not.toBe("Por ti");
    expect(asCollab.at(-1)?.[2]).toBe("Por ti");

    // Outsiders and other weddings' owners never reach the read.
    expect(await activityPage("outsider", wedding)).toBe("not_found");
    expect(await activityPage("ownerB", wedding)).toBe("not_found");

    // Nothing sensitive in what the page receives.
    const supabase = await sessionClient("ownerA");
    const access = await requireWeddingMembership(supabase, wedding);
    if (!access.ok) throw new Error("no access");
    const dump = JSON.stringify(await listWeddingActivity(supabase, access.access));
    for (const forbidden of [created.token, rotated.ok ? rotated.token : "", recipient, "nuevo@example.com", "sin gluten", "/rsvp/"]) {
      expect(forbidden !== "" && dump.includes(forbidden), "no sensitive value reaches the page (redacted)").toBe(false);
    }
  });

  it("failed and unrecorded sends append nothing; WhatsApp preparation is not activity", async () => {
    const created = await createGuestParty(
      await sessionClient("ownerA"),
      wedding,
      { label: "Familia Sin Registro", guestNames: ["Eva"], contactEmail: "sinregistro@example.com" },
      APP_ORIGIN,
      ENCRYPTION,
    );
    if (!created.ok) throw new Error(created.reason);
    const before = await rowCount(wedding);

    const owner = await sessionClient("ownerA");
    // Provider refused: nothing recorded.
    expect(
      await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, delivery(fakeSender({ ok: false, reason: "provider_failure" }))),
    ).toMatchObject({ outcome: "failed", reason: "provider_failed" });
    expect(
      await sendRsvpReminderEmail(owner, wedding, created.guestInvitationId, delivery(fakeSender({ ok: false, reason: "provider_failure" })), ENCRYPTION),
    ).toMatchObject({ outcome: "provider_failed" });
    // Provider accepted, record failed: sent_but_unrecorded, and no history is fabricated.
    expect(
      await sendGuestInvitationEmail(owner, wedding, created.guestInvitationId, created.token, delivery(fakeSender(), true)),
    ).toMatchObject({ outcome: "sent_but_unrecorded" });
    expect(
      await sendRsvpReminderEmail(owner, wedding, created.guestInvitationId, delivery(fakeSender(), true), ENCRYPTION),
    ).toMatchObject({ outcome: "sent_but_unrecorded" });
    // Preparing a WhatsApp text is not delivery.
    expect((await prepareRsvpReminderMessage(owner, wedding, created.guestInvitationId, CONFIG)).ok).toBe(true);
    expect(await rowCount(wedding)).toBe(before);

    // A guest's RSVP whose confirmation couldn't be recorded: the RSVP is history, the email isn't.
    const [guestId] = await guestIdsOf(created.guestInvitationId);
    const saved = await submitRsvpWithConfirmation(
      anonClient(),
      created.token,
      [{ guestId: guestId!, attending: true, dietaryNote: null }],
      () => delivery(fakeSender(), true),
    );
    expect(saved).toMatchObject({ rsvp: "saved", confirmation: "sent_but_unrecorded" });
    expect(await rowCount(wedding)).toBe(before + 1);
    expect((await activityPage("ownerA", wedding))[0]?.[0]).toBe("RSVP recibido");

    // An invalid (revoked) link records nothing.
    expect((await revokeGuestPartyLink(owner, wedding, created.guestInvitationId)).ok).toBe(true);
    const refused = await submitRsvpWithConfirmation(
      anonClient(),
      created.token,
      [{ guestId: guestId!, attending: false, dietaryNote: null }],
      () => delivery(fakeSender()),
    );
    expect(refused).toMatchObject({ rsvp: "failed" });
    expect(await getGuestPartyByToken(anonClient(), tokenOf(`${APP_ORIGIN}/rsvp/${created.token}`))).toMatchObject({ ok: false });
    expect(await rowCount(wedding)).toBe(before + 2); // + the revocation only
  });

  it("deleting a party keeps its history under a generic label", async () => {
    const created = await createGuestParty(
      await sessionClient("collabA"),
      wedding,
      { label: "Familia Que Se Va", guestNames: ["Iris"] },
      APP_ORIGIN,
      ENCRYPTION,
    );
    if (!created.ok) throw new Error(created.reason);
    expect((await deleteGuestParty(await sessionClient("ownerA"), wedding, created.guestInvitationId)).ok).toBe(true);
    const page = await activityPage("ownerA", wedding);
    expect(page).toContainEqual(["Invitación creada", "Grupo eliminado", "Por Sofía"]);
    expect(JSON.stringify(page)).not.toContain("Familia Que Se Va");
  });
});
