"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { PARTY_LABEL_MAX_LENGTH } from "@/lib/guests/validation";
import { getMessages, interpolate } from "@/lib/i18n";

import { CopyLink } from "../CopyLink";
import { createPartyAction, type CreatePartyState } from "./actions";

/**
 * "Nuevo grupo": the party's name and its first guests (one per line) in one
 * step — a party is never created empty. On success the party's link is
 * shown once, to copy and share.
 */
export function NewPartyForm({ weddingId }: { weddingId: string }) {
  const [state, formAction] = useActionState<CreatePartyState, FormData>(createPartyAction, null);
  const copy = getMessages().guests;
  const failure = state && !state.ok ? state : null;
  const namesError = failure?.fieldErrors?.guestNames;
  const namesHintId = "new-party-names-hint";
  const namesErrorId = "new-party-names-error";

  return (
    <div className="space-y-6">
      <form
        key={state?.ok ? state.data.nonce : "new-party"}
        action={formAction}
        className="space-y-5"
        noValidate
      >
        <input type="hidden" name="weddingId" value={weddingId} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <FormField
          id="new-party-label"
          name="label"
          type="text"
          label={copy.newParty.labelLabel}
          hint={copy.newParty.labelHint}
          maxLength={PARTY_LABEL_MAX_LENGTH}
          autoComplete="off"
          defaultValue={failure?.values?.label}
          error={failure?.fieldErrors?.label}
        />
        <div className="space-y-1.5">
          <label htmlFor="new-party-names" className="block text-sm font-semibold">
            {copy.newParty.namesLabel}
          </label>
          <textarea
            id="new-party-names"
            name="guestNames"
            rows={4}
            className={`${inputClass} min-h-28`}
            aria-invalid={namesError ? true : undefined}
            aria-describedby={[namesHintId, namesError ? namesErrorId : null].filter(Boolean).join(" ")}
            defaultValue={failure?.values?.guestNames}
          />
          <p id={namesHintId} className="text-muted text-sm">
            {copy.newParty.namesHint}
          </p>
          {namesError ? (
            <p id={namesErrorId} className="text-danger text-sm font-medium">
              {namesError}
            </p>
          ) : null}
        </div>
        <SubmitButton label={copy.newParty.submit} pendingLabel={copy.newParty.submitting} />
      </form>
      {state?.ok ? (
        <div className="space-y-3 rounded-xl border border-success/40 bg-success-soft p-4">
          <p role="status" className="text-success text-sm font-semibold">
            {interpolate(copy.newParty.created, { party: state.data.label })} {copy.link.created}
          </p>
          <CopyLink
            url={state.data.link}
            label={interpolate(copy.link.copyLabel, { party: state.data.label })}
            id="new-party-link"
            testId="guest-link"
          />
        </div>
      ) : null}
    </div>
  );
}
