import "server-only";

import { createClient } from "@supabase/supabase-js";

import { parseRecorderSettings } from "@/lib/email/delivery-recorder";
import { isStorableMessageId } from "@/lib/email/provider";
import { getPublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The automatic RSVP reminder scheduler's database boundary (LB-17,
 * ADR-010 §21): the application's SECOND and only other service-role use
 * besides `@/lib/email/delivery-recorder` (ADR-002 §6).
 *
 * Why privileged: the scheduler runs with no session at all (a cron call),
 * and it must read a party's capability envelope and drive a state machine
 * that no client may touch. Every database function it calls is SECURITY
 * DEFINER and executable ONLY by service_role.
 *
 * Exactly five named operations, each one fixed RPC — `claim`, `prepare`,
 * `begin`, `record`, `finish`. The privileged client is created inside and
 * never returned or exported: no `from()`, no generic `rpc(name)`, no query
 * helper, no authorization. The key is read only here (ESLint allows it in
 * this file and the delivery recorder), never logged, returned or echoed;
 * missing or wrong configuration fails closed (`null`).
 *
 * `record` also writes the send's `email_deliveries` ledger row (LB-18.1,
 * ADR-011) inside the same database function and transaction.
 *
 * Capability material (hash, envelope) passes through `prepare`'s result to
 * the runner's memory only; nothing here stores, logs or caches it.
 */

type Rpc = Database["public"]["Functions"];

export type ClaimedOccurrence = Readonly<{ occurrenceId: string; claimToken: string }>;

/** What prepare returns for a ready occurrence: CURRENT truth, in memory only. */
export type PreparedReminder = Readonly<{
  tokenHash: string;
  envelope: string;
  recipient: string;
  partyLabel: string;
  weddingName: string;
  weddingDate: string | null;
  weddingCity: string | null;
  siteSlug: string | null;
}>;

export type PrepareResult =
  | Readonly<{ status: "ready"; reminder: PreparedReminder }>
  | Readonly<{ status: "skipped" | "unknown" | "stale" | "error" }>;

export type BeginResult =
  | Readonly<{ status: "sending"; attempt: number }>
  | Readonly<{ status: "skipped" | "unknown" | "stale" | "context_changed" | "error" }>;

export type RecordInput = Readonly<{
  occurrenceId: string;
  claimToken: string;
  tokenHash: string;
  recipient: string;
  providerMessageId: string;
}>;

export type FinishOutcome = Database["public"]["Enums"]["automatic_rsvp_reminder_finish_outcome"];
export type OccurrenceState = Database["public"]["Enums"]["automatic_rsvp_reminder_state"];

export interface RsvpReminderStore {
  claim(maxTotal: number, maxPerWedding: number): Promise<readonly ClaimedOccurrence[] | null>;
  prepare(occurrence: ClaimedOccurrence): Promise<PrepareResult>;
  begin(occurrence: ClaimedOccurrence, expected: Readonly<{ tokenHash: string; recipient: string }>): Promise<BeginResult>;
  record(entry: RecordInput): Promise<Readonly<{ ok: true; sentAt: string }> | Readonly<{ ok: false }>>;
  finish(occurrence: ClaimedOccurrence, outcome: FinishOutcome): Promise<OccurrenceState | null>;
}

type StoreSettings = Readonly<{ supabaseUrl: string; serviceRoleKey: string }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isOccurrence(occurrence: ClaimedOccurrence): boolean {
  return UUID_PATTERN.test(occurrence.occurrenceId) && UUID_PATTERN.test(occurrence.claimToken);
}

