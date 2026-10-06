import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The privileged client is replaced by a recorder of what the store asks
// for: no network, no key.
const rpcCalls = vi.hoisted(() => [] as Array<{ name: string; args: unknown }>);
const fromCalls = vi.hoisted(() => [] as string[]);
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: null, error: { message: "fake" } };
    },
    from: (table: string) => {
      fromCalls.push(table);
      throw new Error("no table access");
    },
  }),
}));

const storeModule = await import("@/lib/scheduler/rsvp-reminder-store");

// LB-17 (ADR-010 §21): the second service-role module exposes exactly five
// named operations, each one fixed RPC, and nothing generic.

const OCC = { occurrenceId: "6a1f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", claimToken: "7b2e2d3f-4c5e-4f60-9bac-1d2e3f4a5b6c" };
const HASH = "a".repeat(64);

describe("rsvp-reminder-store", () => {
  it("exports only the factory and the env-based getter; no client, no generic helper", () => {
    expect(Object.keys(storeModule).sort()).toEqual(["createRsvpReminderStore", "getRsvpReminderStore"]);
  });

  it("a store has exactly claim, prepare, begin, record and finish", () => {
    const store = storeModule.createRsvpReminderStore({ supabaseUrl: "http://127.0.0.1:54321", serviceRoleKey: "sb_secret_x" });
    expect(Object.keys(store).sort()).toEqual(["begin", "claim", "finish", "prepare", "record"]);
  });

  it("each operation calls its one fixed RPC and never a table", async () => {
    rpcCalls.length = 0;
    const store = storeModule.createRsvpReminderStore({ supabaseUrl: "http://127.0.0.1:54321", serviceRoleKey: "sb_secret_x" });
    await store.claim(50, 25);
    await store.prepare(OCC);
    await store.begin(OCC, { tokenHash: HASH, recipient: "familia@example.com" });
    await store.record({ ...OCC, tokenHash: HASH, recipient: "familia@example.com", providerMessageId: "msg-1" });
    await store.finish(OCC, "retry");
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "claim_automatic_rsvp_reminders",
      "prepare_automatic_rsvp_reminder",
      "begin_automatic_rsvp_reminder_send",
      "record_automatic_rsvp_reminder_email",
      "finish_automatic_rsvp_reminder",
    ]);
    expect(fromCalls).toEqual([]);
  });

  it("refuses malformed ids before reaching the database, and maps failures to safe results", async () => {
    rpcCalls.length = 0;
    const store = storeModule.createRsvpReminderStore({ supabaseUrl: "http://127.0.0.1:54321", serviceRoleKey: "sb_secret_x" });
    const bad = { occurrenceId: "not-a-uuid", claimToken: OCC.claimToken };
    expect(await store.prepare(bad)).toEqual({ status: "error" });
    expect(await store.begin(bad, { tokenHash: HASH, recipient: "x@example.com" })).toEqual({ status: "error" });
    expect(await store.begin(OCC, { tokenHash: "short", recipient: "x@example.com" })).toEqual({ status: "error" });
    expect(await store.record({ ...OCC, tokenHash: HASH, recipient: "x@example.com", providerMessageId: "bad id" })).toEqual({
      ok: false,
    });
    expect(await store.finish(bad, "retry")).toBeNull();
    expect(rpcCalls).toEqual([]);
    // Database errors: null claim, "error" statuses, never a throw.
    expect(await store.claim(50, 25)).toBeNull();
  });
});
