import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { TEST_RESEND_WEBHOOK_SECRET, resendEventBody, signWebhook } from "@/test/fixtures/resend-webhook";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

import type { TestUserKey } from "./context";
import {
  PERMISSION_DENIED,
  addMember,
  as,
  createWedding as createFixtureWedding,
  ctx,
  serviceRole,
  shapedEnvelope,
  sql,
  users,
} from "./support";

vi.mock("server-only", () => ({}));

const { createDeliveryEventStore } = await import("@/lib/email/delivery-event-store");
const { createDeliveryRecorder } = await import("@/lib/email/delivery-recorder");
const { createOutboxSender } = await import("@/lib/email/outbox");
const { createGuestParty } = await import("@/lib/guests/service");
const { sendGuestInvitationEmail } = await import("@/lib/guests/invitation-email");
const route = await import("@/app/api/webhooks/resend/route");

// LB-18.2 (ADR-011 §7): delivery status, the append-only provider event
// ledger and the one service_role-only ingest function, exercised as real
// anon, authenticated and service_role callers. The superuser connection
// only arranges fixtures and reads ground truth, except where a test proves
// a guard holds even for it.

type Status = Database["public"]["Enums"]["email_delivery_status"];
type EventType = Database["public"]["Enums"]["email_delivery_event_type"];
type BounceType = Database["public"]["Enums"]["email_bounce_type"];

const GUARD = "55000";
const UNIQUE_VIOLATION = "23505";
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

type Party = { id: string; hash: string; weddingId: string };

