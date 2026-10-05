import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));

const userClient = vi.hoisted(() => ({ kind: "user-session-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => userClient) }));

const config = vi.hoisted(() => ({ appOrigin: "https://bodas.example.com", encryption: { key: "server-key" } }));
const recoverGuestPartyLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/guests/link-config", () => ({ getGuestLinkConfig: () => config }));
vi.mock("@/lib/guests/link-recovery", () => ({ recoverGuestPartyLink }));

const { recoverLinkAction } = await import("@/app/app/weddings/[weddingId]/guests/actions");
const { getMessages } = await import("@/lib/i18n");

// "Mostrar enlace" (LB-13): the browser sends only lookup keys. Identity,
// membership, the key and the origin all come from the server; the link
// comes back only in this response, and nothing is revalidated or written.

const LINK = `https://bodas.example.com/rsvp/${"R".repeat(43)}`;
const copy = getMessages().guests.personalLink;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("recoverLinkAction", () => {
  beforeEach(() => {
    recoverGuestPartyLink.mockReset();
    revalidatePath.mockReset();
  });

  it("passes only wedding and party ids (plus server config) to the service", async () => {
    recoverGuestPartyLink.mockResolvedValue({ ok: true, link: LINK });
    const state = await recoverLinkAction(
      null,
      form({
        weddingId: "w-1",
        guestInvitationId: "p-1",
        role: "owner",
        appOrigin: "https://evil.example",
        key: "Zm9yZ2Vk",
        token_ciphertext: "v1.forged",
      }),
    );
    expect(recoverGuestPartyLink).toHaveBeenCalledWith(userClient, "w-1", "p-1", config);
    expect(JSON.stringify(recoverGuestPartyLink.mock.calls)).not.toContain("evil.example");
    expect(JSON.stringify(recoverGuestPartyLink.mock.calls)).not.toContain("forged");
    expect(state).toMatchObject({ status: "shown", link: LINK });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy", "legacy", copy.legacy],
    ["unrecoverable", "unrecoverable", copy.unrecoverable],
    ["unavailable", "unavailable", copy.unavailable],
    ["configuration_error", "failed", copy.notConfigured],
    ["error", "failed", getMessages().guests.errors.failed],
  ])("maps %s to a fixed catalog message, never a crypto detail", async (reason, status, message) => {
    recoverGuestPartyLink.mockResolvedValue({ ok: false, reason });
    const state = await recoverLinkAction(null, form({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(state).toMatchObject({ status, message });
    expect(state && "link" in state).toBe(false);
  });
});
