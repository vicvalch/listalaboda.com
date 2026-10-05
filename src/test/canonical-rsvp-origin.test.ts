import { createHash } from "node:crypto";

import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutgoingEmail } from "@/lib/email/provider";
import type { Database } from "@/lib/supabase/database.types";
import { TEST_RSVP_CAPABILITY_KEY_ENV } from "@/test/fixtures/rsvp-capability-key";

// LB-13R: every absolute RSVP link — fresh link after creating a party,
// after "Generar nuevo enlace", in the invitation email of "Generar nuevo
// enlace y enviar", and after "Mostrar enlace" — is built from the trusted
// APP_ORIGIN only. The REAL Server Actions and services run here against a
// fake HTTP backend, with hostile request headers that would redirect a
// header-derived link to another host. They must change nothing.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: USER_ID })) }));

/** A spoofed request: every header a request-derived origin could come from. */
const HOSTILE_HEADERS = vi.hoisted(
  () =>
    new Headers({
      host: "evil.example",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      referer: "https://evil.example/app",
    }),
);
const headersSpy = vi.hoisted(() => vi.fn(async () => HOSTILE_HEADERS));
vi.mock("next/headers", () => ({
  headers: headersSpy,
  cookies: vi.fn(async () => ({ get: () => undefined, getAll: () => [], set: vi.fn() })),
}));

const backend = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => backend.current) }));

// Email: a capturing sender instead of Resend, and a recorder that accepts.
const sent = vi.hoisted(() => [] as OutgoingEmail[]);
vi.mock("@/lib/email/resend", () => ({
  createResendSender: () => ({
    async send(email: OutgoingEmail) {
      sent.push(email);
      return { ok: true, messageId: "msg_1" };
    },
  }),
}));
vi.mock("@/lib/email/delivery-recorder", () => ({
  getDeliveryRecorder: () => ({
    recordInvitation: async () => ({ ok: true, sentAt: "2026-10-04T12:00:00Z" }),
    readRsvpConfirmationContext: vi.fn(),
    recordRsvpConfirmation: vi.fn(),
    recordRsvpReminder: vi.fn(),
  }),
}));

const APP_ORIGIN = "https://listalaboda.example";
const CANONICAL = /^https:\/\/listalaboda\.example\/rsvp\/([A-Za-z0-9_-]{43})$/;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEDDING_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_ID = "33333333-3333-4333-8333-333333333333";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";

