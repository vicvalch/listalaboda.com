import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));

const userClient = vi.hoisted(() => ({ kind: "user-session-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => userClient) }));

const record = vi.hoisted(() => vi.fn());
const delivery = vi.hoisted(() => ({
  sender: { send: vi.fn() },
  appOrigin: "https://bodas.example.com",
  recorder: { record },
}));
vi.mock("@/lib/email/delivery", () => ({ getEmailDelivery: () => delivery }));

const sendGuestInvitationEmail = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: "sent", recipient: "familia@example.com", sentAt: "2026-10-03T12:00:00Z" })),
);
const rotateLinkAndSendInvitation = vi.hoisted(() => vi.fn(async () => ({ outcome: "failed", reason: "forbidden" })));
vi.mock("@/lib/guests/invitation-email", () => ({ sendGuestInvitationEmail, rotateLinkAndSendInvitation }));

const { rotateAndSendAction, sendInvitationAction } = await import(
  "@/app/app/weddings/[weddingId]/guests/actions"
);

// The Server Actions are the browser's only way in. Whatever extra fields a
// forged form carries (a provider id, a timestamp, a recipient, a role),
// only the lookup keys and the fresh token reach the orchestration; send
// metadata can only come from the provider's response, recorded by the
// server-only recorder (never by the action).

function forgedForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    ...fields,
    provider_message_id: "forged-id",
    providerMessageId: "forged-id",
    invitation_email_sent_at: "2020-01-01T00:00:00Z",
    sentAt: "2020-01-01T00:00:00Z",
    sentTo: "intruso@example.com",
    recipient: "intruso@example.com",
    role: "owner",
    isOwner: "true",
  })) {
    form.append(key, value);
  }
  return form;
}

describe("invitation email actions", () => {
  it("send: only wedding, party and token reach the service; the action never records anything", async () => {
    await sendInvitationAction(
      null,
      forgedForm({ weddingId: "w-1", guestInvitationId: "p-1", token: "T".repeat(43) }),
    );
    expect(sendGuestInvitationEmail).toHaveBeenCalledTimes(1);
    expect(sendGuestInvitationEmail).toHaveBeenCalledWith(userClient, "w-1", "p-1", "T".repeat(43), delivery);
    expect(JSON.stringify(sendGuestInvitationEmail.mock.calls)).not.toContain("forged-id");
    expect(JSON.stringify(sendGuestInvitationEmail.mock.calls)).not.toContain("intruso@example.com");
    expect(record).not.toHaveBeenCalled();
  });

  it("rotate + send: only wedding and party reach the service; a claimed role changes nothing", async () => {
    const state = await rotateAndSendAction(null, forgedForm({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(rotateLinkAndSendInvitation).toHaveBeenCalledWith(userClient, "w-1", "p-1", delivery);
    expect(state).toMatchObject({ tone: "error", canRetry: false });
    expect(record).not.toHaveBeenCalled();
  });
});
