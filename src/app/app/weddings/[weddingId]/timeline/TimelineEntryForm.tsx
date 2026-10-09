"use client";

import { useActionState, type ReactNode } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { TIMELINE_PHASES } from "@/lib/timeline/presentation";
import {
  TIMELINE_DURATION_MAX_HOURS,
  TIMELINE_LOCATION_MAX_LENGTH,
  TIMELINE_NOTES_MAX_LENGTH,
  TIMELINE_RESPONSIBLE_MAX_LENGTH,
  TIMELINE_TITLE_MAX_LENGTH,
  type TimelineField,
  type TimelineFormValues,
} from "@/lib/timeline/validation";

import type { TimelineFormState } from "./actions";

type Submitted = Readonly<{ state: TimelineFormState; submission: number }>;

export type VendorChoice = Readonly<{ id: string; label: string }>;

type Props = {
  /** Server Action: create or update an entry. */
  action: (prev: TimelineFormState, formData: FormData) => Promise<TimelineFormState>;
  weddingId: string;
  /** Set when editing; the server re-derives authority and the wedding. */
  entryId?: string;
  /** Unique per page; prefixes the field ids. */
  id: string;
  /** Starting values: the stored entry (edit) or blanks (create). */
  defaults: TimelineFormValues;
  /** The wedding's vendors, already labelled (name and category only). */
  vendors: readonly VendorChoice[];
  submitLabel: string;
  pendingLabel: string;
};

/**
 * Every timeline field in one form, shared by "Agregar actividad" and each
 * entry's "Editar" (one coherent write). Works without JavaScript, keeps
 * typed values on errors, wires each error to its field (aria-describedby)
 * and announces success in a status region. The day is chosen explicitly:
 * a time after midnight is never moved to the next day by guessing.
 */
export function TimelineEntryForm({
  action,
  weddingId,
  entryId,
  id,
  defaults,
  vendors,
  submitLabel,
  pendingLabel,
}: Props) {
  // Every completed submission is numbered, so the fields remount with the
  // right values (React resets a form after its action; a <select> would
  // otherwise snap back to its first option on an error).
  const [{ state, submission }, formAction] = useActionState<Submitted, FormData>(
    async (previous, formData) => ({ state: await action(previous.state, formData), submission: previous.submission + 1 }),
    { state: null, submission: 0 },
  );
  const failure = state && !state.ok ? state : null;
  const values: TimelineFormValues = { ...defaults, ...failure?.values };

  return (
    <div className="space-y-2">
      <TimelineFields
        key={`${id}-${submission}`}
        formAction={formAction}
        weddingId={weddingId}
        entryId={entryId}
        id={id}
        values={values}
        vendors={vendors}
        errors={failure?.fieldErrors ?? {}}
        formError={failure?.formError}
        submit={<SubmitButton label={submitLabel} pendingLabel={pendingLabel} />}
      />
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </div>
  );
}

