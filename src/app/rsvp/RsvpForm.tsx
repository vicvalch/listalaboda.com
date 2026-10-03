"use client";

import { useActionState, useEffect, useRef } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { DIETARY_NOTE_MAX_LENGTH } from "@/lib/rsvp/validation";

import { submitRsvpAction, type RsvpFormState } from "./actions";

type Guest = Readonly<{
  id: string;
  name: string;
  attending: boolean | null;
  dietaryNote: string | null;
}>;

const choiceClass =
  "flex min-h-11 flex-1 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 font-semibold has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent";

/**
 * The party's RSVP: one group per guest (fieldset + legend with the guest's
 * name), an explicit "Sí, asistirá" / "No asistirá" choice and an optional
 * food note. Every guest must be answered; nothing is preselected for a
 * guest without an answer, so "Sin responder" never silently becomes "No".
 * Existing answers are prefilled. The token is not in the form (it travels
 * in the httpOnly cookie); guest ids are only references.
 */
export function RsvpForm({ guests }: { guests: readonly Guest[] }) {
  const [state, formAction] = useActionState<RsvpFormState, FormData>(submitRsvpAction, null);
  const copy = getMessages().rsvp;
  const errorRef = useRef<HTMLDivElement>(null);
  const answeredBefore = guests.every((guest) => guest.attending !== null);

  // Move focus to the error summary so keyboard and screen-reader users
  // land on what needs fixing.
  useEffect(() => {
    if (state?.formError) errorRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state?.formError ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
        >
          {state.formError}
        </div>
      ) : null}
      {guests.map((guest) => {
        const value = state?.values[guest.id];
        const error = state?.fieldErrors[guest.id];
        const errorId = `rsvp-${guest.id}-error`;
        const noteId = `rsvp-${guest.id}-note`;
        const noteHintId = `${noteId}-hint`;
        const attending =
          value?.attending ?? (guest.attending === null ? "" : guest.attending ? "yes" : "no");
        return (
          <fieldset
            key={guest.id}
            className="space-y-3 rounded-xl border border-border p-4"
            aria-describedby={error ? errorId : undefined}
            data-testid="rsvp-guest"
          >
            <legend className="px-1 text-lg font-semibold break-words">{guest.name}</legend>
            <input type="hidden" name="guestId" value={guest.id} />
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className={choiceClass}>
                <input
                  type="radio"
                  name={`attending-${guest.id}`}
                  value="yes"
                  defaultChecked={attending === "yes"}
                  className="h-5 w-5 accent-[var(--accent)]"
                />
                {copy.yes}
              </label>
              <label className={choiceClass}>
                <input
                  type="radio"
                  name={`attending-${guest.id}`}
                  value="no"
                  defaultChecked={attending === "no"}
                  className="h-5 w-5 accent-[var(--accent)]"
                />
                {copy.no}
              </label>
            </div>
            {error ? (
              <p id={errorId} className="text-danger text-sm font-medium">
                {error}
              </p>
            ) : null}
            <div className="space-y-1.5">
              <label htmlFor={noteId} className="block text-sm font-semibold">
                {copy.dietaryLabel}
              </label>
              <input
                id={noteId}
                name={`dietaryNote-${guest.id}`}
                type="text"
                maxLength={DIETARY_NOTE_MAX_LENGTH}
                autoComplete="off"
                defaultValue={value?.dietaryNote ?? guest.dietaryNote ?? ""}
                aria-describedby={noteHintId}
                className={inputClass}
              />
              <p id={noteHintId} className="text-muted text-sm">
                {copy.dietaryHint}
              </p>
            </div>
          </fieldset>
        );
      })}
      <SubmitButton
        label={answeredBefore ? copy.submitChanges : copy.submit}
        pendingLabel={copy.submitting}
        className="w-full sm:w-auto"
      />
    </form>
  );
}
