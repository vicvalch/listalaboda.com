"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";

import { removeMemberAction, type RemoveMemberState } from "./actions";

const smallButtonClass = `${secondaryButtonClass} min-h-9 px-3 py-1.5`;

type Props = {
  weddingId: string;
  /** Lookup key only: the server re-derives the caller and their role. */
  membershipId: string;
  /** The member's safe label ("Sofía", "Persona colaboradora"). */
  label: string;
  /** Removing another owner is legal, but worth saying out loud. */
  isOwner: boolean;
};

/**
 * Owner-only "Quitar de la boda", in two steps: the button opens an inline
 * confirmation that says exactly what happens (access to this wedding only;
 * assigned items stay, unassigned; the account is not deleted), then
 * "Quitar" or "Cancelar". Hiding it from collaborators is cosmetic: the
 * action and the database re-check the owner role.
 */
export function RemoveMemberButton({ weddingId, membershipId, label, isOwner }: Props) {
  const [state, formAction] = useActionState<RemoveMemberState, FormData>(removeMemberAction, null);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = getMessages().members.remove;
  const confirmId = `remove-${membershipId}-confirm`;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={interpolate(copy.openFor, { name: label })}
        className={`${smallButtonClass} text-danger`}
      >
        {copy.open}
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-3">
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <div id={confirmId} className="space-y-1 text-sm">
        <p className="font-semibold">{interpolate(copy.confirmTitle, { name: label })}</p>
        <p>{copy.confirmBody}</p>
        {isOwner ? <p>{copy.confirmOwner}</p> : null}
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
          aria-describedby={confirmId}
          className={`${smallButtonClass} border-danger text-danger`}
        >
          {copy.confirmButton}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className={smallButtonClass}>
          {copy.cancel}
        </button>
      </div>
    </form>
  );
}
