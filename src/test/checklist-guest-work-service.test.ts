import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

vi.mock("server-only", () => ({}));

const { getWeddingChecklist, setChecklistItemGuestParty } = await import("@/lib/checklist/service");
const { listGuestParties, listGuestPartyOptions } = await import("@/lib/guests/service");

// Application-layer tests for LB-16 (ADR-009): a real supabase-js client
// against a fake HTTP backend, asserting exactly what is sent, what is read
// and how failures map. The database invariants (same-wedding FK, RLS,
// delete behaviour) are tested in tests/db.

const SUPABASE_URL = "http://supabase.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  signedIn?: boolean;
  role?: "owner" | "collaborator" | null;
  patch?: Reply;
  /** GET replies by table name (default: an empty list). */
  get?: Record<string, Reply>;
  network?: boolean;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(signedIn: boolean): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>();
  if (signedIn) {
    items.set(
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    );
  }
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

function clientFor(backend: Backend) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (url.pathname === "/auth/v1/user") {
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname === "/rest/v1/wedding_memberships" && url.searchParams.has("user_id")) {
      const role = backend.role === undefined ? "collaborator" : backend.role;
      return json(role ? [{ id: MY_MEMBERSHIP, role }] : []);
    }
    if (backend.network) throw new TypeError("network down");
    if (url.pathname === "/rest/v1/checklist_items" && method === "PATCH") {
      const reply = backend.patch ?? { status: 200, body: [{ id: ITEM_ID }] };
      return json(reply.body, reply.status);
    }
    if (method === "GET" && url.pathname.startsWith("/rest/v1/")) {
      const reply = backend.get?.[url.pathname.slice("/rest/v1/".length)] ?? { status: 200, body: [] };
      return json(reply.body, reply.status);
    }
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(backend.signedIn ?? true),
      storageKey: "test",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  return { supabase, requests };
}


const writes = (requests: Recorded[]) =>
  requests.filter((r) => r.method !== "GET" || r.url.pathname.startsWith("/rest/v1/rpc/"));

const access = {
  userId: USER_ID,
  weddingId: WEDDING_ID,
  membershipId: MY_MEMBERSHIP,
  role: "collaborator",
} as const;

// ------------------------------------------------------------------ write