function TimelineFields({
  formAction,
  weddingId,
  entryId,
  id,
  values,
  vendors,
  errors,
  formError,
  submit,
}: {
  formAction: (formData: FormData) => void;
  weddingId: string;
  entryId?: string;
  id: string;
  values: TimelineFormValues;
  vendors: readonly VendorChoice[];
  errors: Partial<Record<TimelineField, string>>;
  formError?: string;
  submit: ReactNode;
}) {
  const copy = getMessages().timeline;
  const fields = copy.fields;
  const fieldId = (field: TimelineField) => `${id}-${field}`;
  const durationId = fieldId("duration");
  const durationDescribedBy = [`${durationId}-hint`, errors.duration ? `${durationId}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="weddingId" value={weddingId} />
      {entryId ? <input type="hidden" name="entryId" value={entryId} /> : null}
      {formError ? <Notice tone="error">{formError}</Notice> : null}

      <FormField
        id={fieldId("title")}
        name="title"
        type="text"
        label={fields.title}
        placeholder={entryId ? undefined : fields.titlePlaceholder}
        maxLength={TIMELINE_TITLE_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values.title}
        error={errors.title}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={fieldId("dayOffset")}
          name="dayOffset"
          label={fields.day}
          hint={fields.dayHint}
          defaultValue={values.dayOffset || "0"}
          error={errors.dayOffset}
          options={[
            { value: "0", label: copy.days.weddingDay },
            { value: "1", label: copy.days.nextDayOption },
          ]}
        />
        <FormField
          id={fieldId("startTime")}
          name="startTime"
          type="time"
          step={60}
          label={fields.startTime}
          hint={fields.startTimeHint}
          defaultValue={values.startTime}
          error={errors.startTime}
        />
      </div>

      <fieldset className="space-y-1.5" aria-describedby={durationDescribedBy}>
        <legend className="text-sm font-semibold">{fields.duration}</legend>
        <div className="grid grid-cols-2 gap-4 sm:max-w-xs">
          <SmallNumberField
            id={fieldId("durationHours")}
            name="durationHours"
            label={fields.durationHours}
            max={TIMELINE_DURATION_MAX_HOURS}
            defaultValue={values.durationHours}
            invalid={Boolean(errors.duration)}
            describedBy={durationDescribedBy}
          />
          <SmallNumberField
            id={fieldId("durationMinutes")}
            name="durationMinutes"
            label={fields.durationMinutes}
            max={59}
            defaultValue={values.durationMinutes}
            invalid={Boolean(errors.duration)}
            describedBy={durationDescribedBy}
          />
        </div>
        <FieldMessages id={durationId} hint={fields.durationHint} error={errors.duration} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={fieldId("phase")}
          name="phase"
          label={fields.phase}
          defaultValue={values.phase}
          error={errors.phase}
          options={[
            { value: "", label: fields.noPhase },
            ...TIMELINE_PHASES.map((value) => ({ value, label: copy.phases[value] })),
          ]}
        />
        <FormField
          id={fieldId("location")}
          name="location"
          type="text"
          label={fields.location}
          placeholder={entryId ? undefined : fields.locationPlaceholder}
          maxLength={TIMELINE_LOCATION_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.location}
          error={errors.location}
        />
        <FormField
          id={fieldId("responsibleName")}
          name="responsibleName"
          type="text"
          label={fields.responsible}
          hint={fields.responsibleHint}
          maxLength={TIMELINE_RESPONSIBLE_MAX_LENGTH}
          autoComplete="off"
          defaultValue={values.responsibleName}
          error={errors.responsibleName}
        />
        <SelectField
          id={fieldId("weddingVendorId")}
          name="weddingVendorId"
          label={fields.vendor}
          hint={fields.vendorHint}
          defaultValue={values.weddingVendorId}
          error={errors.weddingVendorId}
          options={[{ value: "", label: fields.noVendor }, ...vendors.map((v) => ({ value: v.id, label: v.label }))]}
        />
      </div>

      <TextareaField
        id={fieldId("notes")}
        name="notes"
        label={fields.notes}
        hint={fields.notesHint}
        maxLength={TIMELINE_NOTES_MAX_LENGTH}
        defaultValue={values.notes}
        error={errors.notes}
      />

      {submit}
    </form>
  );
}

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

function FieldMessages({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted text-sm">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-danger text-sm font-medium">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** One part of the duration (hours or minutes): whole numbers, typed as text. */
function SmallNumberField({
  id,
  name,
  label,
  max,
  defaultValue,
  invalid,
  describedBy: described,
}: {
  id: string;
  name: string;
  label: string;
  max: number;
  defaultValue: string;
  invalid: boolean;
  describedBy: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-muted block text-sm">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={String(max).length}
        autoComplete="off"
        defaultValue={defaultValue}
        className={inputClass}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={described}
      />
    </div>
  );
}

function SelectField({
  id,
  name,
  label,
  hint,
  error,
  options,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  options: readonly { value: string; label: string }[];
  defaultValue: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <select
        id={id}
        name={name}
        className={inputClass}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

function TextareaField({
  id,
  name,
  label,
  hint,
  error,
  maxLength,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  maxLength: number;
  defaultValue: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={3}
        maxLength={maxLength}
        defaultValue={defaultValue}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}
