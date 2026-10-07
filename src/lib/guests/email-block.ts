import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { WeddingAccess } from "@/lib/authz/wedding";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The same-address guard for MANUAL emails (LB-18.3, ADR-011 §9): before the
 * invitation or a manual reminder reaches the provider, ask the database
 * whether this party's CURRENT contact email already bounced, was suppressed
 * or complained in this wedding (`get_guest_invitation_email_block`, run as
 * the member: it checks membership itself and returns one closed value).
 *
 * - `sendable`: nothing blocks (delayed / failed / delivered / accepted, or
 *   no history for this address — e.g. after the address was edited);
 * - `undeliverable`: suppressed or bounced;
 * - `complained`: marked as spam;
 * - `error`: unreadable, not visible, or `recipient` is no longer the party's
 *   current address. The caller sends nothing (fail closed).
 *
 * No override exists. Sharing the link manually is never affected. The RSVP
 * confirmation gets the same determination from its own privileged context
 * read (ADR-005); the automatic scheduler doesn't use it yet (LB-18.4).
 */
export type EmailBlockResult = "sendable" | "undeliverable" | "complained" | "error";

export async function checkContactEmailBlock(
  supabase: SupabaseClient<Database>,
  access: WeddingAccess,
  guestInvitationId: string,
  recipient: string,
): Promise<EmailBlockResult> {
  try {
    const { data, error } = await supabase.rpc("get_guest_invitation_email_block", {
      target_wedding_id: access.weddingId,
      target_invitation_id: guestInvitationId,
      target_recipient: recipient,
    });
    if (error) return "error";
    switch (data) {
      case "none":
        return "sendable";
      case "suppressed":
      case "bounced":
        return "undeliverable";
      case "complained":
        return "complained";
      default:
        return "error";
    }
  } catch {
    return "error";
  }
}
