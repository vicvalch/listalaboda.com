"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";

import { CopyLink } from "../CopyLink";
import { rotateAndSendAction, type RotateAndSendState } from "./actions";
import { FreshLinkPanel } from "./FreshLinkPanel";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  weddingId: string;
  /** Lookup key only. */
  guestInvitationId: string;
  partyLabel: string;
  contactEmail: string;
  /**
   * LB-18.3: the current address bounced, was suppressed or complained. This
   * action always emails, so it is disabled (the server refuses it anyway);
   * "Generar nuevo enlace" alone stays available.
   */
  emailBlocked?: boolean;
};

/**
 * "Generar nuevo enlace y enviar" (owners only; the server re-checks). An
 * explicit confirmation says that the old link stops working and where the
 * new one goes. If the email then fails, the new link is shown anyway (the
 * old one is already gone) with a retry; otherwise the new link is shown to
 * copy, as after any rotation (manual sharing keeps working).
 */
export function RotateAndSendButton({
  weddingId,
  guestInvitationId,
  partyLabel,
  contactEmail,
  emailBlocked = false,
}: Props) {
  const [state, formAction] = useActionState<RotateAndSendState, FormData>(rotateAndSendAction, null);
  const currentNonce = state?.nonce ?? "none";
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const confirming = confirmingFor === currentNonce;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = getMessages().guests;
  const descriptionId = `rotate-send-${guestInvitationId}-confirm`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  return (
    <div className="w-full space-y-3">
      {confirming && !emailBlocked ? (
        <form action={formAction} className="space-y-3 rounded-lg border border-border p-3">
          <input type="hidden" name="weddingId" value={weddingId} />
          <input type="hidden" name="guestInvitationId" value={guestInvitationId} />
          <div id={descriptionId} className="space-y-1 text-sm">
            <p className="font-semibold break-words">
              {interpolate(copy.invitationEmail.rotateSend.confirmTitle, { party: partyLabel })}
            </p>
            <p className="break-words">
              {interpolate(copy.invitationEmail.rotateSend.confirmBody, { email: contactEmail })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="submit"
              aria-describedby={descriptionId}
              className={smallButtonClass}
            >
              {copy.invitationEmail.rotateSend.confirmButton}
            </button>
            <button type="button" onClick={() => setConfirmingFor(null)} className={smallButtonClass}>
              {copy.invitationEmail.rotateSend.cancel}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingFor(currentNonce)}
          disabled={emailBlocked}
          className={smallButtonClass}
        >
          {copy.invitationEmail.rotateSend.open}
        </button>
      )}
      {state ? (
        <div key={state.nonce} className="space-y-3" data-testid="invitation-email-result">
          <Notice tone={state.tone}>{state.message}</Notice>
          {state.link && state.canRetry ? (
            <FreshLinkPanel
              weddingId={weddingId}
              fresh={state.link}
              partyLabel={partyLabel}
              id={`guest-link-send-${guestInvitationId}`}
              status={copy.link.created}
              canSend
              emailBlocked={emailBlocked}
            />
          ) : null}
          {state.link && !state.canRetry ? (
            <CopyLink
              url={state.link.link}
              label={interpolate(copy.link.copyLabel, { party: partyLabel })}
              id={`guest-link-send-${guestInvitationId}`}
              testId="guest-link"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
