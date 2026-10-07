"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages, interpolate } from "@/lib/i18n";

import { CopyLink } from "../CopyLink";
import { sendInvitationAction, type FreshLinkData, type SendInvitationState } from "./actions";

type Props = {
  weddingId: string;
  fresh: FreshLinkData;
  partyLabel: string;
  /** Unique per page; the link field's id. */
  id: string;
  /** Status line shown above the link. */
  status: string;
  /** Offer "Enviar invitación por correo" with this link. */
  canSend: boolean;
  /**
   * LB-18.3: the party's current address bounced, was suppressed or
   * complained: the email button is disabled (copying the link isn't). The
   * server refuses the send anyway.
   */
  emailBlocked?: boolean;
};

/**
 * A link that was just created or replaced: copy it (manual sharing always
 * works) and, optionally, email it to the party's contact address. The
 * token lives only in this component's props and the send form's body;
 * nothing is stored in the browser. After a reload it is gone for good.
 */
export function FreshLinkPanel({ weddingId, fresh, partyLabel, id, status, canSend, emailBlocked = false }: Props) {
  const copy = getMessages().guests;
  return (
    <div className="space-y-3 rounded-xl border border-success/40 bg-success-soft p-4">
      <p role="status" className="text-success text-sm font-semibold">
        {status}
      </p>
      <CopyLink
        url={fresh.link}
        label={interpolate(copy.link.copyLabel, { party: partyLabel })}
        id={id}
        testId="guest-link"
      />
      {canSend ? <SendInvitationForm weddingId={weddingId} fresh={fresh} emailBlocked={emailBlocked} /> : null}
    </div>
  );
}

function SendInvitationForm({
  weddingId,
  fresh,
  emailBlocked,
}: {
  weddingId: string;
  fresh: FreshLinkData;
  emailBlocked: boolean;
}) {
  const [state, formAction] = useActionState<SendInvitationState, FormData>(sendInvitationAction, null);
  const copy = getMessages().guests.invitationEmail;

  return (
    <form action={formAction} className="space-y-2 border-t border-success/30 pt-3">
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="guestInvitationId" value={fresh.guestInvitationId} />
      <input type="hidden" name="token" value={fresh.token} />
      <p className="text-muted text-sm">{copy.sendFreshHint}</p>
      <SubmitButton label={copy.sendFresh} pendingLabel={copy.sending} variant="secondary" disabled={emailBlocked} />
      {state ? (
        <div key={state.nonce} data-testid="invitation-email-result">
          <Notice tone={state.tone}>{state.message}</Notice>
        </div>
      ) : null}
    </form>
  );
}
