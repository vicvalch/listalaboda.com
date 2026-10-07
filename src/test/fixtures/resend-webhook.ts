import { Webhook } from "standardwebhooks";

/**
 * TEST-ONLY Resend webhook signing secrets (LB-18.2). Their bytes spell out
 * that they are fake; they protect nothing and must never be used by a
 * deployment. Real secrets come from the server environment
 * (`RESEND_WEBHOOK_SECRET`) and are never committed.
 */
export const TEST_RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("TEST-ONLY-resend-webhook-key-000", "utf8").toString("base64")}`;

/** A second fake secret, for "signed by someone else" tests. */
export const WRONG_TEST_RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("TEST-ONLY-wrong-webhook-key-0000", "utf8").toString("base64")}`;

export type SignedWebhook = Readonly<{
  body: string;
  headers: Readonly<{ "svix-id": string; "svix-timestamp": string; "svix-signature": string }>;
}>;

/**
 * Signs `body` exactly as Resend (Svix) does, with the Standard Webhooks
 * library itself: `v1,<base64 HMAC-SHA256>` over `<id>.<timestamp>.<body>`.
 */
export function signWebhook(
  body: string,
  options: Readonly<{ id: string; secret?: string; at?: Date }>,
): SignedWebhook {
  const at = options.at ?? new Date();
  const signature = new Webhook(options.secret ?? TEST_RESEND_WEBHOOK_SECRET).sign(options.id, at, body);
  return {
    body,
    headers: {
      "svix-id": options.id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": signature,
    },
  };
}

/** A Resend email event body (only the fields the app may read, plus decoys it must ignore). */
export function resendEventBody(
  type: string,
  emailId: string,
  options: Readonly<{ createdAt?: string; data?: Record<string, unknown> }> = {},
): string {
  return JSON.stringify({
    type,
    created_at: options.createdAt ?? "2026-10-06T12:00:00.000Z",
    data: {
      created_at: "2026-10-06T11:59:00.000Z",
      email_id: emailId,
      message_id: "<decoy-smtp-message-id@example.com>",
      from: "ListaLaBoda Pruebas <invitaciones@example.com>",
      to: ["decoy-recipient@example.com"],
      subject: "Decoy subject",
      tags: { wedding_id: "00000000-0000-4000-8000-000000000000" },
      ...options.data,
    },
  });
}
