import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Notice } from "@/components/ui/Notice";
import { cardClass, textLinkClass } from "@/components/ui/styles";
import { loginPath } from "@/lib/auth/redirect";
import { requireUser } from "@/lib/auth/session";
import { requireWeddingMembership } from "@/lib/authz/wedding";
import { checklistItemHref, guestPartyAnchor } from "@/lib/checklist/guest-work";
import { CONTACT_EMAIL_MAX_LENGTH } from "@/lib/guests/contact-email";
import { guestLinkExpiresAt, guestLinkState } from "@/lib/guests/link";
import { listGuestParties, type GuestListParty } from "@/lib/guests/service";
import { guestResponseStatus, summarizeGuests, type GuestSummary } from "@/lib/guests/summary";
import { GUEST_NAME_MAX_LENGTH, PARTY_LABEL_MAX_LENGTH } from "@/lib/guests/validation";
import { formatDate, formatNumber, getMessages, interpolate } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatWeddingTimestamp } from "@/lib/weddings/format";
import { getWeddingDetail } from "@/lib/weddings/service";

import {
  addGuestAction,
  deletePartyAction,
  removeContactEmailAction,
  removeGuestAction,
  revokeLinkAction,
  saveContactEmailAction,
  updateGuestNameAction,
  updatePartyLabelAction,
} from "./actions";
import { ConfirmButton } from "./ConfirmButton";
import { NewPartyForm } from "./NewPartyForm";
import { PersonalLinkPanel } from "./PersonalLinkPanel";
import { ReminderPanel } from "./ReminderPanel";
import { RotateAndSendButton } from "./RotateAndSendButton";
import { RotateLinkButton } from "./RotateLinkButton";
import { TextEditForm } from "./TextEditForm";

export const metadata: Metadata = { title: getMessages().guests.title };

/**
 * "Invitados": the wedding's guest list, a secondary area next to the
 * checklist (which stays the wedding's home). Any member — owner or
 * collaborator — sees and manages its content; only owners see the link
 * actions (replace/revoke), which the service and database also enforce; any member can explicitly
 * show a party's current link (LB-13) or remind the party with it (LB-14), which this page never loads by
 * itself; membership is checked server-side
 * first and a non-member, a nonexistent wedding and a malformed id all get
 * the same 404, without revealing whether any guest data exists. All data
 * is loaded here after that check, in a bounded number of queries; counts
 * and link states are derived in memory.
 */