async function createParty(weddingId: string, label: string, contactEmail: string, actor: TestUserKey = "ownerA"): Promise<Party> {
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

let labelCounter = 0;

/** A party with one recorded invitation email (the real record function). */
async function recordedSend(weddingId: string, label = `Envio ${++labelCounter}`) {
  const email = `envio-${labelCounter}-${randomUUID().slice(0, 8)}@example.com`;
  const party = await createParty(weddingId, label, email);
  const providerId = `msg_${randomUUID()}`;
  const { error } = await serviceRole.rpc("record_guest_invitation_email", {
    target_wedding_id: party.weddingId,
    target_invitation_id: party.id,
    invitation_token_hash: party.hash,
    recipient: email,
    provider_message_id: providerId,
    acting_user_id: users.ownerA.id,
  });
  if (error) throw new Error(`record failed: ${error.message}`);
  const [delivery] = await sql<{ id: string }>("select id from public.email_deliveries where provider_message_id = $1", [providerId]);
  return { party, email, providerId, deliveryId: delivery!.id };
}

let eventCounter = 0;
function eventId(): string {
  eventCounter += 1;
  return `msg_test${eventCounter}${randomUUID().replace(/-/g, "")}`;
}

type IngestArgs = {
  providerEventId?: string;
  providerMessageId: string;
  eventType: EventType;
  occurredAt?: string;
  bounceType?: BounceType;
};

function ingest(args: IngestArgs, client = serviceRole) {
  return client.rpc("ingest_email_delivery_event", {
    provider_event_id: args.providerEventId ?? eventId(),
    provider_message_id: args.providerMessageId,
    event_type: args.eventType,
    occurred_at: args.occurredAt ?? new Date().toISOString(),
    ...(args.bounceType ? { bounce_type: args.bounceType } : args.eventType === "bounced" ? { bounce_type: "permanent" as const } : {}),
  });
}

async function ingestOk(args: IngestArgs) {
  const { data, error } = await ingest(args);
  if (error) throw new Error(`ingest failed: ${error.message}`);
  return data;
}

async function deliveryState(deliveryId: string) {
  const [row] = await sql<{ status: Status; status_event_at: Date | null }>(
    "select status, status_event_at from public.email_deliveries where id = $1",
    [deliveryId],
  );
  return row;
}

async function eventsOf(deliveryId: string) {
  return sql<{ provider_event_id: string; event_type: EventType; bounce_type: BounceType | null; occurred_at: Date; wedding_id: string }>(
    `select provider_event_id, event_type::text as event_type, bounce_type::text as bounce_type, occurred_at, wedding_id
     from public.email_delivery_events where delivery_id = $1 order by received_at, id`,
    [deliveryId],
  );
}

let weddingA: string;
let weddingB: string;

beforeAll(async () => {
  weddingA = await fixtureWedding("ownerA", "Boda Eventos A");
  await addMember(weddingA, "collabA", "collaborator");
  weddingB = await fixtureWedding("ownerB", "Boda Eventos B");
});

describe("shape", () => {
  it("statuses, event types, bounce types and outcomes are exactly the closed sets", async () => {
    const labels = async (type: string) =>
      (
        await sql<{ label: string }>(
          "select e.enumlabel as label from pg_enum e where e.enumtypid = $1::regtype order by e.enumsortorder",
          [type],
        )
      ).map((r) => r.label);
    expect(await labels("public.email_delivery_status")).toEqual([
      "accepted",
      "delayed",
      "failed",
      "delivered",
      "suppressed",
      "bounced",
      "complained",
    ]);
    expect(await labels("public.email_delivery_event_type")).toEqual([
      "delivered",
      "delivery_delayed",
      "failed",
      "suppressed",
      "bounced",
      "complained",
    ]);
    expect(await labels("public.email_bounce_type")).toEqual(["permanent", "transient", "undetermined"]);
    expect(await labels("public.email_delivery_ingest_outcome")).toEqual(["applied", "no_change", "duplicate", "unknown_message"]);
  });

  it("the numeric rank table is exactly ADR-011's, and the enum's own order agrees with it", async () => {
    const rows = await sql<{ status: Status; rank: number; position: number }>(
      `select e.enumlabel as status,
              private.email_delivery_status_rank(e.enumlabel::public.email_delivery_status) as rank,
              e.enumsortorder as position
       from pg_enum e where e.enumtypid = 'public.email_delivery_status'::regtype order by e.enumsortorder`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.rank]))).toEqual({
      accepted: 0,
      delayed: 10,
      failed: 20,
      delivered: 30,
      suppressed: 40,
      bounced: 50,
      complained: 60,
    });
    const ranks = rows.map((r) => r.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("the event ledger stores no recipient, subject, sender, payload, reason, link, IP or user agent", async () => {
    const rows = await sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'email_delivery_events' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "id",
      "delivery_id",
      "wedding_id",
      "provider_event_id",
      "event_type",
      "bounce_type",
      "occurred_at",
      "received_at",
    ]);
  });

  it("a newly recorded email is accepted with no status_event_at", async () => {
    const { deliveryId } = await recordedSend(weddingA);
    expect(await deliveryState(deliveryId)).toEqual({ status: "accepted", status_event_at: null });
  });
});

describe("status advances by rank", () => {
  const advances: Array<[string, EventType[], Status]> = [
    ["accepted → delivered", ["delivered"], "delivered"],
    ["accepted → delayed", ["delivery_delayed"], "delayed"],
    ["accepted → failed", ["failed"], "failed"],
    ["delayed → delivered", ["delivery_delayed", "delivered"], "delivered"],
    ["failed → delivered", ["failed", "delivered"], "delivered"],
    ["delivered → suppressed", ["delivered", "suppressed"], "suppressed"],
    ["delivered → bounced", ["delivered", "bounced"], "bounced"],
    ["delivered → complained", ["delivered", "complained"], "complained"],
    ["bounced → complained", ["bounced", "complained"], "complained"],
  ];
  it.each(advances)("%s", async (_label, events, expected) => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    for (const eventType of events) {
      expect(await ingestOk({ providerMessageId: providerId, eventType })).toBe("applied");
    }
    expect((await deliveryState(deliveryId))!.status).toBe(expected);
    expect(await eventsOf(deliveryId)).toHaveLength(events.length);
  });
});