beforeAll(() => {
  vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
  vi.stubEnv("RSVP_CAPABILITY_ENCRYPTION_KEY", TEST_RSVP_CAPABILITY_KEY_ENV);
  vi.stubEnv("EMAIL_FROM", "ListaLaBoda Pruebas <invitaciones@example.com>");
  vi.stubEnv("EMAIL_TRANSPORT", "resend");
  vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const { createPartyAction, recoverLinkAction, rotateAndSendAction, rotateLinkAction } = await import(
  "@/app/app/weddings/[weddingId]/guests/actions"
);
const { encryptRsvpCapability } = await import("@/lib/security/rsvp-capability-encryption");
const { generateCapabilityToken } = await import("@/lib/security/capability-token");
const { TEST_RSVP_CAPABILITY_KEY } = await import("@/test/fixtures/rsvp-capability-key");

type Recorded = { method: string; path: string; body: unknown };
type Reply = { status: number; body: unknown };

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

/** Installs a fake backend for the user's session client; returns its request log. */
function useBackend(replies: Record<string, Reply>): Recorded[] {
  const requests: Recorded[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/auth/v1/user") return json({ id: USER_ID, aud: "authenticated", role: "authenticated" });
    if (method === "GET" && url.pathname === "/rest/v1/wedding_memberships") {
      return json([{ id: MEMBERSHIP_ID, role: "owner" }]);
    }
    const reply = replies[`${method} ${url.pathname}`];
    return reply ? json(reply.body, reply.status) : json({ message: "unexpected request" }, 500);
  };
  backend.current = createClient<Database>("http://supabase.test", "sb_publishable_test", {
    auth: { storage: memoryStorage(), storageKey: "test", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
  return requests;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The token in a canonical link; fails (without printing it) if the link isn't canonical. */
function canonicalToken(link: string | undefined): string {
  const token = link ? CANONICAL.exec(link)?.[1] : undefined;
  expect(token !== undefined, "link is APP_ORIGIN + /rsvp/<token> (value redacted)").toBe(true);
  expect(link?.includes("evil.example")).toBe(false);
  return token as string;
}

describe("absolute RSVP links use the trusted APP_ORIGIN, whatever the request headers say", () => {
  beforeEach(() => {
    sent.length = 0;
    headersSpy.mockClear();
  });

  it("create: the fresh link is canonical, and its token is the one whose hash was stored", async () => {
    const requests = useBackend({ "POST /rest/v1/rpc/create_guest_invitation": { status: 200, body: PARTY_ID } });
    const state = await createPartyAction(
      null,
      form({ weddingId: WEDDING_ID, label: "Familia Origen", guestNames: "Ana", contactEmail: "" }),
    );
    if (!state?.ok) throw new Error("create failed");
    const token = canonicalToken(state.data.link);
    expect(state.data.token).toBe(token);
    const rpc = requests.find((r) => r.path === "/rest/v1/rpc/create_guest_invitation");
    expect((rpc?.body as { invitation_token_hash: string }).invitation_token_hash).toBe(sha256(token));
    // The request headers were never consulted to build the link.
    expect(headersSpy).not.toHaveBeenCalled();
  });

  it("rotate: the new link is canonical, and its token is the one whose hash was stored", async () => {
    const requests = useBackend({ "POST /rest/v1/rpc/rotate_guest_invitation_link": { status: 200, body: true } });
    const state = await rotateLinkAction(null, form({ weddingId: WEDDING_ID, guestInvitationId: PARTY_ID }));
    if (!state?.ok) throw new Error("rotate failed");
    const token = canonicalToken(state.data.link);
    const rpc = requests.find((r) => r.path === "/rest/v1/rpc/rotate_guest_invitation_link");
    expect((rpc?.body as { invitation_token_hash: string }).invitation_token_hash).toBe(sha256(token));
    expect(headersSpy).not.toHaveBeenCalled();
  });

  it("rotate and send: the returned link and the emailed link are the same canonical URL", async () => {
    useBackend({
      "GET /rest/v1/guest_invitations": {
        status: 200,
        body: [{ id: PARTY_ID, label: "Familia Origen", contact_email: "familia@example.com" }],
      },
      "GET /rest/v1/weddings": {
        status: 200,
        body: [{ id: WEDDING_ID, name: "Boda Origen", wedding_date: null, city: null, time_zone: null }],
      },
      "GET /rest/v1/wedding_publications": { status: 200, body: [] },
      "POST /rest/v1/rpc/rotate_guest_invitation_link": { status: 200, body: true },
    });
    const state = await rotateAndSendAction(null, form({ weddingId: WEDDING_ID, guestInvitationId: PARTY_ID }));
    expect(state?.tone).toBe("success");
    const token = canonicalToken(state?.link?.link);
    expect(sent).toHaveLength(1);
    const emailed = /Confirmar asistencia: (\S+)/.exec(sent[0]!.text)?.[1];
    expect(emailed === state?.link?.link, "the email carries the same canonical link (value redacted)").toBe(true);
    expect(canonicalToken(emailed)).toBe(token);
    for (const part of [sent[0]!.text, sent[0]!.html]) expect(part.includes("evil.example")).toBe(false);
  });

  it("recover: the link is canonical and carries the SAME token that was created", async () => {
    // Created earlier (stored as hash + envelope); only its token is known to the test.
    const original = generateCapabilityToken();
    const envelope = encryptRsvpCapability({
      token: original.token,
      tokenHash: original.tokenHash,
      key: TEST_RSVP_CAPABILITY_KEY,
    });
    useBackend({
      "POST /rest/v1/rpc/get_guest_invitation_recovery_envelope": {
        status: 200,
        body: [{ link_state: "recoverable", token_hash: original.tokenHash, token_ciphertext: envelope }],
      },
    });
    const state = await recoverLinkAction(null, form({ weddingId: WEDDING_ID, guestInvitationId: PARTY_ID }));
    if (state?.status !== "shown") throw new Error("recovery failed");
    expect(canonicalToken(state.link) === original.token, "original token == recovered token").toBe(true);
    expect(headersSpy).not.toHaveBeenCalled();
  });

  it("without a trusted APP_ORIGIN, create and rotate refuse before any write (no header fallback)", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    try {
      const requests = useBackend({});
      const created = await createPartyAction(
        null,
        form({ weddingId: WEDDING_ID, label: "Sin origen", guestNames: "Ana", contactEmail: "" }),
      );
      expect(created).toMatchObject({ ok: false });
      const rotated = await rotateLinkAction(null, form({ weddingId: WEDDING_ID, guestInvitationId: PARTY_ID }));
      expect(rotated).toMatchObject({ ok: false });
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
      expect(headersSpy).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    }
  });
});
