import { normalizeEmailForComparison } from "@/lib/guests/contact-email";
import type { GuestLinkState } from "@/lib/guests/link";
import {
  AUTOMATIC_REMINDER_SUPPRESSION_DAYS,
  automaticReminderDueAt,
  automaticReminderWindow,
} from "@/lib/scheduler/timing";
import type { Database } from "@/lib/supabase/database.types";

/**
 * What organizers see about one party's automatic reminder (LB-17, ADR-010
 * §26). Pure: derived in memory from the policy, the wedding's date and zone,
 * the party's current state and its occurrence (if any). The database stays
 * authoritative; this only labels. Never exposes enum names, claim data or
 * provider details.
 *
 * LB-18.4 (ADR-010 §7 E9/E11): like the database, a current address that is
 * known undeliverable in this wedding stops it (`recipient_undeliverable`),
 * and only invitation/reminder emails sent TO the current address (compared
 * case-insensitively) count as "recently reminded".
 */

type OccurrenceState = Database["public"]["Enums"]["automatic_rsvp_reminder_state"];
type OutcomeReason = Database["public"]["Enums"]["automatic_rsvp_reminder_outcome_reason"];

export type AutomaticReminderPolicyView = Readonly<{
  enabled: boolean;
  daysBefore: number;
  enabledAt: string | null;
}>;

export type AutomaticReminderPartyInput = Readonly<{
  policy: AutomaticReminderPolicyView;
  weddingDate: string | null;
  weddingTimeZone: string | null;
  /** Any current guest has a saved answer. */
  answered: boolean;
  /** The party's CURRENT contact email. */
  contactEmail: string | null;
  /**
   * LB-18.3's block of the current address in this wedding (suppressed,
   * bounced or complained): the same rule as the members' warning.
   */
  contactEmailBlocked: boolean;
  linkState: GuestLinkState;
  /**
   * The party's recorded invitation and reminder emails (either channel),
   * each with the address it went to: the latest-send metadata and the
   * ledger rows of those kinds. Never RSVP confirmations.
   */
  recordedEmails: readonly RecordedEmail[];
  occurrence: Readonly<{
    state: OccurrenceState;
    outcomeReason: OutcomeReason | null;
    sentAt: string | null;
  }> | null;
  now: Date;
}>;

export type RecordedEmail = Readonly<{ sentAt: string; sentTo: string }>;

export type NotSendingReason =
  | "answered"
  | "no_contact_email"
  | "link_unavailable"
  | "link_unrecoverable"
  | "recipient_undeliverable"
  | "recently_reminded"
  | "date_passed"
  | "needs_date";

export type AutomaticReminderPartyStatus =
  /** The policy is off and nothing was ever attempted: no line is shown. */
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "scheduled"; dueAt: Date }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "sent"; sentAt: string }>
  | Readonly<{ kind: "not_sending"; reason: NotSendingReason }>
  /** Something an organizer should look at before sending by hand. */
  | Readonly<{ kind: "review"; reason: "unrecorded" | "uncertain" | "rejected" }>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Skip reasons a later run may still revisit (ADR-010 §8b). */
const REACTIVATABLE: ReadonlySet<OutcomeReason> = new Set([
  "no_contact_email",
  "link_unrecoverable",
  "link_unavailable",
  "policy_disabled",
  "out_of_window",
  "recipient_undeliverable",
]);

export function automaticReminderPartyStatus(input: AutomaticReminderPartyInput): AutomaticReminderPartyStatus {
  const { occurrence, policy, now } = input;

  // Anything that crossed (or may have crossed) the provider boundary is final.
  if (occurrence) {
    switch (occurrence.state) {
      case "sent":
        return { kind: "sent", sentAt: occurrence.sentAt ?? "" };
      case "sent_unrecorded":
        return { kind: "review", reason: "unrecorded" };
      case "unknown":
        return { kind: "review", reason: "uncertain" };
      case "failed":
        return { kind: "review", reason: "rejected" };
      case "claimed":
      case "sending":
      case "retry_wait":
        return { kind: "in_progress" };
      case "skipped":
        if (occurrence.outcomeReason === "answered") return { kind: "not_sending", reason: "answered" };
        if (occurrence.outcomeReason === "recently_reminded") {
          return { kind: "not_sending", reason: "recently_reminded" };
        }
        break;
    }
  }
  const reactivatable =
    occurrence?.state === "skipped" && occurrence.outcomeReason !== null && REACTIVATABLE.has(occurrence.outcomeReason);

  if (!policy.enabled) return { kind: "off" };
  if (input.answered) return { kind: "not_sending", reason: "answered" };

  const dueAt = automaticReminderDueAt(input.weddingDate, input.weddingTimeZone, policy.daysBefore);
  if (!dueAt) return { kind: "not_sending", reason: "needs_date" };

  const window = automaticReminderWindow(dueAt, now);
  if (window === "closed") return { kind: "not_sending", reason: "date_passed" };
  // Never claimed: no retroactive send before the policy was enabled.
  const enabledAt = policy.enabledAt ? new Date(policy.enabledAt) : null;
  const policyDisabledSkip = reactivatable && occurrence?.outcomeReason === "policy_disabled";
  if (!policyDisabledSkip && enabledAt && dueAt.getTime() < enabledAt.getTime()) {
    return { kind: "not_sending", reason: "date_passed" };
  }

  if (input.linkState !== "active") return { kind: "not_sending", reason: "link_unavailable" };
  if (reactivatable && occurrence?.outcomeReason === "link_unrecoverable") {
    return { kind: "not_sending", reason: "link_unrecoverable" };
  }
  if (!input.contactEmail) return { kind: "not_sending", reason: "no_contact_email" };
  if (input.contactEmailBlocked) return { kind: "not_sending", reason: "recipient_undeliverable" };

  const lastToCurrent = lastEmailTo(input.recordedEmails, input.contactEmail);
  const suppressedUntil = (lastToCurrent ?? 0) + AUTOMATIC_REMINDER_SUPPRESSION_DAYS * DAY_MS;
  if (window === "open" && suppressedUntil > now.getTime()) {
    return { kind: "not_sending", reason: "recently_reminded" };
  }

  return { kind: "scheduled", dueAt };
}

/**
 * When the latest of `emails` sent to `recipient` (comparison form: trim +
 * lowercase, so a case variant is the same address) went out, in ms; null if
 * none did. A send to another address never counts.
 */
export function lastEmailTo(emails: readonly RecordedEmail[], recipient: string): number | null {
  const target = normalizeEmailForComparison(recipient);
  let latest: number | null = null;
  for (const email of emails) {
    if (normalizeEmailForComparison(email.sentTo) !== target) continue;
    const at = new Date(email.sentAt).getTime();
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}
