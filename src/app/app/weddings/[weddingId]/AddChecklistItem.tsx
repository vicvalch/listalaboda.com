"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { EMPTY_ITEM_FORM_VALUES } from "@/lib/checklist/validation";
import { getMessages } from "@/lib/i18n";

import { ChecklistItemFields } from "./ChecklistItemFields";
import { createChecklistItemAction, type ChecklistItemFormState } from "./checklist-actions";

/** "Agregar pendiente": a custom item, pending, placed at the end of the list. */
export function AddChecklistItem({ weddingId }: { weddingId: string }) {
  const [state, formAction] = useActionState<ChecklistItemFormState, FormData>(
    createChecklistItemAction,
    null,
  );
  const { checklist } = getMessages();
  const failure = state && !state.ok ? state : null;
  const defaults = { ...EMPTY_ITEM_FORM_VALUES, ...failure?.values };

  return (
    <section
      aria-labelledby="add-item-title"
      className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <h3 id="add-item-title" className="text-lg font-semibold">
        {checklist.form.addTitle}
      </h3>
      {/* A new key after each success remounts the form, clearing it. */}
      <form
        key={state?.ok ? state.data.nonce : "add-item"}
        action={formAction}
        className="space-y-4"
        noValidate
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <ChecklistItemFields
          idPrefix="new-item"
          defaults={defaults}
          fieldErrors={failure?.fieldErrors}
        />
        <SubmitButton label={checklist.form.submitAdd} pendingLabel={checklist.form.submittingAdd} />
      </form>
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </section>
  );
}