describe("setChecklistItemGuestParty", () => {
  it.each(["owner", "collaborator"] as const)(
    "%s: sends only the party id, scoped to the authorized wedding and item",
    async (role) => {
      const { supabase, requests } = clientFor({ role });
      await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, PARTY_ID)).resolves.toEqual({
        ok: true,
      });
      const [patch, ...rest] = writes(requests);
      expect(rest).toEqual([]);
      expect(patch?.url.pathname).toBe("/rest/v1/checklist_items");
      expect(patch?.url.searchParams.get("id")).toBe(`eq.${ITEM_ID}`);
      expect(patch?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
      // Only the link: never status, timing, order, assignee, a label or a route.
      expect(patch?.body).toEqual({ guest_invitation_id: PARTY_ID });
    },
  );

  it("unlink sends null and nothing else", async () => {
    const { supabase, requests } = clientFor({});
    await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, null)).resolves.toEqual({ ok: true });
    expect(writes(requests).map((r) => r.body)).toEqual([{ guest_invitation_id: null }]);
  });

  it("a party outside the wedding (FK violation) is invalid_guest_party, without details", async () => {
    const { supabase } = clientFor({
      patch: {
        status: 409,
        body: {
          code: "23503",
          message: 'insert or update on table "checklist_items" violates foreign key constraint',
          details: "Key (guest_invitation_id, wedding_id)=(…) is not present",
        },
      },
    });
    const result = await setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, PARTY_ID);
    expect(result).toEqual({ ok: false, reason: "invalid_guest_party" });
    expect(JSON.stringify(result)).not.toContain("constraint");
  });

  it.each([
    "not-a-uuid",
    "https://evil.example/rsvp/abc",
    "/rsvp/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "a".repeat(64),
    `${PARTY_ID} `,
  ])("a malformed target (%s) never reaches the database", async (target) => {
    const { supabase, requests } = clientFor({});
    await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, target)).resolves.toEqual({
      ok: false,
      reason: "invalid_guest_party",
    });
    expect(writes(requests)).toHaveLength(0);
  });

  it("an item that isn't in the wedding is item_not_found", async () => {
    const { supabase } = clientFor({ patch: { status: 200, body: [] } });
    await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, PARTY_ID)).resolves.toEqual({
      ok: false,
      reason: "item_not_found",
    });
    const malformed = clientFor({});
    await expect(setChecklistItemGuestParty(malformed.supabase, WEDDING_ID, "nope", PARTY_ID)).resolves.toEqual({
      ok: false,
      reason: "item_not_found",
    });
    expect(writes(malformed.requests)).toHaveLength(0);
  });

  it("an outsider gets not_found and nothing is sent", async () => {
    const { supabase, requests } = clientFor({ role: null });
    await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, PARTY_ID)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(writes(requests)).toHaveLength(0);
  });

  it("unauthenticated: nothing is sent", async () => {
    const { supabase, requests } = clientFor({ signedIn: false });
    await expect(setChecklistItemGuestParty(supabase, WEDDING_ID, ITEM_ID, PARTY_ID)).resolves.toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(writes(requests)).toHaveLength(0);
  });

  it("database and network errors fail closed", async () => {
    const db = clientFor({ patch: { status: 500, body: { code: "XX000", message: "pg detail" } } });
    const dbResult = await setChecklistItemGuestParty(db.supabase, WEDDING_ID, ITEM_ID, null);
    expect(dbResult).toEqual({ ok: false, reason: "error" });
    expect(JSON.stringify(dbResult)).not.toContain("pg detail");
    const net = clientFor({ network: true });
    await expect(setChecklistItemGuestParty(net.supabase, WEDDING_ID, ITEM_ID, null)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});

// ------------------------------------------------------------------- reads

describe("checklist ↔ guest work reads", () => {
  it("the checklist reads the link as an id only", async () => {
    const { supabase, requests } = clientFor({
      get: {
        checklist_items: {
          status: 200,
          body: [
            {
              id: ITEM_ID,
              title: "Transporte",
              description: null,
              category: null,
              status: "done",
              timing_mode: "none",
              relative_days: null,
              due_date: null,
              sort_order: 10,
              assignee_membership_id: null,
              guest_invitation_id: PARTY_ID,
            },
          ],
        },
      },
    });
    const checklist = await getWeddingChecklist(supabase, access);
    expect(checklist?.items[0]?.guestInvitationId).toBe(PARTY_ID);
    expect(checklist?.items[0]?.status).toBe("done");
    const select = requests.find((r) => r.url.pathname === "/rest/v1/checklist_items")?.url.searchParams.get("select");
    expect(select?.split(",")).toContain("guest_invitation_id");
    // No embedded guest data in the checklist read.
    expect(select).not.toMatch(/guest_invitations|label|contact|token|rsvp/);
  });

  it("party options are id + current label only, in ONE query for the wedding", async () => {
    const { supabase, requests } = clientFor({
      get: {
        guest_invitations: { status: 200, body: [{ id: PARTY_ID, label: "Familia Pérez" }] },
      },
    });
    await expect(listGuestPartyOptions(supabase, access)).resolves.toEqual([{ id: PARTY_ID, label: "Familia Pérez" }]);
    const reads = requests.filter((r) => r.url.pathname === "/rest/v1/guest_invitations");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.url.searchParams.get("select")).toBe("id,label");
    expect(reads[0]?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("party options fail closed (null), never an empty list", async () => {
    const { supabase } = clientFor({ get: { guest_invitations: { status: 500, body: { message: "x" } } } });
    await expect(listGuestPartyOptions(supabase, access)).resolves.toBeNull();
  });

  it("the guest list embeds each party's related items (id, title, status) in the same single query", async () => {
    const party = {
      id: PARTY_ID,
      label: "Familia Pérez",
      token_issued_at: "2026-10-01T00:00:00Z",
      revoked_at: null,
      contact_email: null,
      invitation_email_sent_at: null,
      invitation_email_sent_to: null,
      rsvp_confirmation_email_sent_at: null,
      rsvp_confirmation_email_sent_to: null,
      rsvp_reminder_email_sent_at: null,
      rsvp_reminder_email_sent_to: null,
      created_at: "2026-10-01T00:00:00Z",
      guests: [],
      checklist_items: [
        { id: "b", title: "Segundo", status: "pending", sort_order: 20, created_at: "2026-10-01T00:00:00Z" },
        { id: "a", title: "Primero", status: "done", sort_order: 10, created_at: "2026-10-02T00:00:00Z" },
      ],
      automatic_rsvp_reminders: [],
      email_deliveries: [],
    };
    const { supabase, requests } = clientFor({ get: { guest_invitations: { status: 200, body: [party] } } });
    const parties = await listGuestParties(supabase, access);
    expect(parties?.[0]?.relatedChecklistItems).toEqual([
      { id: "a", title: "Primero", status: "done" },
      { id: "b", title: "Segundo", status: "pending" },
    ]);
    const reads = requests.filter((r) => r.method === "GET" && r.url.pathname.startsWith("/rest/v1/"));
    expect(reads.map((r) => r.url.pathname)).toEqual(["/rest/v1/guest_invitations"]);
    const select = reads[0]?.url.searchParams.get("select") ?? "";
    const embed = /checklist_items\(([^)]*)\)/.exec(select)?.[1];
    expect(embed?.split(",").map((c) => c.trim())).toEqual(["id", "title", "status", "sort_order", "created_at"]);
  });
});
