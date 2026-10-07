"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";

import { rotateLinkAction, type RotateLinkState } from "./actions";
import { FreshLinkPanel } from "./FreshLinkPanel";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  weddingId: string;
  /** Lookup key only. */
  guestInvitationId: string;
  partyLabel: string;
  /** LB-18.3: the new link can be copied, but not emailed to a blocked address. */
  emailBlocked?: boolean;
};

/**
 * "Generar nuevo enlace": confirms that the new link replaces the old one,
 * then shows the new link once, to copy. After a reload only the link's
 * state is shown: the plaintext is never stored, so it can't be shown again.
 */
export function RotateLinkButton({ weddingId, guestInvitationId, partyLabel, emailBlocked = false }: Props) {
  const [state, formAction] = useActionState<RotateLinkState, FormData>(rotateLinkAction, null);
  const created = state?.ok ? state.data : null;
  // The confirmation belongs to the link shown when it was opened: once a
  // new link arrives (a new nonce), it closes by itself.
  const currentNonce = created?.nonce ?? "none";
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const confirming = confirmingFor === currentNonce;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = getMessages().guests;
  const descriptionId = `rotate-${guestInvitationId}-confirm`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  return (
    <div className="w-full space-y-3">
      {confirming ? (
        <form action={formAction} className="space-y-3 rounded-lg border border-border p-3">
          <input type="hidden" name="weddingId" value={weddingId} />
          <input type="hidden" name="guestInvitationId" value={guestInvitationId} />
          <div id={descriptionId} className="space-y-1 text-sm">
            <p className="font-semibold break-words">
              {interpolate(copy.rotate.confirmTitle, { party: partyLabel })}
            </p>
            <p>{copy.rotate.confirmBody}</p>
          </div>
          {state && !state.ok ? (
            <p role="alert" className="text-danger text-sm">
              {state.formError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="submit"
              aria-describedby={descriptionId}
              className={smallButtonClass}
            >
              {copy.rotate.confirmButton}
            </button>
            <button type="button" onClick={() => setConfirmingFor(null)} className={smallButtonClass}>
              {copy.rotate.cancel}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setConfirmingFor(currentNonce)} className={smallButtonClass}>
          {copy.rotate.open}
        </button>
      )}
      {created ? (
        <FreshLinkPanel
          key={created.nonce}
          weddingId={weddingId}
          fresh={created}
          partyLabel={partyLabel}
          id={`guest-link-${guestInvitationId}`}
          status={copy.link.created}
          canSend
          emailBlocked={emailBlocked}
        />
      ) : null}
    </div>
  );
}
