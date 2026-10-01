import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { parseStatusFilter } from "@/lib/checklist/filters";
import { getWeddingChecklist } from "@/lib/checklist/service";
import { formatNumber, getMessages } from "@/lib/i18n";
import { listMembershipInvites } from "@/lib/membership-invites/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatTimestampDate, formatWeddingDate } from "@/lib/weddings/format";
import { getWeddingDetail } from "@/lib/weddings/service";

import { ChecklistSection } from "./ChecklistSection";
import { InviteForm } from "./InviteForm";
import { RevokeInviteButton } from "./RevokeInviteButton";

export const metadata: Metadata = { title: getMessages().metadata.title };

/**
 * The wedding's home: the checklist first, then the people in the wedding.
 * Membership is checked server-side first; a non-member, a nonexistent
 * wedding and a malformed id all get the same 404. Everything is loaded
 * here on the server, after that check (RLS re-checks every read).
 */
export default async function WeddingPage({
  params,
  searchParams,
}: PageProps<"/app/weddings/[weddingId]">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const wedding = await getWeddingDetail(supabase, access.access.weddingId);
  if (!wedding) notFound();

  const isOwner = access.access.role === "owner";
  const [checklist, invites] = await Promise.all([
    getWeddingChecklist(supabase, access.access),
    isOwner ? listMembershipInvites(supabase, wedding.id) : Promise.resolve(null),
  ]);
  const { joined, status } = await searchParams;
  const { wedding: copy, roles, invites: inviteCopy, common } = getMessages();

  return (
    <div className="space-y-8">
      {joined === "new" ? <Notice tone="success">{copy.joined}</Notice> : null}
      {joined === "existing" ? <Notice tone="info">{copy.alreadyMember}</Notice> : null}

      <header className="space-y-3">
        <h1 id="wedding-name" className="text-3xl font-semibold tracking-tight">
          {wedding.name}
        </h1>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="text-muted text-sm">{copy.dateLabel}</dt>
            <dd className="font-semibold">
              {wedding.weddingDate ? formatWeddingDate(wedding.weddingDate) : copy.noDate}
            </dd>
          </div>
          <div>
            <dt className="text-muted text-sm">{copy.yourRole}</dt>
            <dd className="font-semibold" data-testid="wedding-role">
              {roles[access.access.role].label}
            </dd>
          </div>
        </dl>
      </header>

      <ChecklistSection
        weddingId={wedding.id}
        weddingDate={wedding.weddingDate}
        role={access.access.role}
        checklist={checklist}
        filter={parseStatusFilter(status)}
        basePath={`/app/weddings/${wedding.id}`}
      />

      <section aria-labelledby="people-title" className="space-y-6 border-t border-border pt-8">
        <header className="space-y-2">
          <h2 id="people-title" className="text-2xl font-semibold tracking-tight">
            {copy.peopleTitle}
          </h2>
          <p>
            <span className="text-muted">{copy.members}: </span>
            <span className="font-semibold">
              {copy.membersSummary.owners}: {formatNumber(wedding.memberCounts.owner)} ·{" "}
              {copy.membersSummary.collaborators}:{" "}
              {formatNumber(wedding.memberCounts.collaborator)}
            </span>
          </p>
          <p className="text-muted text-sm">{copy.membersNote}</p>
        </header>

        {isOwner ? (
          <section className={`${cardClass} space-y-6`} aria-labelledby="invite-title">
            <header className="space-y-2">
              <h3 id="invite-title" className="text-xl font-semibold">
                {inviteCopy.title}
              </h3>
              <p className="text-muted">{inviteCopy.intro}</p>
            </header>
            <InviteForm weddingId={wedding.id} />

            <div className="space-y-3 border-t border-border pt-6">
              <h4 className="text-lg font-semibold">{inviteCopy.listTitle}</h4>
              {invites === null ? <Notice tone="error">{common.unexpectedError}</Notice> : null}
              {invites?.length === 0 ? <p className="text-muted">{inviteCopy.listEmpty}</p> : null}
              {invites && invites.length > 0 ? (
                <>
                  <ul className="divide-y divide-border">
                    {invites.map((invite) => (
                      <li
                        key={invite.id}
                        className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div id={`invite-${invite.id}`} className="space-y-1 text-sm">
                          <p className="font-semibold break-all">
                            {invite.email ?? inviteCopy.anyone}
                          </p>
                          <p>
                            {roles[invite.role].label} ·{" "}
                            <span className="font-semibold">{inviteCopy.status[invite.status]}</span>
                          </p>
                          <p className="text-muted">
                            {inviteCopy.createdOn} {formatTimestampDate(invite.createdAt)} ·{" "}
                            {inviteCopy.expiresOn} {formatTimestampDate(invite.expiresAt)}
                          </p>
                        </div>
                        {invite.status === "pending" ? (
                          <RevokeInviteButton
                            weddingId={wedding.id}
                            inviteId={invite.id}
                            describedBy={`invite-${invite.id}`}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted text-sm">{inviteCopy.lostLinkHint}</p>
                </>
              ) : null}
            </div>
          </section>
        ) : (
          <Notice tone="info">{inviteCopy.collaboratorNote}</Notice>
        )}
      </section>

      <p>
        <Link href="/app" className={textLinkClass}>
          {copy.backToWeddings}
        </Link>
      </p>
    </div>
  );
}
