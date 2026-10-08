"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass, secondaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import {
  DEFAULT_TABLE_SHAPE,
  TABLE_CAPACITY_MAX,
  TABLE_CAPACITY_MIN,
  TABLE_NAME_MAX_LENGTH,
  TABLE_SHAPES,
  type TableShape,
} from "@/lib/seating/validation";

import type { TableFormState } from "./actions";

const summaryClass = `${secondaryButtonClass} min-h-9 cursor-pointer list-none px-3 py-1.5 [&::-webkit-details-marker]:hidden`;

type Props = {
  /** Server Action: create or update a table. */
  action: (prev: TableFormState, formData: FormData) => Promise<TableFormState>;
  weddingId: string;
  /** Set when editing; the server re-derives authority and the wedding. */
  tableId?: string;
  /** Unique per page; prefixes the field ids. */
  id: string;
  defaultName?: string;
  defaultCapacity?: number;
  /** LB-20: visual only; a new table is round unless chosen otherwise. */
  defaultShape?: TableShape;
  submitLabel: string;
  pendingLabel: string;
  /** When set, the form sits behind a disclosure ("Editar"). */
  disclosure?: Readonly<{ label: string; ariaLabel: string }>;
  /** Stack the fields (the planner's narrow inspector). */
  compact?: boolean;
};

/**
 * A table's name, capacity and shape ("Crear mesa", "Editar"). Works without
 * JavaScript, keeps typed values on errors (including the capacity-below-
 * assigned refusal) and announces success in a status region. The shape
 * (LB-20) is visual only: it never changes capacity, seats or position.
 */
export function TableForm({
  action,
  weddingId,
  tableId,
  id,
  defaultName = "",
  defaultCapacity,
  defaultShape = DEFAULT_TABLE_SHAPE,
  submitLabel,
  pendingLabel,
  disclosure,
  compact = false,
}: Props) {
  const [state, formAction] = useActionState<TableFormState, FormData>(action, null);
  const messages = getMessages().seating;
  const copy = messages.newTable;
  const failure = state && !state.ok ? state : null;
  const shapeError = failure?.fieldErrors?.shape;
  const shapeErrorId = `${id}-shape-error`;

  const form = (
    <div className="space-y-2">
      {/* Remount after success: a cleared "create" form, a fresh "edit" value. */}
      <form key={state?.ok ? state.data.nonce : id} action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="weddingId" value={weddingId} />
        {tableId ? <input type="hidden" name="tableId" value={tableId} /> : null}
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <div className={compact ? "grid gap-4" : "grid gap-4 sm:grid-cols-[1fr_10rem_10rem]"}>
          <FormField
            id={`${id}-name`}
            name="name"
            type="text"
            label={copy.nameLabel}
            placeholder={tableId ? undefined : copy.namePlaceholder}
            maxLength={TABLE_NAME_MAX_LENGTH}
            autoComplete="off"
            defaultValue={failure?.values?.name ?? defaultName}
            error={failure?.fieldErrors?.name}
          />
          <FormField
            id={`${id}-capacity`}
            name="capacity"
            type="number"
            inputMode="numeric"
            min={TABLE_CAPACITY_MIN}
            max={TABLE_CAPACITY_MAX}
            step={1}
            label={copy.capacityLabel}
            hint={copy.capacityHint}
            defaultValue={failure?.values?.capacity ?? (defaultCapacity === undefined ? "" : String(defaultCapacity))}
            error={failure?.fieldErrors?.capacity}
          />
          <div className="space-y-1.5">
            <label htmlFor={`${id}-shape`} className="block text-sm font-semibold">
              {copy.shapeLabel}
            </label>
            <select
              id={`${id}-shape`}
              name="shape"
              defaultValue={failure?.values?.shape || defaultShape}
              className={inputClass}
              aria-invalid={shapeError ? true : undefined}
              aria-describedby={shapeError ? shapeErrorId : undefined}
            >
              {TABLE_SHAPES.map((shape) => (
                <option key={shape} value={shape}>
                  {messages.shapes[shape]}
                </option>
              ))}
            </select>
            {shapeError ? (
              <p id={shapeErrorId} className="text-danger text-sm font-medium">
                {shapeError}
              </p>
            ) : null}
          </div>
        </div>
        <SubmitButton
          label={submitLabel}
          pendingLabel={pendingLabel}
          variant={disclosure ? "secondary" : "primary"}
        />
      </form>
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );

  if (!disclosure) return form;

  return (
    <details className="group w-full">
      <summary className={summaryClass} aria-label={disclosure.ariaLabel}>
        {disclosure.label}
      </summary>
      <div className="mt-3 rounded-lg border border-border p-3">{form}</div>
    </details>
  );
}
