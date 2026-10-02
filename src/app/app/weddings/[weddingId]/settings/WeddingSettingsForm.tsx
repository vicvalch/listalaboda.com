"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";
import { WEDDING_NAME_MAX_LENGTH } from "@/lib/weddings/validation";

import { updateWeddingSettingsAction, type WeddingSettingsState } from "./actions";

type Props = { weddingId: string; name: string; weddingDate: string | null };

/** Name and date. Leaving the date blank clears it. */
export function WeddingSettingsForm({ weddingId, name, weddingDate }: Props) {
  const [state, formAction] = useActionState<WeddingSettingsState, FormData>(
    updateWeddingSettingsAction,
    null,
  );
  const failure = state && !state.ok ? state : null;
  const { weddingSettings: copy } = getMessages();

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="weddingId" value={weddingId} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="settings-name"
        name="name"
        type="text"
        label={copy.nameLabel}
        maxLength={WEDDING_NAME_MAX_LENGTH}
        autoComplete="off"
        required
        defaultValue={failure?.values?.name ?? name}
        error={failure?.fieldErrors?.name}
      />
      <FormField
        id="settings-date"
        name="weddingDate"
        type="date"
        label={copy.dateLabel}
        hint={copy.dateHint}
        defaultValue={failure?.values?.weddingDate ?? weddingDate ?? ""}
        error={failure?.fieldErrors?.weddingDate}
      />
      <SubmitButton label={copy.submit} pendingLabel={copy.submitting} />
    </form>
  );
}