/** Builds the store from explicit settings (the factory below, and DB tests). */
export function createRsvpReminderStore({ supabaseUrl, serviceRoleKey }: StoreSettings): RsvpReminderStore {
  const privileged = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  return {
    async claim(maxTotal, maxPerWedding) {
      const args: Rpc["claim_automatic_rsvp_reminders"]["Args"] = {
        max_total: maxTotal,
        max_per_wedding: maxPerWedding,
      };
      try {
        const { data, error } = await privileged.rpc("claim_automatic_rsvp_reminders", args);
        if (error || !data) return null;
        return data.map((row) => ({ occurrenceId: row.occurrence_id, claimToken: row.occurrence_claim_token }));
      } catch {
        return null;
      }
    },

    async prepare(occurrence) {
      if (!isOccurrence(occurrence)) return { status: "error" };
      try {
        const { data, error } = await privileged.rpc("prepare_automatic_rsvp_reminder", {
          target_occurrence_id: occurrence.occurrenceId,
          occurrence_claim_token: occurrence.claimToken,
        });
        const row = data?.[0];
        if (error || !row || data.length !== 1) return { status: "error" };
        if (row.status === "skipped" || row.status === "unknown" || row.status === "stale") {
          return { status: row.status };
        }
        if (row.status !== "ready") return { status: "error" };
        // The generated return type marks every column non-null; date, city
        // and slug can be null.
        const weddingDate: string | null = row.current_wedding_date;
        const weddingCity: string | null = row.current_wedding_city;
        const siteSlug: string | null = row.current_site_slug;
        if (
          !TOKEN_HASH_PATTERN.test(row.current_token_hash ?? "") ||
          !row.current_token_ciphertext ||
          !row.current_recipient ||
          !row.current_party_label ||
          !row.current_wedding_name
        ) {
          return { status: "error" };
        }
        return {
          status: "ready",
          reminder: {
            tokenHash: row.current_token_hash,
            envelope: row.current_token_ciphertext,
            recipient: row.current_recipient,
            partyLabel: row.current_party_label,
            weddingName: row.current_wedding_name,
            weddingDate,
            weddingCity,
            siteSlug,
          },
        };
      } catch {
        return { status: "error" };
      }
    },

    async begin(occurrence, expected) {
      if (!isOccurrence(occurrence) || !TOKEN_HASH_PATTERN.test(expected.tokenHash)) return { status: "error" };
      try {
        const { data, error } = await privileged.rpc("begin_automatic_rsvp_reminder_send", {
          target_occurrence_id: occurrence.occurrenceId,
          occurrence_claim_token: occurrence.claimToken,
          expected_token_hash: expected.tokenHash,
          expected_recipient: expected.recipient,
        });
        const row = data?.[0];
        if (error || !row || data.length !== 1) return { status: "error" };
        if (row.status === "sending" && Number.isInteger(row.attempt_number)) {
          return { status: "sending", attempt: row.attempt_number };
        }
        if (
          row.status === "skipped" ||
          row.status === "unknown" ||
          row.status === "stale" ||
          row.status === "context_changed"
        ) {
          return { status: row.status };
        }
        return { status: "error" };
      } catch {
        return { status: "error" };
      }
    },

    async record(entry) {
      if (
        !isOccurrence(entry) ||
        !TOKEN_HASH_PATTERN.test(entry.tokenHash) ||
        !isStorableMessageId(entry.providerMessageId)
      ) {
        return { ok: false };
      }
      try {
        const { data, error } = await privileged.rpc("record_automatic_rsvp_reminder_email", {
          target_occurrence_id: entry.occurrenceId,
          occurrence_claim_token: entry.claimToken,
          invitation_token_hash: entry.tokenHash,
          recipient: entry.recipient,
          provider_message_id: entry.providerMessageId,
        });
        if (error || typeof data !== "string") return { ok: false };
        return { ok: true, sentAt: data };
      } catch {
        return { ok: false };
      }
    },

    async finish(occurrence, outcome) {
      if (!isOccurrence(occurrence)) return null;
      try {
        const { data, error } = await privileged.rpc("finish_automatic_rsvp_reminder", {
          target_occurrence_id: occurrence.occurrenceId,
          occurrence_claim_token: occurrence.claimToken,
          outcome,
        });
        if (error || !data) return null;
        return data;
      } catch {
        return null;
      }
    },
  };
}

/** The store from the server environment, or null when not configured. */
export function getRsvpReminderStore(): RsvpReminderStore | null {
  let supabaseUrl: string;
  try {
    supabaseUrl = getPublicEnv().supabaseUrl;
  } catch {
    return null;
  }
  const settings = parseRecorderSettings({
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    // ADR-010 §21: the second sanctioned read of this key (eslint allows it here and in delivery-recorder.ts only).
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return settings ? createRsvpReminderStore(settings) : null;
}
