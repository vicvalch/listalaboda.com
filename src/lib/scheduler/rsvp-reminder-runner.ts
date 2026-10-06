import "server-only";

import type { EmailSender, EmailSendResult } from "@/lib/email/provider";
import { renderRsvpReminderEmail } from "@/lib/email/rsvp-reminder";
import { guestRsvpUrl } from "@/lib/guests/link";
import {
  decryptRsvpCapability,
  type RsvpCapabilityEncryptionSettings,
} from "@/lib/security/rsvp-capability-encryption";
import type {
  ClaimedOccurrence,
  FinishOutcome,
  OccurrenceState,
  RsvpReminderStore,
} from "@/lib/scheduler/rsvp-reminder-store";
import {
  SCHEDULER_MAX_CLAIMS_PER_RUN,
  SCHEDULER_MAX_CLAIMS_PER_WEDDING,
  SCHEDULER_MIN_SEND_SPACING_MS,
  SCHEDULER_PROVIDER_TIMEOUT_MS,
  SCHEDULER_RUN_BUDGET_MS,
  automaticReminderIdempotencyKey,
} from "@/lib/scheduler/timing";
import { publicSitePath } from "@/lib/wedding-site/slug";

/**
 * One run of the automatic RSVP reminder scheduler (LB-17, ADR-010). A
 * narrow orchestrator: every dependency is injected (store, email sender,
 * trusted origin, link key, clock), so tests use fakes and never reach a
 * provider.
 *
 * Per claimed occurrence, strictly sequentially:
 *   1. prepare — the database re-checks current truth and returns the
 *      CURRENT capability and render context (no attempt consumed);
 *   2. here, outside any transaction: decrypt the envelope and verify the
 *      token against the current hash, build the RSVP link from APP_ORIGIN,
 *      render the email;
 *   3. begin — the provider boundary: the database locks, re-checks, and
 *      moves claimed → sending, counting the attempt. Its success authorizes
 *      exactly ONE provider call;
 *   4. one provider call with the occurrence's stable idempotency key;
 *   5. record (accepted with an id) or finish (every other outcome).
 *
 * No database transaction or lock is open during the provider call (each
 * store operation is its own short RPC). No new claim, prepare or begin
 * starts after the 45 s budget; a provider call already begun finishes
 * within the 10 s deadline this runner passes (`timeoutMs`; manual email
 * flows pass none). Sends are spaced (≤ 2 per second).
 *
 * Nothing is logged; the summary holds counts only. The token exists only in
 * memory and in the email body.
 */

export type RunnerDeps = Readonly<{
  store: RsvpReminderStore;
  sender: EmailSender;
  /** Trusted origin from configuration (`APP_ORIGIN`), never a request header. */
  appOrigin: string;
  encryption: RsvpCapabilityEncryptionSettings;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
}>;

export type RunSummary = {
  /** The claim itself worked. */
  ok: boolean;
  claimed: number;
  sent: number;
  skipped: number;
  retry: number;
  failed: number;
  unrecorded: number;
  unknown: number;
  /** Claimed but left for a later run (budget, stale lease, changed context, errors). */
  deferred: number;
  /** The provider refused the configuration; the run stopped early. */
  aborted: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function emptySummary(): RunSummary {
  return { ok: true, claimed: 0, sent: 0, skipped: 0, retry: 0, failed: 0, unrecorded: 0, unknown: 0, deferred: 0, aborted: false };
}

/** Counts a resulting occurrence state. */
function countState(summary: RunSummary, state: OccurrenceState | null): void {
  switch (state) {
    case "sent":
      summary.sent += 1;
      return;
    case "sent_unrecorded":
      summary.unrecorded += 1;
      return;
    case "retry_wait":
      summary.retry += 1;
      return;
    case "failed":
      summary.failed += 1;
      return;
    case "skipped":
      summary.skipped += 1;
      return;
    case "unknown":
      summary.unknown += 1;
      return;
    default:
      // null (stale or unreachable): the row stays where it was; a later
      // run (or the sweep) decides it.
      summary.deferred += 1;
  }
}

/** Provider result → the closed outcome reported through finish (ADR-010 §13). */
export function finishOutcomeFor(result: EmailSendResult): FinishOutcome | null {
  if (result.ok) return null;
  switch (result.reason) {
    case "invalid_recipient":
      return "recipient_rejected";
    case "idempotency_conflict":
      return "idempotency_conflict";
    default:
      // configuration, provider_failure, unknown, timeout,
      // idempotency_in_progress: the email may or may not have gone out.
      return "retry";
  }
}

export async function runAutomaticRsvpReminders(deps: RunnerDeps): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const budgetMs = deps.budgetMs ?? SCHEDULER_RUN_BUDGET_MS;
  const startedAt = now();
  const withinBudget = () => now() - startedAt < budgetMs;
  const summary = emptySummary();

  const claimed = await deps.store.claim(SCHEDULER_MAX_CLAIMS_PER_RUN, SCHEDULER_MAX_CLAIMS_PER_WEDDING);
  if (!claimed) return { ...summary, ok: false };
  summary.claimed = claimed.length;

  let lastSendAt: number | null = null;

  for (let index = 0; index < claimed.length; index += 1) {
    const occurrence = claimed[index];
    if (!withinBudget()) {
      // Their leases expire; a later run reclaims them with nothing consumed.
      summary.deferred += claimed.length - index;
      break;
    }
    const result = await processOccurrence(deps, occurrence, {
      withinBudget,
      beforeSend: async () => {
        if (lastSendAt !== null) {
          const wait = lastSendAt + SCHEDULER_MIN_SEND_SPACING_MS - now();
          if (wait > 0) await sleep(wait);
        }
        lastSendAt = now();
      },
    });
    if (result.state === "deferred") summary.deferred += 1;
    else countState(summary, result.state);
    if (result.abort) {
      // The provider refused our configuration: stop. The remaining claims'
      // leases expire and a later run reclaims them with nothing consumed.
      summary.aborted = true;
      summary.deferred += claimed.length - index - 1;
      break;
    }
  }
  return summary;
}