export default async function GuestsPage({
  params,
  searchParams,
}: PageProps<"/app/weddings/[weddingId]/guests">) {
  const { weddingId } = await params;
  const selfPath = `/app/weddings/${encodeURIComponent(weddingId)}/guests`;
  await requireUser(selfPath);

  const supabase = await createSupabaseServerClient();
  const access = await requireWeddingMembership(supabase, weddingId);
  if (!access.ok) {
    if (access.reason === "unauthenticated") redirect(loginPath(selfPath));
    notFound();
  }

  const [wedding, parties] = await Promise.all([
    getWeddingDetail(supabase, access.access.weddingId),
    listGuestParties(supabase, access.access),
  ]);
  if (!wedding) notFound();

  // One server clock read per request, used only to label links.
  const now = new Date();
  const { done } = await searchParams;
  const copy = getMessages().guests;

  return (
    <div className="space-y-8">
      {done === "revoked" ? <Notice tone="success">{copy.revoke.done}</Notice> : null}
      {done === "deleted" ? <Notice tone="success">{copy.deleteParty.done}</Notice> : null}

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

      {parties ? <SummarySection summary={summarizeGuests(parties)} /> : null}

      <section className={`${cardClass} space-y-4`} aria-labelledby="new-party-title">
        <h2 id="new-party-title" className="text-xl font-semibold">
          {copy.newParty.title}
        </h2>
        <NewPartyForm weddingId={wedding.id} />
      </section>

      <section aria-labelledby="parties-title" className="space-y-4">
        <h2 id="parties-title" className="text-2xl font-semibold tracking-tight">
          {copy.partiesTitle}
        </h2>
        {parties === null ? <Notice tone="error">{copy.loadFailed}</Notice> : null}
        {parties?.length === 0 ? (
          <div className="space-y-1">
            <p className="font-semibold">{copy.empty.title}</p>
            <p className="text-muted">{copy.empty.body}</p>
          </div>
        ) : null}
        {parties && parties.length > 0 ? (
          <ul className="space-y-4">
            {parties.map((party) => (
              <li key={party.id}>
                <PartyCard
                  weddingId={wedding.id}
                  weddingDate={wedding.weddingDate}
                  weddingTimeZone={wedding.timeZone}
                  party={party}
                  now={now}
                  canAdministerLink={access.access.role === "owner"}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function SummarySection({ summary }: { summary: GuestSummary }) {
  const s = getMessages().guests.summary;
  const items = [
    { key: "total", value: summary.total, label: summary.total === 1 ? s.totalOne : s.total },
    {
      key: "attending",
      value: summary.attending,
      label: summary.attending === 1 ? s.attendingOne : s.attending,
    },
    {
      key: "not-attending",
      value: summary.notAttending,
      label: summary.notAttending === 1 ? s.notAttendingOne : s.notAttending,
    },
    { key: "pending", value: summary.pending, label: s.pending },
    { key: "parties", value: summary.parties, label: summary.parties === 1 ? s.partiesOne : s.parties },
  ];
  return (
    <section aria-label={s.label}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="guest-summary">
        {items.map((item) => (
          <li
            key={item.key}
            className="rounded-xl border border-border bg-surface p-3"
            data-testid={`guest-summary-${item.key}`}
          >
            <span className="block text-2xl font-semibold">{formatNumber(item.value)}</span>
            <span className="text-muted text-sm">{item.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type PartyCardProps = {
  weddingId: string;
  weddingDate: string | null;
  weddingTimeZone: string | null;
  party: GuestListParty;
  now: Date;
  /** Owner: may replace or revoke the link. Cosmetic; the server re-checks. */
  canAdministerLink: boolean;
};

function PartyCard({
  weddingId,
  weddingDate,
  weddingTimeZone,
  party,
  now,
  canAdministerLink,
}: PartyCardProps) {
  const copy = getMessages().guests;
  const checklistStatus = getMessages().checklist.status;
  const titleId = `party-${party.id}-title`;
  const linkState = guestLinkState(party, weddingDate, now);
  const expiresAt = guestLinkExpiresAt(party.tokenIssuedAt, weddingDate);
  const onlyGuest = party.guests.length === 1;
  const partyKeys = { weddingId, guestInvitationId: party.id };

  return (
    <article
      id={guestPartyAnchor(party.id)}
      aria-labelledby={titleId}
      className="scroll-mt-4 space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      data-testid="guest-party"
    >
      <header className="space-y-1">
        <h3 id={titleId} className="text-xl font-semibold break-words">
          {party.label}
        </h3>
        <p className="text-muted text-sm">
          {party.guests.length === 1
            ? copy.guestCountOne
            : interpolate(copy.guestCountMany, { count: formatNumber(party.guests.length) })}
        </p>
        <p className="text-sm" data-testid="guest-link-state">
          <span className="font-semibold">{copy.link[linkState]}</span>
          {linkState === "active" ? (
            <span className="text-muted">
              {" "}
              ·{" "}
              {interpolate(copy.link.validUntil, {
                // The last day it works (it stops at 00:00 UTC the next day).
                date: formatDate(new Date(expiresAt.getTime() - 1), {
                  dateStyle: "long",
                  timeZone: "UTC",
                }),
              })}
            </span>
          ) : null}
        </p>
      </header>

      {/* LB-16: the checklist items about this party, linking back to the
          list. Title and status only; editing stays on the checklist. */}
      {party.relatedChecklistItems.length > 0 ? (
        <section
          aria-labelledby={`${titleId}-related`}
          className="space-y-1.5 rounded-xl bg-accent-soft p-3"
          data-testid="party-related-items"
        >
          <h4 id={`${titleId}-related`} className="text-sm font-semibold">
            {copy.relatedItems.title}
          </h4>
          <ul className="space-y-1 text-sm">
            {party.relatedChecklistItems.map((item) => (
              <li key={item.id} className="break-words">
                <Link href={checklistItemHref(weddingId, item.id)} className={textLinkClass}>
                  {item.title}
                </Link>
                <span className="text-muted"> · {checklistStatus[item.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ul className="divide-y divide-border" aria-label={party.label}>
        {party.guests.map((guest) => {
          const status = guestResponseStatus(guest.rsvp);
          return (
            <li
              key={guest.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              data-testid="guest-row"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold break-words" data-testid="guest-name">
                  {guest.name}
                </p>
                <p className="text-sm" data-testid="guest-status">
                  {copy.status[status]}
                </p>
                {guest.rsvp?.dietaryNote ? (
                  <p className="text-muted text-sm break-words" data-testid="guest-dietary-note">
                    {copy.dietaryNote} {guest.rsvp.dietaryNote}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <TextEditForm
                  action={updateGuestNameAction}
                  hidden={{ weddingId, guestId: guest.id }}
                  id={`edit-guest-${guest.id}`}
                  openLabel={copy.editGuest.open}
                  openAriaLabel={interpolate(copy.editGuest.openFor, { name: guest.name })}
                  fieldLabel={copy.editGuest.label}
                  defaultValue={guest.name}
                  maxLength={GUEST_NAME_MAX_LENGTH}
                  submitLabel={copy.editGuest.submit}
                  pendingLabel={copy.editGuest.submitting}
                />
                {/* A party is never empty: its only guest goes with the party
                    ("Eliminar grupo"). The database enforces it too. */}
                {onlyGuest ? null : (
                <ConfirmButton
                  action={removeGuestAction}
                  hidden={{ weddingId, guestId: guest.id }}
                  id={`remove-guest-${guest.id}`}
                  openLabel={copy.removeGuest.open}
                  openAriaLabel={interpolate(copy.removeGuest.openFor, { name: guest.name })}
                  confirmTitle={interpolate(copy.removeGuest.confirmTitle, { name: guest.name })}
                  confirmBody={[
                    ...(guest.rsvp ? [copy.removeGuest.confirmWithRsvp] : []),
                    copy.removeGuest.confirmBody,
                  ]}
                  confirmLabel={copy.removeGuest.confirmButton}
                  cancelLabel={copy.removeGuest.cancel}
                />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-start gap-2 border-t border-border pt-4">
        <TextEditForm
          action={addGuestAction}
          hidden={partyKeys}
          id={`add-guest-${party.id}`}
          openLabel={copy.addGuest.open}
          fieldLabel={copy.addGuest.label}
          maxLength={GUEST_NAME_MAX_LENGTH}
          submitLabel={copy.addGuest.submit}
          pendingLabel={copy.addGuest.submitting}
        />
        <TextEditForm
          action={updatePartyLabelAction}
          hidden={partyKeys}
          id={`edit-party-${party.id}`}
          openLabel={copy.editParty.open}
          fieldLabel={copy.editParty.label}
          defaultValue={party.label}
          maxLength={PARTY_LABEL_MAX_LENGTH}
          submitLabel={copy.editParty.submit}
          pendingLabel={copy.editParty.submitting}
        />
      </div>

      <ContactEmailSection
        weddingId={weddingId}
        weddingTimeZone={weddingTimeZone}
        party={party}
        canAdministerLink={canAdministerLink}
      />

      <div className="space-y-3 border-t border-border pt-4">
        {/* LB-13: the current link only on an explicit request; this page
            never loads or decrypts any link. Dead links aren't offered. */}
        {linkState === "active" ? (
          <>
            <PersonalLinkPanel
              weddingId={weddingId}
              guestInvitationId={party.id}
              partyLabel={party.label}
              canAdministerLink={canAdministerLink}
            />
            {/* LB-14: manual reminders with the SAME current link, recovered
                only when the organizer asks; never a new link. */}
            <ReminderPanel
              weddingId={weddingId}
              guestInvitationId={party.id}
              partyLabel={party.label}
              contactEmail={party.contactEmail}
              canAdministerLink={canAdministerLink}
            />
          </>
        ) : (
          <div className="space-y-1">
            <p className="text-muted text-sm">
              {canAdministerLink ? copy.personalLink.inactive : copy.personalLink.inactiveCollaborator}
            </p>
            <p className="text-muted text-sm" data-testid="reminder-inactive">
              {copy.reminder.inactive}
            </p>
          </div>
        )}
        {canAdministerLink ? (
          <RotateLinkButton weddingId={weddingId} guestInvitationId={party.id} partyLabel={party.label} />
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          {canAdministerLink && linkState !== "revoked" ? (
            <ConfirmButton
              action={revokeLinkAction}
              hidden={partyKeys}
              id={`revoke-${party.id}`}
              openLabel={copy.revoke.open}
              confirmTitle={interpolate(copy.revoke.confirmTitle, { party: party.label })}
              confirmBody={[copy.revoke.confirmBody]}
              confirmLabel={copy.revoke.confirmButton}
              cancelLabel={copy.revoke.cancel}
            />
          ) : null}
          <ConfirmButton
            action={deletePartyAction}
            hidden={partyKeys}
            id={`delete-party-${party.id}`}
            openLabel={copy.deleteParty.open}
            confirmTitle={interpolate(copy.deleteParty.confirmTitle, { party: party.label })}
            confirmBody={[copy.deleteParty.confirmBody]}
            confirmLabel={copy.deleteParty.confirmButton}
            cancelLabel={copy.deleteParty.cancel}
          />
        </div>
      </div>
    </article>
  );
}

type ContactEmailSectionProps = {
  weddingId: string;
  weddingTimeZone: string | null;
  party: GuestListParty;
  canAdministerLink: boolean;
};

/**
 * The party's contact email (members only — this page), its invitation
 * email status and, separately, its latest RSVP confirmation email (LB-12;
 * sent automatically when the party answers, so there is no button) and its
 * latest RSVP reminder email (LB-14; sent from the reminder panel). The
 * recipients shown are where each email actually went, which may differ
 * from the current contact email. Any member adds, edits or removes the email. Emailing needs
 * a link whose plaintext exists right now: a fresh one (shown after
 * creating or replacing it, with its own send button) or, for an owner,
 * "Generar nuevo enlace y enviar". A collaborator is told an owner must
 * generate the new link; the server enforces it either way.
 */
function ContactEmailSection({ weddingId, weddingTimeZone, party, canAdministerLink }: ContactEmailSectionProps) {
  const copy = getMessages().guests;
  const partyKeys = { weddingId, guestInvitationId: party.id };
  const sent = party.invitationEmail;
  const confirmed = party.rsvpConfirmationEmail;
  const reminded = party.rsvpReminderEmail;
  const linkChangedSince = sent !== null && new Date(party.tokenIssuedAt) > new Date(sent.sentAt);

  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="party-contact">
      <div className="space-y-1 text-sm">
        <p>
          <span className="font-semibold">{copy.contactEmail.label}:</span>{" "}
          <span className="break-all" data-testid="party-contact-email">
            {party.contactEmail ?? copy.contactEmail.none}
          </span>
        </p>
        <p>
          <span className="font-semibold">{copy.invitationEmail.title}:</span>{" "}
          <span data-testid="party-invitation-email-status">
            {sent
              ? interpolate(copy.invitationEmail.lastSent, {
                  date: formatWeddingTimestamp(sent.sentAt, weddingTimeZone),
                  email: sent.sentTo,
                })
              : copy.invitationEmail.never}
          </span>
        </p>
        {linkChangedSince ? <p className="text-muted">{copy.invitationEmail.linkChangedSince}</p> : null}
        <p>
          <span className="font-semibold">{copy.rsvpConfirmationEmail.title}:</span>{" "}
          <span data-testid="party-rsvp-confirmation-status">
            {confirmed
              ? interpolate(copy.rsvpConfirmationEmail.lastSent, {
                  date: formatWeddingTimestamp(confirmed.sentAt, weddingTimeZone),
                  email: confirmed.sentTo,
                })
              : copy.rsvpConfirmationEmail.never}
          </span>
        </p>
        <p>
          <span className="font-semibold">{copy.reminder.emailStatusTitle}:</span>{" "}
          <span data-testid="party-reminder-email-status">
            {reminded
              ? interpolate(copy.reminder.lastSent, {
                  date: formatWeddingTimestamp(reminded.sentAt, weddingTimeZone),
                  email: reminded.sentTo,
                })
              : copy.reminder.never}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <TextEditForm
          action={saveContactEmailAction}
          hidden={partyKeys}
          id={`contact-email-${party.id}`}
          openLabel={party.contactEmail ? copy.contactEmail.edit : copy.contactEmail.add}
          fieldLabel={copy.contactEmail.fieldLabel}
          defaultValue={party.contactEmail ?? ""}
          maxLength={CONTACT_EMAIL_MAX_LENGTH}
          inputType="email"
          submitLabel={copy.contactEmail.submit}
          pendingLabel={copy.contactEmail.submitting}
        />
        {party.contactEmail ? (
          <ConfirmButton
            action={removeContactEmailAction}
            hidden={partyKeys}
            id={`remove-email-${party.id}`}
            openLabel={copy.contactEmail.remove.open}
            confirmTitle={interpolate(copy.contactEmail.remove.confirmTitle, { party: party.label })}
            confirmBody={[copy.contactEmail.remove.confirmBody]}
            confirmLabel={copy.contactEmail.remove.confirmButton}
            cancelLabel={copy.contactEmail.remove.cancel}
          />
        ) : null}
      </div>
      {party.contactEmail ? <p className="text-muted text-sm">{copy.rsvpConfirmationEmail.hint}</p> : null}
      {!party.contactEmail ? (
        <p className="text-muted text-sm">{copy.invitationEmail.needsEmail}</p>
      ) : canAdministerLink ? (
        <div className="space-y-2">
          <p className="text-muted text-sm">{copy.invitationEmail.includes}</p>
          <RotateAndSendButton
            weddingId={weddingId}
            guestInvitationId={party.id}
            partyLabel={party.label}
            contactEmail={party.contactEmail}
          />
        </div>
      ) : (
        <p className="text-muted text-sm" data-testid="invitation-email-owner-required">
          {copy.invitationEmail.ownerRequired}
        </p>
      )}
    </div>
  );
}
