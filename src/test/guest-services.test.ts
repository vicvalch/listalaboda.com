import { createHash } from "node:crypto";

import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

vi.mock("server-only", () => ({}));

const {
  addGuest,
  createGuestParty,
  deleteGuestParty,
  listGuestParties,
  removeGuest,
  revokeGuestPartyLink,
  rotateGuestPartyLink,
  updateGuestName,
  updateGuestPartyLabel,
} = await import("@/lib/guests/service");
const { getGuestPartyByToken, submitGuestRsvp } = await import("@/lib/rsvp/service");
const { decryptRsvpCapability } = await import("@/lib/security/rsvp-capability-encryption");

// Application-layer tests: a real supabase-js client against a fake HTTP
// backend, asserting exactly what is sent and how failures are normalized.
// RLS, triggers and the token functions are tested against local Supabase
// in tests/db/guests.test.ts and tests/db/guest-service.test.ts.

const SUPABASE_URL = "http://supabase.test";
const ORIGIN = "https://listalaboda.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MY_MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const GUEST_ID = "55555555-5555-4555-8555-555555555555";
const GUEST_2 = "66666666-6666-4666-8666-666666666666";
const TOKEN = "A".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
/** LB-13: the server's (fake, test-only) link-encryption key. */
const ENCRYPTION = { key: TEST_RSVP_CAPABILITY_KEY };

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

