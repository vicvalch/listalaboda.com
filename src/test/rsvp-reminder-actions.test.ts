import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));

const userClient = vi.hoisted(() => ({ kind: "user-session-client" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => userClient) }));

const record = vi.hoisted(() => vi.fn());
const delivery = vi.hoisted(() => ({
  sender: { send: vi.fn() },
  appOrigin: "https://bodas.example.com",
  recorder: { recordRsvpReminder: record },
}));
vi.mock("@/lib/email/delivery", () => ({ getEmailDelivery: () => delivery }));
const linkConfig = vi.hoisted(() => ({ appOrigin: "https://bodas.example.com", encryption: { key: "server-key" } }));
vi.mock("@/lib/guests/link-config", () => ({ getGuestLinkConfig: () => linkConfig }));

const sendRsvpReminderEmail = vi.hoisted(() => vi.fn());
const prepareRsvpReminderMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/guests/rsvp-reminder", () => ({ sendRsvpReminderEmail, prepareRsvpReminderMessage }));

const { prepareReminderMessageAction, sendReminderAction } = await import(
  "@/app/app/weddings/[weddingId]/guests/actions"
);
const { getMessages } = await import("@/lib/i18n");

// LB-14: the reminder Server Actions are the browser's only way in. Whatever
// a forged form carries (a recipient, a link or token, a provider id, a
// role, a key), only the wedding and party ids reach the orchestration: the
// recipient and the link are read on the server at action time.

const copy = getMessages().guests.reminder;
const FORGED_TOKEN = "F".repeat(43);

function forgedForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    ...fields,
    recipient: "intruso@example.com",
    to: "intruso@example.com",
    contactEmail: "intruso@example.com",
    contact_email: "intruso@example.com",
    token: FORGED_TOKEN,
    link: `https://evil.example/rsvp/${FORGED_TOKEN}`,
    rsvpUrl: `https://evil.example/rsvp/${FORGED_TOKEN}`,
    appOrigin: "https://evil.example",
    providerMessageId: "forged-id",
    sentAt: "2020-01-01T00:00:00Z",
    role: "owner",
    RSVP_CAPABILITY_ENCRYPTION_KEY: "Zm9yZ2VkLWtleQ",
  })) {
    form.append(key, value);
  }
  return form;
}

function expectNothingForged(calls: unknown[][]) {
  const serialized = JSON.stringify(calls);
  for (const forged of ["intruso@example.com", FORGED_TOKEN, "evil.example", "forged-id", "Zm9yZ2VkLWtleQ"]) {
    expect(serialized).not.toContain(forged);
  }
}

describe("sendReminderAction", () => {
  beforeEach(() => {
    sendRsvpReminderEmail.mockReset();
    revalidatePath.mockReset();
    record.mockReset();
  });

  it("only wedding and party ids reach the service; never a browser recipient, link or token", async () => {
    sendRsvpReminderEmail.mockResolvedValue({ outcome: "sent", recipient: "familia@example.com", sentAt: "x" });
    const state = await sendReminderAction(null, forgedForm({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(sendRsvpReminderEmail).toHaveBeenCalledTimes(1);
    // No key in this test environment: null, never a value from the form.
    expect(sendRsvpReminderEmail).toHaveBeenCalledWith(userClient, "w-1", "p-1", delivery, null);
    expectNothingForged(sendRsvpReminderEmail.mock.calls);
    expect(state).toMatchObject({ tone: "success", message: "Recordatorio enviado a familia@example.com." });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    // The action itself never records anything.
    expect(record).not.toHaveBeenCalled();
  });

  it.each<[Record<string, unknown>, string, string, boolean]>([
    [{ outcome: "sent_but_unrecorded", recipient: "familia@example.com" }, "info", copy.errors.sentUnrecorded, false],
    [{ outcome: "no_email" }, "error", copy.noEmail, false],
    [{ outcome: "email_not_configured" }, "error", copy.errors.notConfigured, false],
    [{ outcome: "link_not_configured" }, "error", copy.errors.linkNotConfigured, false],
    [{ outcome: "link_unrecoverable" }, "error", copy.errors.linkUnrecoverable, true],
    [{ outcome: "link_unavailable" }, "error", copy.errors.linkUnavailable, false],
    [{ outcome: "recipient_rejected" }, "error", copy.errors.recipientRejected, false],
    [{ outcome: "provider_failed" }, "error", copy.errors.providerFailed, false],
    [{ outcome: "failed", reason: "error" }, "error", getMessages().guests.errors.failed, false],
  ])("maps %j to a fixed catalog message", async (outcome, tone, message, needsNewLink) => {
    sendRsvpReminderEmail.mockResolvedValue(outcome);
    const state = await sendReminderAction(null, forgedForm({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(state).toMatchObject({ tone, message });
    expect(Boolean(state?.needsNewLink)).toBe(needsNewLink);
    // Only a recorded success changes what the page shows.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sent but unrecorded never suggests sending again", () => {
    expect(copy.errors.sentUnrecorded).toContain("No lo envíes otra vez todavía");
  });
});

describe("prepareReminderMessageAction", () => {
  beforeEach(() => {
    prepareRsvpReminderMessage.mockReset();
    revalidatePath.mockReset();
  });

  it("passes only ids (plus server config) and returns the text in this response only", async () => {
    prepareRsvpReminderMessage.mockResolvedValue({ ok: true, message: "Hola, Familia Pérez:" });
    const state = await prepareReminderMessageAction(null, forgedForm({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(prepareRsvpReminderMessage).toHaveBeenCalledWith(userClient, "w-1", "p-1", linkConfig);
    expectNothingForged(prepareRsvpReminderMessage.mock.calls);
    expect(state).toMatchObject({ status: "shown", message: "Hola, Familia Pérez:" });
    // Preparing is not delivery: nothing to revalidate, nothing recorded.
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ["link_unrecoverable", "unrecoverable", copy.errors.linkUnrecoverable],
    ["link_unavailable", "failed", copy.errors.linkUnavailable],
    ["link_not_configured", "failed", copy.errors.linkNotConfigured],
    ["error", "failed", getMessages().guests.errors.failed],
  ])("maps %s to a fixed catalog message, never a crypto detail", async (reason, status, message) => {
    prepareRsvpReminderMessage.mockResolvedValue({ ok: false, reason });
    const state = await prepareReminderMessageAction(null, forgedForm({ weddingId: "w-1", guestInvitationId: "p-1" }));
    expect(state).toEqual({ status, message, nonce: expect.any(String) });
  });
});

describe("copy: preparing is never called sending", () => {
  it("the WhatsApp action says prepare, never send", () => {
    expect(copy.whatsapp.prepare).toBe("Preparar mensaje para WhatsApp");
    expect(copy.send).toBe("Enviar recordatorio");
    for (const text of Object.values(copy.whatsapp)) {
      expect(text).not.toMatch(/enviar whatsapp|enviado por whatsapp|whatsapp enviado/i);
    }
  });
});