describe("out-of-order and same-rank events add history only", () => {
  const regressions: Array<[string, EventType, EventType, Status]> = [
    ["delivered then delayed", "delivered", "delivery_delayed", "delivered"],
    ["bounced then delivered", "bounced", "delivered", "bounced"],
    ["complained then bounced", "complained", "bounced", "complained"],
    ["failed then delayed", "failed", "delivery_delayed", "failed"],
    ["complained then delivered", "complained", "delivered", "complained"],
    ["suppressed then failed", "suppressed", "failed", "suppressed"],
  ];
  it.each(regressions)("%s → stays %s, both events recorded", async (_label, first, second, expected) => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const t1 = "2026-10-06T10:00:00.000Z";
    // The lower-rank event even claims to be LATER: the timestamp never decides.
    const t2 = "2026-10-06T11:00:00.000Z";
    expect(await ingestOk({ providerMessageId: providerId, eventType: first, occurredAt: t1 })).toBe("applied");
    expect(await ingestOk({ providerMessageId: providerId, eventType: second, occurredAt: t2 })).toBe("no_change");
    expect(await deliveryState(deliveryId)).toEqual({ status: expected, status_event_at: new Date(t1) });
    expect((await eventsOf(deliveryId)).map((e) => e.event_type)).toEqual([first, second]);
  });

  it("same-rank events with different provider event ids each create a history row", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const t1 = "2026-10-06T10:00:00.000Z";
    expect(await ingestOk({ providerMessageId: providerId, eventType: "delivery_delayed", occurredAt: t1 })).toBe("applied");
    expect(await ingestOk({ providerMessageId: providerId, eventType: "delivery_delayed", occurredAt: "2026-10-06T10:30:00.000Z" })).toBe(
      "no_change",
    );
    expect(await ingestOk({ providerMessageId: providerId, eventType: "delivery_delayed", occurredAt: "2026-10-06T11:00:00.000Z" })).toBe(
      "no_change",
    );
    expect(await eventsOf(deliveryId)).toHaveLength(3);
    expect(await deliveryState(deliveryId)).toEqual({ status: "delayed", status_event_at: new Date(t1) });
  });

  it("status_event_at follows the event that last ADVANCED the status", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "delivery_delayed", occurredAt: "2026-10-06T09:00:00.000Z" });
    await ingestOk({ providerMessageId: providerId, eventType: "delivered", occurredAt: "2026-10-06T10:00:00.000Z" });
    await ingestOk({ providerMessageId: providerId, eventType: "delivery_delayed", occurredAt: "2026-10-06T12:00:00.000Z" });
    expect(await deliveryState(deliveryId)).toEqual({ status: "delivered", status_event_at: new Date("2026-10-06T10:00:00.000Z") });
    // A higher rank advances even with an EARLIER provider timestamp.
    await ingestOk({ providerMessageId: providerId, eventType: "bounced", occurredAt: "2026-10-06T08:00:00.000Z" });
    expect(await deliveryState(deliveryId)).toEqual({ status: "bounced", status_event_at: new Date("2026-10-06T08:00:00.000Z") });
  });

  it("bounce types are stored for bounces only", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    await ingestOk({ providerMessageId: providerId, eventType: "bounced", bounceType: "transient" });
    expect((await eventsOf(deliveryId)).map((e) => [e.event_type, e.bounce_type])).toEqual([
      ["delivered", null],
      ["bounced", "transient"],
    ]);
  });
});

