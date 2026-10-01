"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { revokeInviteAction, type RevokeInviteState } from "./actions";

export function RevokeInviteButton({
  weddingId,
  inviteId,
  describedBy,
}: {
  weddingId: string;
  inviteId: string;
  /** Id of the element describing the invite, for screen-reader context. */
  describedBy: string;
}) {
  const [state, formAction] = useActionState<RevokeInviteState, FormData>(
    revokeInviteAction,
    null,
  );
  const { invites } = getMessages();

  return (
    <form action={formAction} className="space-y-2" aria-describedby={describedBy}>
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <SubmitButton
        label={invites.revoke}
        pendingLabel={invites.revoking}
        variant="secondary"
        className="min-h-9 px-3 py-1.5"
      />
      {state && !state.ok ? (
        <p role="alert" className="text-danger text-sm">
          {state.formError}
        </p>
      ) : null}
    </form>
  );
}
