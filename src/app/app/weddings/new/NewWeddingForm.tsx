"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { WEDDING_CITY_MAX_LENGTH } from "@/lib/weddings/validation";

import { TimeZoneField } from "../TimeZoneField";
import { createWeddingAction, type NewWeddingState } from "./actions";

/** Name (required), then optional date, city and time zone. */
export function NewWeddingForm({ timeZones }: { timeZones: readonly string[] }) {
  const [state, formAction] = useActionState<NewWeddingState, FormData>(createWeddingAction, null);
  const failure = state && !state.ok ? state : null;
  const { weddingNew } = getMessages();

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <FormField
        id="wedding-name"
        name="name"
        type="text"
        label={weddingNew.nameLabel}
        hint={weddingNew.nameHint}
        maxLength={200}
        autoComplete="off"
        required
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      <FormField
        id="wedding-date"
        name="weddingDate"
        type="date"
        label={weddingNew.dateLabel}
        hint={weddingNew.dateHint}
        defaultValue={failure?.values?.weddingDate}
        error={failure?.fieldErrors?.weddingDate}
      />
      <FormField
        id="wedding-city"
        name="city"
        type="text"
        label={weddingNew.cityLabel}
        hint={weddingNew.cityHint}
        maxLength={WEDDING_CITY_MAX_LENGTH}
        autoComplete="off"
        defaultValue={failure?.values?.city}
        error={failure?.fieldErrors?.city}
      />
      <TimeZoneField
        id="wedding-time-zone"
        options={timeZones}
        defaultValue={failure?.values?.timeZone ?? ""}
        error={failure?.fieldErrors?.timeZone}
      />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href="/app" className={secondaryButtonClass}>
          {weddingNew.cancel}
        </Link>
        <SubmitButton label={weddingNew.submit} pendingLabel={weddingNew.submitting} />
      </div>
    </form>
  );
}
