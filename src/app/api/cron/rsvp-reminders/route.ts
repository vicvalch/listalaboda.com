import { NextResponse, type NextRequest } from "next/server";

import { authenticateCronRequest, getCronSecret } from "@/lib/scheduler/cron-auth";
import { runAutomaticRsvpReminders, type RunSummary } from "@/lib/scheduler/rsvp-reminder-runner";
import { getAutomaticReminderRuntime } from "@/lib/scheduler/runtime";

/**
 * The automatic RSVP reminder scheduler's entry point (LB-17, ADR-010 §3,
 * §4). Called by the deployment's cron with GET (Vercel Cron's method) and
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * Scheduled once daily by `vercel.json` (`0 15 * * *`, Vercel Hobby;
 * LB-17A.2). Nothing is sent unless an owner has enabled a reminder policy;
 * every production policy is OFF.
 *
 * - GET only; Next answers 405 for every other method (none is exported).
 * - The bearer secret is checked first, in `@/lib/scheduler/cron-auth`
 *   (timing-safe). No secret configured → 503; wrong or missing → 401. In
 *   both cases nothing else runs: no configuration read, no database, no email.
 * - The query string is ignored entirely: it never carries a secret or
 *   selects work. No cookies or member session are read; `/api/cron` is
 *   excluded from the session proxy.
 * - Repeated or concurrent calls are safe: the database claims decide.
 * - The response and logs carry counts only: never ids, labels, addresses,
 *   tokens, hashes or provider ids.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function empty(status: number): NextResponse {
  return new NextResponse(null, { status, headers: NO_STORE });
}

function counts(summary: RunSummary): Record<string, number | boolean> {
  return {
    ok: summary.ok,
    claimed: summary.claimed,
    sent: summary.sent,
    skipped: summary.skipped,
    retry: summary.retry,
    failed: summary.failed,
    unrecorded: summary.unrecorded,
    unknown: summary.unknown,
    deferred: summary.deferred,
    aborted: summary.aborted,
  };
}

export async function GET(request: NextRequest) {
  const auth = authenticateCronRequest(request.headers.get("authorization"), getCronSecret());
  if (auth === "not_configured") return empty(503);
  if (auth !== "authorized") return empty(401);

  const runtime = getAutomaticReminderRuntime();
  if (!runtime) return empty(503);

  const summary = await runAutomaticRsvpReminders(runtime);
  return NextResponse.json(counts(summary), { status: summary.ok ? 200 : 500, headers: NO_STORE });
}