type Backend = {
  role?: "owner" | "collaborator" | null;
  noSession?: boolean;
  /** Keyed by "METHOD /path". */
  replies?: Record<string, Reply>;
  networkDown?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryStorage(): SupportedStorage {
  const now = Math.floor(Date.now() / 1000);
  const items = new Map<string, string>([
    [
      "test",
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: { id: USER_ID, aud: "authenticated" },
      }),
    ],
  ]);
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
    const key = `${method} ${url.pathname}`;

    if (url.pathname === "/auth/v1/user") {
      if (backend.noSession) return json({ message: "invalid JWT" }, 401);
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (key === "GET /rest/v1/wedding_memberships") {
      return json(backend.role ? [{ id: MY_MEMBERSHIP, role: backend.role }] : []);
    }
    if (backend.networkDown === key) throw new TypeError("network down");
    const reply = backend.replies?.[key];
    if (reply) return json(reply.body, reply.status);
    return json({ message: "unexpected request" }, 500);
  };

  const supabase = createClient<Database>(SUPABASE_URL, "sb_publishable_test", {
    auth: {
      storage: memoryStorage(),
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
  requests.filter((r) => r.method !== "GET" && r.url.pathname.startsWith("/rest/v1/"));

const pgError = (code: string, message: string): Reply => ({ status: 400, body: { code, message } });

// ------------------------------------------------------------ organizer

describe("createGuestParty", () => {
  it("sends the label, names, the token HASH and its envelope (never the token); returns the link", async () => {
    const { supabase, requests } = clientFor({
      role: "collaborator",
      replies: { "POST /rest/v1/rpc/create_guest_invitation": { status: 200, body: PARTY_ID } },
    });
    const result = await createGuestParty(
      supabase,
      WEDDING_ID,
      { label: "Familia Pérez", guestNames: ["Ana", "Carlos"] },
      ORIGIN,
      ENCRYPTION,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const token = new URL(result.link).pathname.split("/")[2];
    expect(result.link).toBe(`${ORIGIN}/rsvp/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [rpc] = writes(requests);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const body = rpc?.body as Record<string, unknown>;
    expect(body).toEqual({
      target_wedding_id: WEDDING_ID,
      party_label: "Familia Pérez",
      invitation_token_hash: tokenHash,
      invitation_token_ciphertext: expect.stringMatching(/^v1\./),
      guest_names: ["Ana", "Carlos"],
    });
    // The envelope opens to THIS token, bound to THIS hash, with the server key.
    expect(
      decryptRsvpCapability({
        envelope: body.invitation_token_ciphertext as string,
        expectedTokenHash: tokenHash,
        key: ENCRYPTION.key,
      }),
    ).toBe(token);
    expect(JSON.stringify(requests.map((r) => [r.url.toString(), r.body]))).not.toContain(token);
  });

  it("without the link-encryption key nothing is written (no hash-only links)", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    await expect(
      createGuestParty(supabase, WEDDING_ID, { label: "X", guestNames: ["X"] }, ORIGIN, null),
    ).resolves.toEqual({ ok: false, reason: "configuration_error" });
    expect(writes(requests)).toEqual([]);
  });

  it("non-members and signed-out callers are stopped before any write", async () => {
    for (const [backend, reason] of [
      [{ role: null }, "not_found"],
      [{ noSession: true }, "unauthenticated"],
    ] as const) {
      const { supabase, requests } = clientFor(backend);
      await expect(
        createGuestParty(supabase, WEDDING_ID, { label: "X", guestNames: ["X"] }, ORIGIN, ENCRYPTION),
      ).resolves.toEqual({ ok: false, reason });
      expect(writes(requests)).toEqual([]);
    }
    const { supabase } = clientFor({ role: "owner" });
    await expect(
      createGuestParty(supabase, "not-a-uuid", { label: "X", guestNames: ["X"] }, ORIGIN, ENCRYPTION),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("normalizes database failures without leaking them", async () => {
    const cases: [Reply | "network", string][] = [
      [pgError("23514", 'new row violates check constraint "guest_invitations_label_valid"'), "invalid"],
      [pgError("42501", "new row violates row-level security policy"), "not_found"],
      [pgError("XX000", "boom"), "error"],
      ["network", "error"],
    ];
    for (const [reply, reason] of cases) {
      const key = "POST /rest/v1/rpc/create_guest_invitation";
      const { supabase } = clientFor({
        role: "owner",
        ...(reply === "network" ? { networkDown: key } : { replies: { [key]: reply } }),
      });
      await expect(
        createGuestParty(supabase, WEDDING_ID, { label: "X", guestNames: ["X"] }, ORIGIN, ENCRYPTION),
      ).resolves.toEqual({ ok: false, reason });
    }
  });
});

describe("party and guest writes", () => {
  it("every write is scoped to the authorized wedding (owner: content and link actions)", async () => {
    const replies = {
      "PATCH /rest/v1/guest_invitations": { status: 200, body: [{ id: PARTY_ID }] },
      "DELETE /rest/v1/guest_invitations": { status: 200, body: [{ id: PARTY_ID }] },
      "POST /rest/v1/guests": { status: 201, body: null },
      "PATCH /rest/v1/guests": { status: 200, body: [{ id: GUEST_ID }] },
      "DELETE /rest/v1/guests": { status: 200, body: [{ id: GUEST_ID }] },
      "POST /rest/v1/rpc/revoke_guest_invitation_link": { status: 200, body: true },
    };
    const { supabase, requests } = clientFor({ role: "owner", replies });
    expect(await updateGuestPartyLabel(supabase, WEDDING_ID, PARTY_ID, "Nuevo")).toEqual({ ok: true });
    expect(await deleteGuestParty(supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: true });
    expect(await addGuest(supabase, WEDDING_ID, PARTY_ID, "Ana")).toEqual({ ok: true });
    expect(await updateGuestName(supabase, WEDDING_ID, GUEST_ID, "Ana B")).toEqual({ ok: true });
    expect(await removeGuest(supabase, WEDDING_ID, GUEST_ID)).toEqual({ ok: true });
    expect(await revokeGuestPartyLink(supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: true });

    for (const write of writes(requests)) {
      if (write.url.pathname === "/rest/v1/rpc/revoke_guest_invitation_link") {
        // LB-15: revocation is one RPC (the database records it in the activity history).
        expect(write.body).toEqual({ target_wedding_id: WEDDING_ID, target_invitation_id: PARTY_ID });
      } else if (write.method === "POST") {
        expect(write.body).toEqual({ wedding_id: WEDDING_ID, guest_invitation_id: PARTY_ID, name: "Ana" });
      } else {
        expect(write.url.searchParams.get("wedding_id"), write.method).toBe(`eq.${WEDDING_ID}`);
      }
    }
    // Only the columns organizers may change are sent; revoked_at is never sent.
    const patches = writes(requests).filter((r) => r.method === "PATCH");
    expect(patches.map((p) => Object.keys(p.body as object))).toEqual([["label"], ["name"]]);
  });

  it("collaborators manage content but are refused link actions before any write", async () => {
    const content = clientFor({
      role: "collaborator",
      replies: {
        "PATCH /rest/v1/guest_invitations": { status: 200, body: [{ id: PARTY_ID }] },
        "DELETE /rest/v1/guest_invitations": { status: 200, body: [{ id: PARTY_ID }] },
        "POST /rest/v1/guests": { status: 201, body: null },
        "DELETE /rest/v1/guests": { status: 200, body: [{ id: GUEST_ID }] },
      },
    });
    expect(await updateGuestPartyLabel(content.supabase, WEDDING_ID, PARTY_ID, "Nuevo")).toEqual({ ok: true });
    expect(await addGuest(content.supabase, WEDDING_ID, PARTY_ID, "Ana")).toEqual({ ok: true });
    expect(await removeGuest(content.supabase, WEDDING_ID, GUEST_ID)).toEqual({ ok: true });
    expect(await deleteGuestParty(content.supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: true });

    const links = clientFor({ role: "collaborator" });
    expect(await rotateGuestPartyLink(links.supabase, WEDDING_ID, PARTY_ID, ORIGIN, ENCRYPTION)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await revokeGuestPartyLink(links.supabase, WEDDING_ID, PARTY_ID)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(writes(links.requests)).toEqual([]);
  });

  it("a role lost between the check and the write is still refused by the database", async () => {
    const { supabase } = clientFor({
      role: "owner",
      replies: {
        "POST /rest/v1/rpc/rotate_guest_invitation_link": pgError("42501", "guest_link_owner_only"),
        "POST /rest/v1/rpc/revoke_guest_invitation_link": pgError("42501", "guest_link_owner_only"),
      },
    });
    expect(await rotateGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, ORIGIN, ENCRYPTION)).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(await revokeGuestPartyLink(supabase, WEDDING_ID, PARTY_ID)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("rotation sends a new hash and its envelope in ONE call and returns the new link", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: { "POST /rest/v1/rpc/rotate_guest_invitation_link": { status: 200, body: true } },
    });
    const result = await rotateGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, ORIGIN, ENCRYPTION);
    if (!result.ok) throw new Error(result.reason);
    const token = new URL(result.link).pathname.split("/")[2] ?? "";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const all = writes(requests);
    expect(all).toHaveLength(1);
    const body = all[0]?.body as Record<string, unknown>;
    expect(body).toEqual({
      target_wedding_id: WEDDING_ID,
      target_invitation_id: PARTY_ID,
      invitation_token_hash: tokenHash,
      invitation_token_ciphertext: expect.stringMatching(/^v1\./),
    });
    expect(
      decryptRsvpCapability({
        envelope: body.invitation_token_ciphertext as string,
        expectedTokenHash: tokenHash,
        key: ENCRYPTION.key,
      }),
    ).toBe(token);
    expect(JSON.stringify(all)).not.toContain(token);
  });

  it("rotation without the link-encryption key changes nothing", async () => {
    const { supabase, requests } = clientFor({ role: "owner" });
    expect(await rotateGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, ORIGIN, null)).toEqual({
      ok: false,
      reason: "configuration_error",
    });
    expect(writes(requests)).toEqual([]);
  });

  it("rotation of a party that isn't this wedding's is invalid_target", async () => {
    const { supabase } = clientFor({
      role: "owner",
      replies: { "POST /rest/v1/rpc/rotate_guest_invitation_link": { status: 200, body: false } },
    });
    expect(await rotateGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, ORIGIN, ENCRYPTION)).toEqual({
      ok: false,
      reason: "invalid_target",
    });
  });

  it("ids are lookup keys: malformed or unmatched ids are invalid_target", async () => {
    const { supabase, requests } = clientFor({
      role: "owner",
      replies: {
        "PATCH /rest/v1/guest_invitations": { status: 200, body: [] },
        "DELETE /rest/v1/guests": { status: 200, body: [] },
        "POST /rest/v1/guests": pgError("23503", "insert or update violates foreign key constraint"),
      },
    });
    expect(await updateGuestPartyLabel(supabase, WEDDING_ID, "nope", "X")).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(writes(requests)).toEqual([]);
    expect(await updateGuestPartyLabel(supabase, WEDDING_ID, PARTY_ID, "X")).toEqual({
      ok: false,
      reason: "invalid_target",
    });
    expect(await removeGuest(supabase, WEDDING_ID, GUEST_ID)).toEqual({ ok: false, reason: "invalid_target" });
    expect(await addGuest(supabase, WEDDING_ID, PARTY_ID, "X")).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("maps party rules and failures", async () => {
    const { supabase } = clientFor({
      role: "owner",
      replies: {
        "DELETE /rest/v1/guests": pgError("23514", "guest_invitation_needs_guest"),
        "PATCH /rest/v1/guests": pgError("23514", 'violates check constraint "guests_name_valid"'),
      },
    });
    expect(await removeGuest(supabase, WEDDING_ID, GUEST_ID)).toEqual({ ok: false, reason: "last_guest" });
    expect(await updateGuestName(supabase, WEDDING_ID, GUEST_ID, "X")).toEqual({ ok: false, reason: "invalid" });

    const down = clientFor({ role: "owner", networkDown: "DELETE /rest/v1/guest_invitations" });
    expect(await deleteGuestParty(down.supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: false, reason: "error" });
  });

  it("revocation is one RPC (no client timestamp); true = revoked or already revoked, false = unknown party", async () => {
    const revoked = clientFor({
      role: "owner",
      replies: { "POST /rest/v1/rpc/revoke_guest_invitation_link": { status: 200, body: true } },
    });
    expect(await revokeGuestPartyLink(revoked.supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: true });
    expect(writes(revoked.requests).map((w) => [w.method, w.url.pathname, w.body])).toEqual([
      [
        "POST",
        "/rest/v1/rpc/revoke_guest_invitation_link",
        { target_wedding_id: WEDDING_ID, target_invitation_id: PARTY_ID },
      ],
    ]);

    const unknown = clientFor({
      role: "owner",
      replies: { "POST /rest/v1/rpc/revoke_guest_invitation_link": { status: 200, body: false } },
    });
    expect(await revokeGuestPartyLink(unknown.supabase, WEDDING_ID, PARTY_ID)).toEqual({
      ok: false,
      reason: "invalid_target",
    });

    const down = clientFor({ role: "owner", networkDown: "POST /rest/v1/rpc/revoke_guest_invitation_link" });
    expect(await revokeGuestPartyLink(down.supabase, WEDDING_ID, PARTY_ID)).toEqual({ ok: false, reason: "error" });
  });
});

describe("listGuestParties", () => {
  const access = { weddingId: WEDDING_ID, userId: USER_ID, membershipId: MY_MEMBERSHIP, role: "owner" as const };

  it("loads the whole list in one request, never the token hash, guests in party order", async () => {
    const { supabase, requests } = clientFor({
      replies: {
        "GET /rest/v1/guest_invitations": {
          status: 200,
          body: [
            {
              id: PARTY_ID,
              label: "Familia Pérez",
              token_issued_at: "2026-10-02T00:00:00Z",
              revoked_at: null,
              contact_email: "familia@example.com",
              invitation_email_sent_at: "2026-10-02T10:00:00Z",
              invitation_email_sent_to: "familia@example.com",
              rsvp_confirmation_email_sent_at: "2026-10-03T09:00:00Z",
              rsvp_confirmation_email_sent_to: "anterior@example.com",
              rsvp_reminder_email_sent_at: "2026-10-04T08:00:00Z",
              rsvp_reminder_email_sent_to: "familia@example.com",
              created_at: "2026-10-02T00:00:00Z",
              guests: [
                { id: GUEST_2, name: "Carlos", created_at: "2026-10-02T00:00:02Z", rsvps: [] },
                {
                  id: GUEST_ID,
                  name: "Ana",
                  created_at: "2026-10-02T00:00:01Z",
                  rsvps: [{ attending: true, dietary_note: "vegetariana" }],
                },
              ],
            },
          ],
        },
      },
    });
    const parties = await listGuestParties(supabase, access);
    expect(parties).toEqual([
      {
        id: PARTY_ID,
        label: "Familia Pérez",
        tokenIssuedAt: "2026-10-02T00:00:00Z",
        revokedAt: null,
        contactEmail: "familia@example.com",
        invitationEmail: { sentAt: "2026-10-02T10:00:00Z", sentTo: "familia@example.com" },
        // Where the last confirmation went, which may differ from the current email.
        rsvpConfirmationEmail: { sentAt: "2026-10-03T09:00:00Z", sentTo: "anterior@example.com" },
        // LB-14: the latest reminder, a third separate status.
        rsvpReminderEmail: { sentAt: "2026-10-04T08:00:00Z", sentTo: "familia@example.com" },
        guests: [
          { id: GUEST_ID, name: "Ana", rsvp: { attending: true, dietaryNote: "vegetariana" } },
          { id: GUEST_2, name: "Carlos", rsvp: null },
        ],
      },
    ]);
    const reads = requests.filter((r) => r.url.pathname.startsWith("/rest/v1/"));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.url.searchParams.get("select")).not.toContain("token_hash");
    // The provider's message id is operational data the page never needs.
    expect(reads[0]?.url.searchParams.get("select")).not.toContain("provider_id");
    expect(reads[0]?.url.searchParams.get("wedding_id")).toBe(`eq.${WEDDING_ID}`);
  });

  it("returns null on failure (never a misleading empty list)", async () => {
    const { supabase } = clientFor({ replies: { "GET /rest/v1/guest_invitations": pgError("XX000", "boom") } });
    expect(await listGuestParties(supabase, access)).toBeNull();
  });
});

// ---------------------------------------------------------------- guest

describe("guest RSVP service", () => {
  const partyRows = [
    { party_label: "Familia Pérez", guest_id: GUEST_ID, guest_name: "Ana", attending: true, dietary_note: null },
    { party_label: "Familia Pérez", guest_id: GUEST_2, guest_name: "Carlos", attending: null, dietary_note: null },
  ];

  it("reads by token hash only; the plaintext never leaves the server", async () => {
    const { supabase, requests } = clientFor({
      replies: { "POST /rest/v1/rpc/get_guest_invitation": { status: 200, body: partyRows } },
    });
    const result = await getGuestPartyByToken(supabase, TOKEN);
    expect(result).toEqual({
      ok: true,
      party: {
        label: "Familia Pérez",
        guests: [
          { id: GUEST_ID, name: "Ana", attending: true, dietaryNote: null },
          { id: GUEST_2, name: "Carlos", attending: null, dietaryNote: null },
        ],
      },
    });
    expect(requests.map((r) => r.body)).toEqual([{ invitation_token_hash: TOKEN_HASH }]);
    expect(JSON.stringify(requests.map((r) => [r.url.toString(), r.body]))).not.toContain(TOKEN);
  });

  it("malformed tokens never reach the database; no rows means unavailable", async () => {
    const { supabase, requests } = clientFor({
      replies: { "POST /rest/v1/rpc/get_guest_invitation": { status: 200, body: [] } },
    });
    for (const bad of ["", "short", "A".repeat(44), "../../etc"]) {
      expect(await getGuestPartyByToken(supabase, bad)).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(requests).toEqual([]);
    expect(await getGuestPartyByToken(supabase, TOKEN)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("submits every answer with the hash; never a wedding id", async () => {
    const { supabase, requests } = clientFor({
      replies: { "POST /rest/v1/rpc/submit_guest_rsvp": { status: 200, body: partyRows } },
    });
    const result = await submitGuestRsvp(supabase, TOKEN, [
      { guestId: GUEST_ID, attending: true, dietaryNote: "vegetariana" },
      { guestId: GUEST_2, attending: false, dietaryNote: null },
    ]);
    expect(result.ok).toBe(true);
    expect(requests.map((r) => r.body)).toEqual([
      {
        invitation_token_hash: TOKEN_HASH,
        responses: [
          { guest_id: GUEST_ID, attending: true, dietary_note: "vegetariana" },
          { guest_id: GUEST_2, attending: false, dietary_note: null },
        ],
      },
    ]);
  });

  it("normalizes failures: unavailable, stale, invalid, error", async () => {
    const key = "POST /rest/v1/rpc/submit_guest_rsvp";
    const cases: [Reply | "network", string][] = [
      [pgError("P0001", "guest_invitation_unavailable"), "unavailable"],
      [pgError("P0001", "guest_rsvp_mismatch"), "stale"],
      [pgError("22023", "guest_rsvp_invalid"), "invalid"],
      [pgError("23514", 'violates check constraint "rsvps_dietary_note_valid"'), "invalid"],
      [pgError("XX000", "boom"), "error"],
      ["network", "error"],
    ];
    for (const [reply, reason] of cases) {
      const { supabase } = clientFor(reply === "network" ? { networkDown: key } : { replies: { [key]: reply } });
      expect(
        await submitGuestRsvp(supabase, TOKEN, [{ guestId: GUEST_ID, attending: true, dietaryNote: null }]),
      ).toEqual({ ok: false, reason });
    }
    const { supabase, requests } = clientFor({});
    expect(await submitGuestRsvp(supabase, "bad", [])).toEqual({ ok: false, reason: "unavailable" });
    expect(requests).toEqual([]);
  });
});
