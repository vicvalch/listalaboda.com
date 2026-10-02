"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";
import { DISPLAY_NAME_MAX_LENGTH } from "@/lib/weddings/validation";

import { updateDisplayNameAction, type DisplayNameState } from "./actions";

type Props = { weddingId: string; displayName: string | null };

/**
 * "Cómo apareces en esta boda": the current member's own name in this
 * wedding. There is no field saying whose name it is: the server only ever
 * changes the caller's own membership. Blank removes the name.
 */
export function DisplayNameForm({ weddingId, displayName }: Props) {
  const [state, formAction] = useActionState<DisplayNameState, FormData>(
    updateDisplayNameAction,
    null,
  );
  const failure = state && !state.ok ? state : null;
  const copy = getMessages().members.displayName;

  return (
    <div className="space-y-3">
      {/* Remount after a successful save so the field shows the saved value. */}
      <form
        key={state?.ok ? state.data.nonce : "display-name"}
        action={formAction}
        className="space-y-4"
        noValidate
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <FormField
          id="display-name"
          name="displayName"
          type="text"
          label={copy.label}
          hint={copy.hint}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          autoComplete="nickname"
          defaultValue={failure?.values?.displayName ?? displayName ?? ""}
          error={failure?.fieldErrors?.displayName}
        />
        <SubmitButton label={copy.submit} pendingLabel={copy.submitting} variant="secondary" />
      </form>
      <p role="status" className="text-success text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}
