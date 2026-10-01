"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { acceptInviteAction, type AcceptInviteState } from "./actions";

export function AcceptInviteForm() {
  const [state, formAction] = useActionState<AcceptInviteState, FormData>(
    acceptInviteAction,
    null,
  );
  const { inviteAccept } = getMessages();

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok && state.formError ? (
        <Notice tone="error">{state.formError}</Notice>
      ) : null}
      <SubmitButton
        label={inviteAccept.submit}
        pendingLabel={inviteAccept.submitting}
        className="w-full"
      />
    </form>
  );
}
