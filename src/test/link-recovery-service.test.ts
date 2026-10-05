import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY, WRONG_TEST_RSVP_CAPABILITY_KEY } from "@/test/fixtures/rsvp-capability-key";

vi.mock("server-only", () => ({}));

const { recoverGuestPartyLink } = await import("@/lib/guests/link-recovery");
const { encryptRsvpCapability } = await import("@/lib/security/rsvp-capability-encryption");
const { generateCapabilityToken } = await import("@/lib/security/capability-token");

// LB-13: recovering a party's current link, against a fake HTTP backend:
// what is asked for, in which order, and how every failure is normalized.
// The real database function is tested in tests/db/link-recovery.test.ts.

const SUPABASE_URL = "http://supabase.test";
const APP_ORIGIN = "https://bodas.example.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";
const RECOVERY_RPC = "POST /rest/v1/rpc/get_guest_invitation_recovery_envelope";
const CONFIG = { appOrigin: APP_ORIGIN, encryption: { key: TEST_RSVP_CAPABILITY_KEY } };

type Recorded = { method: string; url: URL; body: unknown };
type Reply = { status: number; body: unknown };

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

function clientFor(backend: {
  role?: "owner" | "collaborator" | null;
  noSession?: boolean;
  recovery?: Reply | "network";
}) {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    if (url.pathname === "/auth/v1/user") {
      if (backend.noSession) return json({ message: "invalid JWT" }, 401);
      return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    }
    if (`${method} ${url.pathname}` === "GET /rest/v1/wedding_memberships") {
      return json(backend.role ? [{ id: "33333333-3333-4333-8333-333333333333", role: backend.role }] : []);
    }
    if (`${method} ${url.pathname}` === RECOVERY_RPC && backend.recovery) {
      if (backend.recovery === "network") throw new TypeError("network down");
      return json(backend.recovery.body, backend.recovery.status);
    }
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

/** Everything but the identity/membership reads. */
const dataCalls = (requests: Recorded[]) =>
  requests
    .filter((r) => r.url.pathname.startsWith("/rest/v1/") && r.url.pathname !== "/rest/v1/wedding_memberships")
    .map((r) => `${r.method} ${r.url.pathname}`);

/** A party whose link was created (and stored recoverably) earlier. */
function storedLink(key = TEST_RSVP_CAPABILITY_KEY) {
  const { token, tokenHash } = generateCapabilityToken();
  return { token, tokenHash, envelope: encryptRsvpCapability({ token, tokenHash, key }) };
}

function recoverable(tokenHash: string, envelope: string): Reply {
  return { status: 200, body: [{ link_state: "recoverable", token_hash: tokenHash, token_ciphertext: envelope }] };
}

describe("recoverGuestPartyLink", () => {
  it("returns the SAME link that was created, from the persisted envelope alone", async () => {
    // Creation happened in an earlier request; nothing of it survives but
    // the stored hash and envelope.
    const stored = storedLink();
    const originalLink = `${APP_ORIGIN}/rsvp/${stored.token}`;

    for (const role of ["owner", "collaborator"] as const) {
      const { supabase, requests } = clientFor({ role, recovery: recoverable(stored.tokenHash, stored.envelope) });
      expect(await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, CONFIG)).toEqual({
        ok: true,
        link: originalLink,
      });
      // One scoped read; ids only; nothing written.
      expect(dataCalls(requests)).toEqual([RECOVERY_RPC]);
      expect(requests.find((r) => r.method === "POST")?.body).toEqual({
        target_wedding_id: WEDDING_ID,
        target_invitation_id: PARTY_ID,
      });
    }
  });

  it("builds the URL from the configured origin only", async () => {
    const stored = storedLink();
    const { supabase } = clientFor({ role: "owner", recovery: recoverable(stored.tokenHash, stored.envelope) });
    const result = await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, {
      ...CONFIG,
      appOrigin: "https://otra.example.org",
    });
    expect(result).toEqual({ ok: true, link: `https://otra.example.org/rsvp/${stored.token}` });
  });

  it("authorizes first: no session, non-members and bad ids never reach the database", async () => {
    for (const [backend, id, reason] of [
      [{ noSession: true, role: "owner" }, PARTY_ID, "unauthenticated"],
      [{ role: null }, PARTY_ID, "not_found"],
      [{ role: "owner" }, "not-a-uuid", "invalid_target"],
    ] as const) {
      const { supabase, requests } = clientFor({ ...backend, recovery: { status: 200, body: [] } });
      expect(await recoverGuestPartyLink(supabase, WEDDING_ID, id, CONFIG)).toEqual({ ok: false, reason });
      expect(dataCalls(requests)).toEqual([]);
    }
  });

  it("without configuration (key or origin) it fails closed before reading anything", async () => {
    const { supabase, requests } = clientFor({ role: "owner", recovery: { status: 200, body: [] } });
    expect(await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, null)).toEqual({
      ok: false,
      reason: "configuration_error",
    });
    expect(dataCalls(requests)).toEqual([]);
  });

  it.each<[string, Reply | "network", string]>([
    ["no row (unknown party / other wedding)", { status: 200, body: [] }, "invalid_target"],
    ["revoked or expired", { status: 200, body: [{ link_state: "unavailable", token_hash: null, token_ciphertext: null }] }, "unavailable"],
    ["pre-LB-13 hash-only link", { status: 200, body: [{ link_state: "legacy", token_hash: null, token_ciphertext: null }] }, "legacy"],
    ["unexpected state", { status: 200, body: [{ link_state: "weird", token_hash: null, token_ciphertext: null }] }, "error"],
    ["database error", { status: 400, body: { code: "XX000", message: "boom" } }, "error"],
    ["network failure", "network", "error"],
  ])("maps %s", async (_case, recovery, reason) => {
    const { supabase } = clientFor({ role: "owner", recovery });
    expect(await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, CONFIG)).toEqual({ ok: false, reason });
  });

  it("a different server key fails closed as `unrecoverable`, with no crypto detail and no writes", async () => {
    const stored = storedLink();
    const { supabase, requests } = clientFor({ role: "owner", recovery: recoverable(stored.tokenHash, stored.envelope) });
    const result = await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, {
      ...CONFIG,
      encryption: { key: WRONG_TEST_RSVP_CAPABILITY_KEY },
    });
    expect(result).toEqual({ ok: false, reason: "unrecoverable" });
    // Nothing rotated, revoked or rewritten: the only call was the read.
    expect(dataCalls(requests)).toEqual([RECOVERY_RPC]);
    expect(JSON.stringify(result)).not.toContain(stored.token);
  });

  it("a tampered envelope, or one bound to another link, is `unrecoverable`", async () => {
    const stored = storedLink();
    const other = storedLink();
    const parts = stored.envelope.split(".");
    const ct = Buffer.from(parts[2]!, "base64url");
    ct[5] = ct[5]! ^ 0xff;
    parts[2] = ct.toString("base64url");
    for (const [hash, envelope] of [
      [stored.tokenHash, parts.join(".")],
      [stored.tokenHash, other.envelope],
      [stored.tokenHash, "v1.garbage"],
    ] as const) {
      const { supabase, requests } = clientFor({ role: "owner", recovery: recoverable(hash, envelope) });
      expect(await recoverGuestPartyLink(supabase, WEDDING_ID, PARTY_ID, CONFIG)).toEqual({
        ok: false,
        reason: "unrecoverable",
      });
      expect(dataCalls(requests)).toEqual([RECOVERY_RPC]);
    }
  });
});
