"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { CONTACT_EMAIL_MAX_LENGTH } from "@/lib/guests/contact-email";
import { PARTY_LABEL_MAX_LENGTH } from "@/lib/guests/validation";
import { getMessages, interpolate } from "@/lib/i18n";

import { createPartyAction, type CreatePartyState } from "./actions";
import { FreshLinkPanel } from "./FreshLinkPanel";

/**
 * "Nuevo grupo": the party's name, its first guests (one per line) and an
 * optional contact email in one step — a party is never created empty. On
 * success the party's link is shown once, to copy and share, and it can be
 * emailed to the contact address from there. Creating never sends anything
 * by itself.
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
        <FormField
          id="new-party-email"
          name="contactEmail"
          type="email"
          label={copy.newParty.emailLabel}
          hint={copy.newParty.emailHint}
          maxLength={CONTACT_EMAIL_MAX_LENGTH}
          autoComplete="off"
          defaultValue={failure?.values?.contactEmail}
          error={failure?.fieldErrors?.contactEmail}
        />
        <SubmitButton label={copy.newParty.submit} pendingLabel={copy.newParty.submitting} />
      </form>
      {state?.ok ? (
        <FreshLinkPanel
          key={state.data.nonce}
          weddingId={weddingId}
          fresh={state.data}
          partyLabel={state.data.label}
          id="new-party-link"
          status={`${interpolate(copy.newParty.created, { party: state.data.label })} ${copy.link.created}`}
          canSend
        />
      ) : null}
    </div>
  );
}
