"use client";

import { useState } from "react";

import { FormField } from "@/components/ui/FormField";
import { inputClass } from "@/components/ui/styles";
import { MAX_RELATIVE_DAYS } from "@/lib/checklist/timing";
import { CHECKLIST_CATEGORIES } from "@/lib/checklist/types";
import type { ChecklistItemField, ChecklistItemRawInput } from "@/lib/checklist/validation";
import { CHECKLIST_TITLE_MAX_LENGTH } from "@/lib/checklist/validation";
import { getMessages } from "@/lib/i18n";

const TIMING_MODES = ["none", "absolute", "relative_to_wedding"] as const;
const DIRECTIONS = ["before", "after", "on"] as const;

type Props = {
  /** Unique per form instance, so ids (and label/error wiring) never collide. */
  idPrefix: string;
  defaults: ChecklistItemRawInput;
  fieldErrors?: Partial<Record<ChecklistItemField, string>>;
  withDescription?: boolean;
};

/**
 * Title, category and timing fields shared by the add and edit forms. Users
 * pick "días antes/después de la boda"; the server maps that to the signed
 * relative_days, so nobody types "-30".
 */
export function ChecklistItemFields({ idPrefix, defaults, fieldErrors, withDescription }: Props) {
  const { checklist } = getMessages();
  const form = checklist.form;
  const [timingMode, setTimingMode] = useState(defaults.timingMode || "none");
  const [direction, setDirection] = useState(defaults.relativeDirection || "before");

  const errorId = (field: ChecklistItemField) =>
    fieldErrors?.[field] ? `${idPrefix}-${field}-error` : undefined;
  const fieldError = (field: ChecklistItemField) =>
    fieldErrors?.[field] ? (
      <p id={errorId(field)} className="text-danger text-sm font-medium">
        {fieldErrors[field]}
      </p>
    ) : null;

  const timingLabels = {
    none: form.timingNone,
    absolute: form.timingAbsolute,
    relative_to_wedding: form.timingRelative,
  } as const;

  return (
    <div className="space-y-4">
      <FormField
        id={`${idPrefix}-title`}
        name="title"
        label={form.titleLabel}
        hint={withDescription ? undefined : form.titleHint}
        required
        maxLength={CHECKLIST_TITLE_MAX_LENGTH}
        autoComplete="off"
        defaultValue={defaults.title}
        error={fieldErrors?.title}
      />

      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-category`} className="block text-sm font-semibold">
          {form.categoryLabel}
        </label>
        <select
          id={`${idPrefix}-category`}
          name="category"
          defaultValue={defaults.category}
          className={inputClass}
          aria-invalid={fieldErrors?.category ? true : undefined}
          aria-describedby={errorId("category")}
        >
          <option value="">{form.categoryNone}</option>
          {CHECKLIST_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {checklist.categories[category]}
            </option>
          ))}
        </select>
        {fieldError("category")}
      </div>

      {withDescription ? (
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-description`} className="block text-sm font-semibold">
            {form.descriptionLabel}
          </label>
          <textarea
            id={`${idPrefix}-description`}
            name="description"
            rows={3}
            defaultValue={defaults.description}
            className={inputClass}
            aria-invalid={fieldErrors?.description ? true : undefined}
            aria-describedby={errorId("description")}
          />
          {fieldError("description")}
        </div>
      ) : null}

      <fieldset className="space-y-3" aria-describedby={errorId("timingMode")}>
        <legend className="mb-1 text-sm font-semibold">{form.timingLegend}</legend>
        <div className="flex flex-wrap gap-2">
          {TIMING_MODES.map((mode) => (
            <label
              key={mode}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="timingMode"
                value={mode}
                checked={timingMode === mode}
                onChange={() => setTimingMode(mode)}
                className="accent-[var(--accent)]"
              />
              {timingLabels[mode]}
            </label>
          ))}
        </div>
        {fieldError("timingMode")}

        {timingMode === "absolute" ? (
          <FormField
            id={`${idPrefix}-due-date`}
            name="dueDate"
            type="date"
            label={form.dateLabel}
            required
            defaultValue={defaults.dueDate}
            error={fieldErrors?.dueDate}
          />
        ) : null}

        {timingMode === "relative_to_wedding" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={`${idPrefix}-direction`} className="block text-sm font-semibold">
                {form.directionLabel}
              </label>
              <select
                id={`${idPrefix}-direction`}
                name="relativeDirection"
                value={direction}
                onChange={(event) => setDirection(event.currentTarget.value)}
                className={inputClass}
                aria-invalid={fieldErrors?.relativeDirection ? true : undefined}
                aria-describedby={errorId("relativeDirection")}
              >
                {DIRECTIONS.map((value) => (
                  <option key={value} value={value}>
                    {form.direction[value]}
                  </option>
                ))}
              </select>
              {fieldError("relativeDirection")}
            </div>
            {direction !== "on" ? (
              <FormField
                id={`${idPrefix}-days`}
                name="relativeAmount"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_RELATIVE_DAYS}
                step={1}
                label={form.daysLabel}
                required
                defaultValue={defaults.relativeAmount}
                error={fieldErrors?.relativeAmount}
              />
            ) : null}
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
