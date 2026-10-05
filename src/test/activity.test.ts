import { describe, expect, it, vi } from "vitest";

import {
  activityActorLabel,
  activityActorLine,
  activityEventLabel,
  activityPartyLabel,
  type ActivityEventType,
} from "@/lib/activity/presentation";
import type { WeddingAccess } from "@/lib/authz/wedding";
import { es } from "@/lib/i18n/messages/es";
import { Constants } from "@/lib/supabase/database.types";
import { labelMembers, type WeddingMember } from "@/lib/weddings/members";

vi.mock("server-only", () => ({}));

const { ACTIVITY_LIMIT, listWeddingActivity } = await import("@/lib/activity/service");

const copy = es.activity;

function member(membershipId: string, role: WeddingMember["role"], options: Partial<WeddingMember> = {}): WeddingMember {
  return { membershipId, role, displayName: null, isCurrentUser: false, joinedAt: "2026-10-01T10:00:00.000Z", ...options };
}

describe("activityEventLabel (LB-15)", () => {
  it("labels every event the database can store, in Spanish", () => {
    const labels = Constants.public.Enums.wedding_activity_event.map((type) => activityEventLabel(type));
    expect(labels).toEqual([
      "Invitación creada",
      "Enlace personal regenerado",
      "Acceso RSVP revocado",
      "Correo de contacto actualizado",
      "Invitación enviada por correo",
      "RSVP recibido",
      "RSVP actualizado",
      "Confirmación RSVP enviada",
      "Recordatorio RSVP enviado",
    ]);
    // Every event has its own words (no accidental fallback).
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain(copy.events.unknown);
  });

  it("falls back to a neutral word for an unknown type (never throws, never echoes it)", () => {
    for (const unknown of ["scheduler_ran", "<b>x</b>", "", "constructor", "__proto__"]) {
      expect(activityEventLabel(unknown)).toBe(copy.events.unknown);
    }
  });

  it("is exhaustive at compile time over the database enum", () => {
    // A new enum value without a label is a type error in presentation.ts;
    // this keeps the enum and the catalog in step at runtime too.
    const types: readonly ActivityEventType[] = Constants.public.Enums.wedding_activity_event;
    expect(types).toHaveLength(9);
  });
});

describe("activityPartyLabel", () => {
  it("shows the party's current label, or a generic fallback once deleted", () => {
    expect(activityPartyLabel("Familia Pérez")).toBe("Familia Pérez");
    expect(activityPartyLabel(null)).toBe("Grupo eliminado");
  });
});

describe("activityActorLabel / activityActorLine", () => {
  const members = labelMembers([
    member("m-me", "owner", { isCurrentUser: true }),
    member("m-sofia", "collaborator", { displayName: "Sofía" }),
    member("m-anon", "collaborator"),
  ]);

  it("labels members like the rest of the app, by membership", () => {
    expect(activityActorLine(activityActorLabel("member", "m-me", members))).toBe("Por ti");
    expect(activityActorLine(activityActorLabel("member", "m-sofia", members))).toBe("Por Sofía");
    expect(activityActorLine(activityActorLabel("member", "m-anon", members))).toBe("Por Persona colaboradora");
  });

  it("a member who left (or an unknown membership) reads as a former member, never an id", () => {
    expect(activityActorLabel("member", null, members)).toBe(copy.actors.formerMember);
    expect(activityActorLabel("member", "m-gone", members)).toBe(copy.actors.formerMember);
    expect(activityActorLine(activityActorLabel("member", "m-gone", members))).toBe(
      "Por alguien que ya no está en la boda",
    );
  });

  it("the link holder is the group, and the system is never «service_role»", () => {
    expect(activityActorLine(activityActorLabel("guest_capability", null, members))).toBe(
      "Por el grupo, con su enlace personal",
    );
    expect(activityActorLine(activityActorLabel("system", null, members))).toBe("Por el sistema");
    expect(activityActorLabel("service_role", null, members)).toBe(copy.actors.system);
  });
});

describe("listWeddingActivity", () => {
  const access: WeddingAccess = {
    weddingId: "22222222-2222-4222-8222-222222222222",
    userId: "11111111-1111-4111-8111-111111111111",
    membershipId: "33333333-3333-4333-8333-333333333333",
    role: "collaborator",
  };

  function clientReturning(result: unknown) {
    const rpc = vi.fn(async () => result);
    const from = vi.fn();
    // Only `rpc` exists on the stub: any table access would throw.
    return { rpc, from, supabase: { rpc, from } as unknown as Parameters<typeof listWeddingActivity>[0] };
  }

  it("makes ONE bounded read of the authorized wedding and maps the safe columns", async () => {
    const row = {
      id: "a1",
      event_type: "guest_rsvp_updated",
      occurred_at: "2026-10-04T12:00:00+00:00",
      guest_invitation_id: null,
      party_label: null,
      actor_kind: "guest_capability",
      actor_membership_id: null,
    };
    const { supabase, rpc, from } = clientReturning({ data: [row], error: null });
    expect(await listWeddingActivity(supabase, access)).toEqual([
      {
        id: "a1",
        eventType: "guest_rsvp_updated",
        occurredAt: "2026-10-04T12:00:00+00:00",
        guestInvitationId: null,
        partyLabel: null,
        actorKind: "guest_capability",
        actorMembershipId: null,
      },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_wedding_activity", {
      target_wedding_id: access.weddingId,
      max_events: ACTIVITY_LIMIT,
    });
    expect(ACTIVITY_LIMIT).toBe(50);
    expect(from).not.toHaveBeenCalled();
  });

  it("an error or an exception is null (the page shows a load failure), nothing echoed", async () => {
    expect(await listWeddingActivity(clientReturning({ data: null, error: { code: "42501" } }).supabase, access)).toBeNull();
    const throwing = { rpc: vi.fn(async () => Promise.reject(new Error("down"))) } as unknown as Parameters<
      typeof listWeddingActivity
    >[0];
    expect(await listWeddingActivity(throwing, access)).toBeNull();
  });
});