describe("idempotency by provider event id", () => {
  it("a duplicate creates one row and changes nothing (status nor status_event_at)", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const id = eventId();
    expect(await ingestOk({ providerEventId: id, providerMessageId: providerId, eventType: "delivered", occurredAt: "2026-10-06T10:00:00.000Z" })).toBe(
      "applied",
    );
    const before = await deliveryState(deliveryId);
    // The provider's retry; even a tampered retry under the same id is a no-op.
    for (const [eventType, occurredAt] of [
      ["delivered", "2026-10-06T10:00:00.000Z"],
      ["complained", "2026-10-06T12:00:00.000Z"],
    ] as const) {
      expect(await ingestOk({ providerEventId: id, providerMessageId: providerId, eventType, occurredAt })).toBe("duplicate");
    }
    expect(await deliveryState(deliveryId)).toEqual(before);
    expect(await eventsOf(deliveryId)).toHaveLength(1);
  });

  it("the unique constraint holds for direct inserts too", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const id = eventId();
    await ingestOk({ providerEventId: id, providerMessageId: providerId, eventType: "delivered" });
    await expect(
      sql(
        `insert into public.email_delivery_events (delivery_id, wedding_id, provider_event_id, event_type, occurred_at)
         values ($1, $2, $3, 'delivered', now())`,
        [deliveryId, weddingA, id],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it("concurrent deliveries of one event: exactly one row, one transition, the rest duplicate, no errors", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const id = eventId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ingest({ providerEventId: id, providerMessageId: providerId, eventType: "bounced" })),
    );
    expect(results.map((r) => r.error)).toEqual(Array(8).fill(null));
    const outcomes = results.map((r) => r.data).sort();
    expect(outcomes).toEqual(["applied", ...Array(7).fill("duplicate")].sort());
    expect(await eventsOf(deliveryId)).toHaveLength(1);
    expect((await deliveryState(deliveryId))!.status).toBe("bounced");
  });

  it("a second transaction waits on the first and then sees a duplicate (deterministic interleaving)", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    const id = eventId();
    const first = new pg.Client({ connectionString: ctx.dbUrl });
    const second = new pg.Client({ connectionString: ctx.dbUrl });
    await first.connect();
    await second.connect();
    try {
      const call = "select public.ingest_email_delivery_event($1, $2, 'delivered', now(), null)::text as outcome";
      await first.query("begin; set local role service_role;");
      const [firstOutcome] = (await first.query<{ outcome: string }>(call, [id, providerId])).rows;
      await second.query("begin; set local role service_role;");
      const pending = second.query<{ outcome: string }>(call, [id, providerId]);
      // The second call blocks on the delivery row lock until the first commits.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("commit");
      const [secondOutcome] = (await pending).rows;
      await second.query("commit");
      expect([firstOutcome!.outcome, secondOutcome!.outcome]).toEqual(["applied", "duplicate"]);
    } finally {
      await first.end();
      await second.end();
    }
    expect(await eventsOf(deliveryId)).toHaveLength(1);
  });
});

describe("correlation: the provider email id only", () => {
  it("an unknown provider email id → unknown_message, nothing written anywhere", async () => {
    const [before] = await sql<{ n: string }>("select count(*)::text as n from public.email_delivery_events");
    const [deliveriesBefore] = await sql<{ n: string }>("select count(*)::text as n from public.email_deliveries");
    expect(await ingestOk({ providerMessageId: `msg_${randomUUID()}`, eventType: "bounced" })).toBe("unknown_message");
    expect(await sql("select count(*)::text as n from public.email_delivery_events")).toEqual([before]);
    expect(await sql("select count(*)::text as n from public.email_deliveries")).toEqual([deliveriesBefore]);
  });

  it("the event lands on the delivery's own wedding; the function takes no tenant input", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    expect((await eventsOf(deliveryId)).map((e) => e.wedding_id)).toEqual([weddingA]);
    const [fn] = await sql<{ args: string }>(
      "select pg_get_function_identity_arguments('public.ingest_email_delivery_event'::regproc) as args",
    );
    expect(fn!.args).not.toMatch(/wedding|invitation|delivery_id|recipient|payload/);
  });

  it("malformed input is refused with one uniform error, before anything is written", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    for (const [label, args] of [
      ["bad event id", { providerEventId: "id with spaces", providerMessageId: providerId, eventType: "delivered" }],
      ["URL as provider id", { providerMessageId: "https://x/rsvp/abc", eventType: "delivered" }],
      ["bounce type on a non-bounce", { providerMessageId: providerId, eventType: "delivered", bounceType: "permanent" }],
    ] as const) {
      const { error } = await ingest(args as IngestArgs);
      expect(error?.message, label).toBe("email_delivery_event_invalid");
    }
    const noBounceType = await serviceRole.rpc("ingest_email_delivery_event", {
      provider_event_id: eventId(),
      provider_message_id: providerId,
      event_type: "bounced",
      occurred_at: new Date().toISOString(),
    });
    expect(noBounceType.error?.message).toBe("email_delivery_event_invalid");
    expect(await eventsOf(deliveryId)).toEqual([]);
    expect((await deliveryState(deliveryId))!.status).toBe("accepted");
  });
});

