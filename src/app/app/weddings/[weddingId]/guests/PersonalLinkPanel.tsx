"use client";

import { useActionState, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";

import { CopyLink } from "../CopyLink";
import { recoverLinkAction, type RecoverLinkState } from "./actions";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  weddingId: string;
  /** Lookup key only. */
  guestInvitationId: string;
  partyLabel: string;
  /** Owner: may generate a new link. Cosmetic; the server re-checks. */
  canAdministerLink: boolean;
};

/**
 * "Enlace personal de RSVP" (LB-13): the party's CURRENT link, only after an
 * explicit "Mostrar enlace". The page never loads it; the link exists only
 * in this action's response and this component's state (never storage,
 * cookies or the URL), and "Ocultar" drops it. Copying needs no clipboard
 * permission: the field can always be selected by hand.
 */
export function PersonalLinkPanel({ weddingId, guestInvitationId, partyLabel, canAdministerLink }: Props) {
  const [state, formAction] = useActionState<RecoverLinkState, FormData>(recoverLinkAction, null);
  const [hiddenNonce, setHiddenNonce] = useState<string | null>(null);
  const copy = getMessages().guests.personalLink;
  const visible = state && state.nonce !== hiddenNonce ? state : null;

  return (
    <div className="space-y-2" data-testid="personal-link">
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-muted text-sm">{copy.hint}</p>
      {visible?.status === "shown" ? (
        <div className="space-y-2">
          <CopyLink
            url={visible.link}
            label={interpolate(copy.copyLabel, { party: partyLabel })}
            id={`personal-link-${guestInvitationId}`}
            testId="recovered-guest-link"
          />
          <button type="button" onClick={() => setHiddenNonce(visible.nonce)} className={smallButtonClass}>
            {copy.hide}
          </button>
        </div>
      ) : (
        <form action={formAction}>
          <input type="hidden" name="weddingId" value={weddingId} />
          <input type="hidden" name="guestInvitationId" value={guestInvitationId} />
          <SubmitButton label={copy.show} pendingLabel={copy.showing} variant="secondary" />
        </form>
      )}
      {visible && visible.status !== "shown" ? (
        <div key={visible.nonce} data-testid="personal-link-result">
          <Notice tone={visible.status === "failed" ? "error" : "info"}>
            {visible.message}
            {visible.status === "legacy" || visible.status === "unrecoverable"
              ? ` ${canAdministerLink ? copy.regenerateOwner : copy.regenerateCollaborator}`
              : null}
          </Notice>
        </div>
      ) : null}
    </div>
  );
}
