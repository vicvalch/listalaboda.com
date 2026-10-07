import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The privileged client is replaced by a recorder of what the store asks
// for: no network, no key.
const rpcCalls = vi.hoisted(() => [] as Array<{ name: string; args: unknown }>);
const fromCalls = vi.hoisted(() => [] as string[]);
const nextResult = vi.hoisted(() => ({ value: { data: "applied" as unknown, error: null as unknown } }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return nextResult.value;
    },
    from: (table: string) => {
      fromCalls.push(table);
      throw new Error("no table access");
    },
  }),
}));

const storeModule = await import("@/lib/email/delivery-event-store");

// LB-18.2 (ADR-011 §7, ADR-002 §6): the third service-role module exposes
// exactly one named operation, one fixed RPC, and nothing generic.

const SETTINGS = { supabaseUrl: "http://127.0.0.1:54321", serviceRoleKey: "sb_secret_x" };
const EVENT = {
  providerMessageId: "outbox-6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  eventType: "delivered",
  occurredAt: "2026-10-06T12:00:00.000Z",
  bounceType: null,
} as const;

describe("delivery-event-store", () => {
  it("exports only the factory and the env-based getter; no client, no generic helper", () => {
    expect(Object.keys(storeModule).sort()).toEqual(["createDeliveryEventStore", "getDeliveryEventStore"]);
  });

  it("a store has exactly ingest", () => {
    expect(Object.keys(storeModule.createDeliveryEventStore(SETTINGS))).toEqual(["ingest"]);
  });

  it("ingest calls its one fixed RPC with normalized fields only, never a table", async () => {
    rpcCalls.length = 0;
    const store = storeModule.createDeliveryEventStore(SETTINGS);
    expect(await store.ingest({ providerEventId: "msg_abc", event: EVENT })).toBe("applied");
    expect(await store.ingest({ providerEventId: "msg_def", event: { ...EVENT, eventType: "bounced", bounceType: "permanent" } })).toBe(
      "applied",
    );
    expect(rpcCalls).toEqual([
      {
        name: "ingest_email_delivery_event",
        args: {
          provider_event_id: "msg_abc",
          provider_message_id: EVENT.providerMessageId,
          event_type: "delivered",
          occurred_at: EVENT.occurredAt,
        },
      },
      {
        name: "ingest_email_delivery_event",
        args: {
          provider_event_id: "msg_def",
          provider_message_id: EVENT.providerMessageId,
          event_type: "bounced",
          occurred_at: EVENT.occurredAt,
          bounce_type: "permanent",
        },
      },
    ]);
    expect(fromCalls).toEqual([]);
  });

  it("refuses malformed input before reaching the database", async () => {
    rpcCalls.length = 0;
    const store = storeModule.createDeliveryEventStore(SETTINGS);
    expect(await store.ingest({ providerEventId: "msg with space", event: EVENT })).toBe("error");
    expect(await store.ingest({ providerEventId: "msg_abc", event: { ...EVENT, providerMessageId: "https://x/rsvp/a" } })).toBe("error");
    expect(await store.ingest({ providerEventId: "msg_abc", event: { ...EVENT, bounceType: "permanent" } })).toBe("error");
    expect(await store.ingest({ providerEventId: "msg_abc", event: { ...EVENT, eventType: "bounced" } })).toBe("error");
    expect(rpcCalls).toEqual([]);
  });

  it("maps database errors and unexpected answers to error", async () => {
    const store = storeModule.createDeliveryEventStore(SETTINGS);
    for (const value of [
      { data: null, error: { message: "fake" } },
      { data: "something_else", error: null },
      { data: { status: "applied" }, error: null },
      { data: null, error: null },
    ]) {
      nextResult.value = value;
      expect(await store.ingest({ providerEventId: "msg_abc", event: EVENT })).toBe("error");
    }
    for (const outcome of ["applied", "no_change", "duplicate", "unknown_message"]) {
      nextResult.value = { data: outcome, error: null };
      expect(await store.ingest({ providerEventId: "msg_abc", event: EVENT })).toBe(outcome);
    }
  });

  it("without a service-role key there is no store", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(storeModule.getDeliveryEventStore()).toBeNull();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_publishable_not_a_secret");
    expect(storeModule.getDeliveryEventStore()).toBeNull();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_x");
    expect(storeModule.getDeliveryEventStore()).not.toBeNull();
    vi.unstubAllEnvs();
  });
});
