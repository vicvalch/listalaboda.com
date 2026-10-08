"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { inputClass, secondaryButtonClass } from "@/components/ui/styles";
import type { SeatingActionState } from "./actions";
import type { TableOption } from "./table-options";

type Props = {
  /** Server Action: seat, move or unseat. */
  action: (prev: SeatingActionState, formData: FormData) => Promise<SeatingActionState>;
  weddingId: string;
  guestId: string;
  /** Unique per page; prefixes the select id. */
  id: string;
  /** Destination tables (seat/move); omitted for "Quitar de mesa". */
  select?: Readonly<{ label: string; placeholder: string; options: readonly TableOption[] }>;
  submitLabel: string;
  submitAriaLabel: string;
};

/**
 * One seating action for one guest: pick a table and "Asignar"/"Mover", or
 * "Quitar de mesa". Full tables are disabled when the page knows they are
 * full; the database stays authoritative and its refusal is announced here.
 * Only lookup keys are posted (wedding, guest, table ids).
 */
export function AssignmentForm({ action, weddingId, guestId, id, select, submitLabel, submitAriaLabel }: Props) {
  const [state, formAction] = useActionState<SeatingActionState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errorId = `${id}-error`;

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" noValidate>
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="guestId" value={guestId} />
      {select ? (
        <div className="min-w-0 flex-1 basis-40">
          <label htmlFor={`${id}-table`} className="sr-only">
            {select.label}
          </label>
          <select
            id={`${id}-table`}
            name="tableId"
            defaultValue=""
            className={`${inputClass} min-h-9 py-1.5 text-sm`}
            aria-describedby={failure ? errorId : undefined}
          >
            <option value="" disabled>
              {select.placeholder}
            </option>
            {select.options.map((option) => (
              <option key={option.id} value={option.id} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Submit label={submitLabel} ariaLabel={submitAriaLabel} />
      {failure?.formError ? (
        <p id={errorId} role="alert" className="text-danger w-full text-sm font-medium">
          {failure.formError}
        </p>
      ) : null}
    </form>
  );
}

/** The visible verb ("Asignar") plus an accessible name that says who ("Asignar a Ana"). */
function Submit({ label, ariaLabel }: { label: string; ariaLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={ariaLabel}
      className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}
    >
      {label}
    </button>
  );
}