describe("privileges", () => {
  it("anon and authenticated (members included) cannot execute the ingest function", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    for (const actor of ["anon", "ownerA", "collabA", "outsider"] as const) {
      const { data, error } = await ingest({ providerMessageId: providerId, eventType: "complained" }, as[actor]);
      expect(error?.code, actor).toBe(PERMISSION_DENIED);
      expect(data, actor).toBeNull();
    }
    expect(await eventsOf(deliveryId)).toEqual([]);
    expect((await deliveryState(deliveryId))!.status).toBe("accepted");
  });

  it("service_role can execute it (and only it writes)", async () => {
    const { providerId } = await recordedSend(weddingA);
    expect(await ingestOk({ providerMessageId: providerId, eventType: "delivered" })).toBe("applied");
    const [grants] = await sql<{ anon: boolean; authenticated: boolean; service_role: boolean; public: boolean }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public
       from pg_proc p where p.oid = 'public.ingest_email_delivery_event'::regproc`,
    );
    expect(grants).toEqual({ anon: false, authenticated: false, service_role: true, public: false });
    const [fn] = await sql<{ secdef: boolean; config: string[] }>(
      "select prosecdef as secdef, proconfig as config from pg_proc where oid = 'public.ingest_email_delivery_event'::regproc",
    );
    expect(fn).toEqual({ secdef: true, config: ['search_path=""'] });
  });

  it("no client role (nor service_role directly) can read or write the event ledger", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    for (const [actor, client] of [
      ["anon", as.anon],
      ["ownerA", as.ownerA],
      ["collabA", as.collabA],
      ["outsider", as.outsider],
      ["service_role", serviceRole],
    ] as const) {
      const read = await client.from("email_delivery_events").select("id").eq("delivery_id", deliveryId);
      expect(read.error?.code, `${actor} select`).toBe(PERMISSION_DENIED);
      const inserted = await client.from("email_delivery_events").insert({
        delivery_id: deliveryId,
        wedding_id: weddingA,
        provider_event_id: eventId(),
        event_type: "complained",
        occurred_at: new Date().toISOString(),
      });
      expect(inserted.error?.code, `${actor} insert`).toBe(PERMISSION_DENIED);
      const updated = await client.from("email_delivery_events").update({ event_type: "complained" }).eq("delivery_id", deliveryId);
      expect(updated.error?.code, `${actor} update`).toBe(PERMISSION_DENIED);
      const deleted = await client.from("email_delivery_events").delete().eq("delivery_id", deliveryId);
      expect(deleted.error?.code, `${actor} delete`).toBe(PERMISSION_DENIED);
    }
    expect(await eventsOf(deliveryId)).toHaveLength(1);
  });

  it("clients still can't read the status or the provider id, nor update a delivery", async () => {
    const { party, deliveryId } = await recordedSend(weddingA);
    for (const actor of ["ownerA", "collabA"] as const) {
      const status = await as[actor].from("email_deliveries").select("status").eq("guest_invitation_id", party.id);
      expect(status.error?.code, actor).toBe(PERMISSION_DENIED);
      const updated = await as[actor].from("email_deliveries").update({ status: "delivered" }).eq("id", deliveryId);
      expect(updated.error?.code, actor).toBe(PERMISSION_DENIED);
    }
    expect((await deliveryState(deliveryId))!.status).toBe("accepted");
  });
});

describe("the database guards (every role)", () => {
  it("identity is still immutable, including next to a status change", async () => {
    const { deliveryId } = await recordedSend(weddingA);
    await expect(
      sql("update public.email_deliveries set recipient = 'otra@example.com' where id = $1", [deliveryId]),
    ).rejects.toMatchObject({ code: GUARD });
    await expect(
      sql(
        "update public.email_deliveries set status = 'delivered', status_event_at = now(), provider_message_id = $2 where id = $1",
        [deliveryId, `msg_${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: GUARD });
    const updated = await serviceRole.from("email_deliveries").update({ kind: "rsvp_reminder_manual" }).eq("id", deliveryId);
    expect(updated.error?.code).toBe(GUARD);
  });

  it("a direct status regression is refused, even for the superuser and service_role", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "bounced" });
    for (const status of ["delivered", "accepted", "bounced"] as const) {
      await expect(
        sql(
          "update public.email_deliveries set status = $2::public.email_delivery_status, status_event_at = case when $2::text = 'accepted' then null else now() end where id = $1",
          [
            deliveryId,
            status,
          ],
        ),
        status,
      ).rejects.toMatchObject({ code: GUARD });
    }
    const viaService = await serviceRole
      .from("email_deliveries")
      .update({ status: "delivered", status_event_at: new Date().toISOString() })
      .eq("id", deliveryId);
    expect(viaService.error?.code).toBe(GUARD);
    expect((await deliveryState(deliveryId))!.status).toBe("bounced");
  });

  it("inconsistent status / status_event_at combinations are refused", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await expect(
      sql("update public.email_deliveries set status = 'delivered' where id = $1", [deliveryId]),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      sql("update public.email_deliveries set status_event_at = now() where id = $1", [deliveryId]),
    ).rejects.toMatchObject({ code: GUARD });
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    // status_event_at never moves without a status advance.
    await expect(
      sql("update public.email_deliveries set status_event_at = status_event_at + interval '1 hour' where id = $1", [deliveryId]),
    ).rejects.toMatchObject({ code: GUARD });
  });

  it("a new delivery row can't start in any status but accepted", async () => {
    const party = await createParty(weddingA, "Inicio", "inicio@example.com");
    await expect(
      sql(
        `insert into public.email_deliveries (wedding_id, guest_invitation_id, kind, provider_message_id, recipient, status, status_event_at)
         values ($1, $2, 'guest_invitation', $3, 'inicio@example.com', 'delivered', now())`,
        [weddingA, party.id, `msg_${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: GUARD });
  });

  it("events are append-only, even for the superuser", async () => {
    const { providerId, deliveryId } = await recordedSend(weddingA);
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    await expect(
      sql("update public.email_delivery_events set event_type = 'complained' where delivery_id = $1", [deliveryId]),
    ).rejects.toMatchObject({ code: GUARD });
    await expect(sql("delete from public.email_delivery_events where delivery_id = $1", [deliveryId])).rejects.toMatchObject({
      code: GUARD,
    });
    expect(await eventsOf(deliveryId)).toHaveLength(1);
  });

  it("an event can't point at another wedding's delivery, and bounce_type is for bounces only", async () => {
    const { deliveryId } = await recordedSend(weddingA);
    await expect(
      sql(
        `insert into public.email_delivery_events (delivery_id, wedding_id, provider_event_id, event_type, occurred_at)
         values ($1, $2, $3, 'delivered', now())`,
        [deliveryId, weddingB, eventId()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    for (const [eventType, bounce] of [
      ["delivered", "permanent"],
      ["bounced", null],
    ] as const) {
      await expect(
        sql(
          `insert into public.email_delivery_events (delivery_id, wedding_id, provider_event_id, event_type, bounce_type, occurred_at)
           values ($1, $2, $3, $4, $5, now())`,
          [deliveryId, weddingA, eventId(), eventType, bounce],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });
});

describe("deletion and late events", () => {
  it("deleting the party removes its deliveries and their events; a late webhook is unknown_message", async () => {
    const doomed = await recordedSend(weddingA, "Borrado eventos");
    const kept = await recordedSend(weddingA, "Conservado eventos");
    await ingestOk({ providerMessageId: doomed.providerId, eventType: "delivered" });
    await ingestOk({ providerMessageId: kept.providerId, eventType: "delivered" });

    const deleted = await as.collabA.from("guest_invitations").delete().eq("id", doomed.party.id).select("id");
    expect(deleted.error).toBeNull();
    expect(await sql("select 1 from public.email_deliveries where id = $1", [doomed.deliveryId])).toEqual([]);
    expect(await sql("select 1 from public.email_delivery_events where delivery_id = $1", [doomed.deliveryId])).toEqual([]);
    expect(await eventsOf(kept.deliveryId)).toHaveLength(1);

    expect(await ingestOk({ providerMessageId: doomed.providerId, eventType: "bounced" })).toBe("unknown_message");
    expect(await sql("select 1 from public.email_delivery_events where delivery_id = $1", [doomed.deliveryId])).toEqual([]);
  });

  it("deleting the wedding removes its deliveries' events", async () => {
    const doomedWedding = await fixtureWedding("ownerA", "Boda Eventos Borrada");
    const doomed = await recordedSend(doomedWedding);
    await ingestOk({ providerMessageId: doomed.providerId, eventType: "delivered" });
    await sql("delete from public.weddings where id = $1", [doomedWedding]);
    expect(await sql("select 1 from public.email_delivery_events where wedding_id = $1", [doomedWedding])).toEqual([]);
  });
});

describe("delivery status is separate from execution and business state", () => {
  it("a bounce changes no latest-send metadata, activity row or automatic reminder occurrence", async () => {
    const { party, providerId } = await recordedSend(weddingA);
    const snapshot = async () => ({
      party: await sql(
        `select invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id, contact_email, revoked_at, token_hash
         from public.guest_invitations where id = $1`,
        [party.id],
      ),
      activity: await sql("select id, event_type::text from public.wedding_activity where guest_invitation_id = $1 order by occurred_at, id", [
        party.id,
      ]),
      occurrences: await sql("select * from public.automatic_rsvp_reminders where guest_invitation_id = $1", [party.id]),
    });
    const before = await snapshot();
    await ingestOk({ providerMessageId: providerId, eventType: "delivered" });
    await ingestOk({ providerMessageId: providerId, eventType: "bounced", bounceType: "permanent" });
    await ingestOk({ providerMessageId: providerId, eventType: "complained" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("full local path: outbox send → recorder → signed webhook → route → ingest", () => {
  let outboxDir: string;

  beforeAll(async () => {
    outboxDir = await mkdtemp(join(tmpdir(), "lb-webhook-outbox-"));
  });
  afterAll(async () => {
    await rm(outboxDir, { recursive: true, force: true });
  });

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

  function post(body: string, headers: Record<string, string>) {
    return route.POST(new NextRequest("http://localhost:3100/api/webhooks/resend", { method: "POST", headers, body }));
  }

  it("a correctly signed bounce for a real send advances its status and nothing else", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_RESEND_WEBHOOK_SECRET);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ctx.apiUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", ctx.publishableKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", ctx.secretKey);
    try {
      const owner = await sessionClient("ownerA");
      const email = `integracion-${randomUUID().slice(0, 8)}@example.com`;
      const created = await createGuestParty(
        owner,
        weddingA,
        { label: "Integración webhook", guestNames: ["Invitada Uno"], contactEmail: email },
        "http://localhost:3100",
        { key: TEST_RSVP_CAPABILITY_KEY },
      );
      if (!created.ok) throw new Error(`createGuestParty failed: ${created.reason}`);

      const sent = await sendGuestInvitationEmail(owner, weddingA, created.guestInvitationId, created.token, {
        sender: createOutboxSender(outboxDir),
        appOrigin: "http://localhost:3100",
        recorder: createDeliveryRecorder({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey }),
      });
      expect(sent).toMatchObject({ outcome: "sent" });

      const [delivery] = await sql<{ id: string; provider_message_id: string }>(
        "select id, provider_message_id from public.email_deliveries where guest_invitation_id = $1",
        [created.guestInvitationId],
      );
      expect(delivery!.provider_message_id).toMatch(/^outbox-/);

      const businessBefore = await sql(
        `select invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id
         from public.guest_invitations where id = $1`,
        [created.guestInvitationId],
      );
      const activityBefore = await sql("select id from public.wedding_activity where wedding_id = $1 order by id", [weddingA]);

      // A decoy tenant in the payload (another wedding's id in tags) is never used.
      const body = resendEventBody("email.bounced", delivery!.provider_message_id, {
        createdAt: "2026-10-06T12:00:00.000Z",
        data: { bounce: { type: "Permanent", subType: "General", message: "decoy" }, tags: { wedding_id: weddingB } },
      });
      const id = eventId();
      const signed = signWebhook(body, { id });

      const response = await post(signed.body, signed.headers);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");

      expect(await deliveryState(delivery!.id)).toEqual({
        status: "bounced",
        status_event_at: new Date("2026-10-06T12:00:00.000Z"),
      });
      expect(await eventsOf(delivery!.id)).toEqual([
        expect.objectContaining({ provider_event_id: id, event_type: "bounced", bounce_type: "permanent", wedding_id: weddingA }),
      ]);
      expect(
        await sql(
          `select invitation_email_sent_at, invitation_email_sent_to, invitation_email_provider_id
           from public.guest_invitations where id = $1`,
          [created.guestInvitationId],
        ),
      ).toEqual(businessBefore);
      expect(await sql("select id from public.wedding_activity where wedding_id = $1 order by id", [weddingA])).toEqual(activityBefore);

      // The provider's retry of the same event: 200, still one row.
      expect((await post(signed.body, signed.headers)).status).toBe(200);
      expect(await eventsOf(delivery!.id)).toHaveLength(1);

      // A forged event (wrong signature) changes nothing: 401.
      const forged = signWebhook(resendEventBody("email.complained", delivery!.provider_message_id), {
        id: eventId(),
        secret: `whsec_${Buffer.from("TEST-ONLY-forger-webhook-key-000").toString("base64")}`,
      });
      expect((await post(forged.body, forged.headers)).status).toBe(401);
      expect((await deliveryState(delivery!.id))!.status).toBe("bounced");

      // An event for an email this app never recorded: 200, nothing written.
      const stranger = signWebhook(resendEventBody("email.delivered", `msg_${randomUUID()}`), { id: eventId() });
      const [countBefore] = await sql("select count(*)::text as n from public.email_delivery_events");
      expect((await post(stranger.body, stranger.headers)).status).toBe(200);
      expect(await sql("select count(*)::text as n from public.email_delivery_events")).toEqual([countBefore]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the store against the real database returns the closed outcomes", async () => {
    const store = createDeliveryEventStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.secretKey });
    const { providerId } = await recordedSend(weddingA);
    const id = eventId();
    const event = { providerMessageId: providerId, eventType: "delivered", occurredAt: new Date().toISOString(), bounceType: null } as const;
    expect(await store.ingest({ providerEventId: id, event })).toBe("applied");
    expect(await store.ingest({ providerEventId: id, event })).toBe("duplicate");
    expect(await store.ingest({ providerEventId: eventId(), event: { ...event, eventType: "delivery_delayed" } })).toBe("no_change");
    expect(await store.ingest({ providerEventId: eventId(), event: { ...event, providerMessageId: `msg_${randomUUID()}` } })).toBe(
      "unknown_message",
    );
    // A publishable key is not service_role: refused, reported as error.
    const weak = createDeliveryEventStore({ supabaseUrl: ctx.apiUrl, serviceRoleKey: ctx.publishableKey });
    expect(await weak.ingest({ providerEventId: eventId(), event })).toBe("error");
  });
});
