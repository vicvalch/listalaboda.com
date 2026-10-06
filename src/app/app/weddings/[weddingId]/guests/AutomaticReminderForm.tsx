"use client";

import { useActionState, useState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { AUTOMATIC_REMINDER_DAYS_BEFORE } from "@/lib/scheduler/timing";

import { saveAutomaticReminderPolicyAction, type AutomaticReminderPolicyState } from "./actions";

type Props = {
  weddingId: string;
  enabled: boolean;
  daysBefore: number;
  /**
   * Per option (14/21/30): the formatted send date, or null when that date is
   * already in the past (turning it on now would send nothing). Computed on
   * the server from the wedding's date and time zone.
   */
  previewDates: Readonly<Record<string, string | null>>;
};

/**
 * Owner-only control for the wedding's automatic RSVP reminder (LB-17,
 * ADR-010 §5). Cosmetic gate: the server action and the database both
 * re-check the owner role. Shows, before saving, when the reminder would go
 * out for the selected option.
 */
export function AutomaticReminderForm({ weddingId, enabled, daysBefore, previewDates }: Props) {
  const copy = getMessages().guests.automaticReminders;
  const [state, formAction] = useActionState<AutomaticReminderPolicyState, FormData>(
    saveAutomaticReminderPolicyAction,
    null,
  );
  const [selected, setSelected] = useState(String(daysBefore));
  const preview = previewDates[selected] ?? null;

  return (
    <form action={formAction} className="space-y-3" data-testid="automatic-reminder-form">
      <input type="hidden" name="weddingId" value={weddingId} />
      {state ? (
        <Notice key={state.nonce} tone={state.ok ? "success" : "error"}>
          {state.message}
        </Notice>
      ) : null}
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="h-4 w-4" />
        {copy.enabledLabel}
      </label>
      <div className="space-y-1">
        <label htmlFor={`automatic-reminder-days-${weddingId}`} className="block text-sm font-semibold">
          {copy.daysLabel}
        </label>
        <select
          id={`automatic-reminder-days-${weddingId}`}
          name="daysBefore"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className={`${inputClass} max-w-xs`}
        >
          {AUTOMATIC_REMINDER_DAYS_BEFORE.map((days) => (
            <option key={days} value={String(days)}>
              {interpolate(copy.daysOption, { days: String(days) })}
            </option>
          ))}
        </select>
      </div>
      <p className="text-muted text-sm" data-testid="automatic-reminder-preview-date">
        {preview ? interpolate(copy.previewDate, { date: preview }) : copy.previewPassed}
      </p>
      <SubmitButton label={copy.submit} pendingLabel={copy.submitting} variant="secondary" />
    </form>
  );
}
