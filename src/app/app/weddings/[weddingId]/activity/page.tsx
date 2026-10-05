import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import {
  activityActorLabel,
  activityActorLine,
  activityEventLabel,
  activityPartyLabel,
} from "@/lib/activity/presentation";
import { ACTIVITY_LIMIT, listWeddingActivity } from "@/lib/activity/service";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatWeddingTimestamp } from "@/lib/weddings/format";
import { labelMembers } from "@/lib/weddings/members";
import { getWeddingDetail, listWeddingMembers } from "@/lib/weddings/service";

export const metadata: Metadata = { title: getMessages().activity.title };

/**
 * "Actividad": the wedding's recent activity history (LB-15), a secondary,
 * read-only area next to the checklist (which stays the wedding's home).
 * Any member (owner or collaborator) sees it; membership is checked
 * server-side first, and a non-member, a nonexistent wedding and a
 * malformed id all get the same 404. At most `ACTIVITY_LIMIT` events,
 * newest first. Each row says what happened, to which party (its current
 * name), who did it and when, in the wedding's time zone (UTC without
 * one). Text comes from the catalog, by event type: nothing stored is
 * rendered as markup, and there are no links, answers, notes, addresses or
 * provider data here.
 */
export default async function ActivityPage({ params }: PageProps<"/app/weddings/[weddingId]/activity">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/activity`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [wedding, entries, members] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    listWeddingActivity(supabase, access.access),
    listWeddingMembers(supabase, access.access),
  ]);
  if (!wedding) notFound();

  const copy = getMessages().activity;
  const labeled = labelMembers(members ?? []);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <p className="text-muted text-sm font-semibold break-words">{wedding.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted">{copy.intro}</p>
        <p>
          <Link href={`/app/weddings/${wedding.id}`} className={`${textLinkClass} text-sm`}>
            {copy.backToChecklist}
          </Link>
        </p>
      </header>

      <section aria-label={copy.listLabel} className="space-y-4">
        {entries === null ? <Notice tone="error">{copy.loadFailed}</Notice> : null}
        {entries?.length === 0 ? (
          <div className="space-y-1" data-testid="activity-empty">
            <p className="font-semibold">{copy.empty.title}</p>
            <p className="text-muted">{copy.empty.body}</p>
          </div>
        ) : null}
        {entries && entries.length > 0 ? (
          <ol className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-sm">
            {entries.map((entry) => (
              <li key={entry.id} className="space-y-1 px-4 py-3 sm:px-6" data-testid="activity-entry">
                <p className="font-semibold" data-testid="activity-event">
                  {activityEventLabel(entry.eventType)}
                </p>
                <p className="break-words" data-testid="activity-party">
                  {activityPartyLabel(entry.partyLabel)}
                </p>
                <p className="text-muted text-sm">
                  <span data-testid="activity-actor">
                    {activityActorLine(activityActorLabel(entry.actorKind, entry.actorMembershipId, labeled))}
                  </span>
                  {" · "}
                  <time dateTime={entry.occurredAt}>{formatWeddingTimestamp(entry.occurredAt, wedding.timeZone)}</time>
                </p>
              </li>
            ))}
          </ol>
        ) : null}
        {entries && entries.length >= ACTIVITY_LIMIT ? (
          <p className="text-muted text-sm">
            {interpolate(copy.limitNote, { count: formatNumber(ACTIVITY_LIMIT) })}
          </p>
        ) : null}
        <p className="text-muted text-sm">{copy.sinceNote}</p>
      </section>
    </div>
  );
}