type Hooks = Readonly<{ withinBudget: () => boolean; beforeSend: () => Promise<void> }>;

async function processOccurrence(
  deps: RunnerDeps,
  occurrence: ClaimedOccurrence,
  hooks: Hooks,
): Promise<Readonly<{ state: OccurrenceState | null | "deferred"; abort?: true }>> {
  const done = (state: OccurrenceState | null | "deferred") => ({ state });

  // 1. Prepare: current truth, no attempt consumed.
  const prepared = await deps.store.prepare(occurrence);
  if (prepared.status === "skipped") return done("skipped");
  if (prepared.status === "unknown") return done("unknown");
  if (prepared.status !== "ready") return done("deferred");
  const reminder = prepared.reminder;

  // 2. Outside any transaction: decrypt, verify, render.
  const token = decryptRsvpCapability({
    envelope: reminder.envelope,
    expectedTokenHash: reminder.tokenHash,
    key: deps.encryption.key,
  });
  if (!token) return done(await deps.store.finish(occurrence, "link_unrecoverable"));

  let email;
  try {
    email = renderRsvpReminderEmail({
      partyLabel: reminder.partyLabel,
      weddingName: reminder.weddingName,
      weddingDate: reminder.weddingDate,
      weddingCity: reminder.weddingCity,
      rsvpUrl: guestRsvpUrl(token, deps.appOrigin),
      siteUrl: reminder.siteSlug ? new URL(publicSitePath(reminder.siteSlug), deps.appOrigin).toString() : null,
    });
  } catch {
    // A programming error: nothing recorded, the lease expires, a later run
    // retries with no attempt consumed.
    return done("deferred");
  }

  if (!hooks.withinBudget()) return done("deferred");

  // 3. Begin: the provider boundary.
  const begun = await deps.store.begin(occurrence, { tokenHash: reminder.tokenHash, recipient: reminder.recipient });
  if (begun.status === "skipped") return done("skipped");
  if (begun.status === "unknown") return done("unknown");
  if (begun.status !== "sending") return done("deferred");

  // 4. Exactly one provider call, same key on every attempt of this occurrence.
  await hooks.beforeSend();
  let sent: EmailSendResult;
  try {
    sent = await deps.sender.send(
      { to: reminder.recipient, ...email },
      {
        idempotencyKey: automaticReminderIdempotencyKey(occurrence.occurrenceId),
        timeoutMs: SCHEDULER_PROVIDER_TIMEOUT_MS,
      },
    );
  } catch {
    sent = { ok: false, reason: "provider_failure" };
  }

  // 5. Record or finish.
  if (sent.ok) {
    if (sent.messageId) {
      const recorded = await deps.store.record({
        occurrenceId: occurrence.occurrenceId,
        claimToken: occurrence.claimToken,
        tokenHash: reminder.tokenHash,
        recipient: reminder.recipient,
        providerMessageId: sent.messageId,
      });
      if (recorded.ok) return done("sent");
    }
    return done(await deps.store.finish(occurrence, "sent_unrecorded"));
  }

  const state = await deps.store.finish(occurrence, finishOutcomeFor(sent) ?? "retry");
  return sent.reason === "configuration" ? { state, abort: true } : done(state);
}
