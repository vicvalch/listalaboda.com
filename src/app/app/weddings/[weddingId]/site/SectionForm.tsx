"use client";

import { useActionState } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import {
  SECTION_BODY_MAX_LENGTH,
  SECTION_TITLE_MAX_LENGTH,
  type EditorSection,
} from "@/lib/wedding-site/sections";

import { saveSectionAction, type SectionFormState } from "./actions";

/**
 * One website section: optional title, plain-text body and "Mostrar en el
 * sitio". Any member may save it. Works without JavaScript; keeps what was
 * typed on errors and announces success in a status region. The form
 * carries only the wedding id and the section kind (lookup keys).
 */
export function SectionForm({ weddingId, section }: { weddingId: string; section: EditorSection }) {
  const [state, formAction] = useActionState<SectionFormState, FormData>(saveSectionAction, null);
  const failure = state && !state.ok ? state : null;
  const copy = getMessages().site;
  const id = `section-${section.kind}`;
  const bodyId = `${id}-body`;
  const bodyHintId = `${bodyId}-hint`;
  const bodyErrorId = `${bodyId}-error`;
  const bodyError = failure?.fieldErrors?.body;
  const visible = failure ? failure.values?.visible === "on" : section.isVisible;

  return (
    <article
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      data-testid="site-section"
      data-kind={section.kind}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-title`} className="text-xl font-semibold">
          {copy.kinds[section.kind]}
        </h3>
        <p className="text-muted text-sm font-semibold" data-testid="site-section-visibility">
          {section.isVisible ? copy.sections.shown : copy.sections.hidden}
        </p>
      </header>
      {section.kind === "rsvp" ? (
        <p className="text-muted text-sm">
          {interpolate(copy.sections.rsvpHint, { text: getMessages().publicSite.rsvpDefault })}
        </p>
      ) : null}

      {/* Remount after success so the fields show the saved values. */}
      <form key={state?.ok ? state.data.nonce : id} action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="weddingId" value={weddingId} />
        <input type="hidden" name="kind" value={section.kind} />
        {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
        <FormField
          id={`${id}-title-input`}
          name="title"
          type="text"
          label={copy.sections.titleLabel}
          hint={interpolate(copy.sections.titleHint, { title: copy.defaultTitles[section.kind] })}
          maxLength={SECTION_TITLE_MAX_LENGTH}
          autoComplete="off"
          defaultValue={failure?.values?.title ?? section.title ?? ""}
          error={failure?.fieldErrors?.title}
        />
        <div className="space-y-1.5">
          <label htmlFor={bodyId} className="block text-sm font-semibold">
            {copy.sections.bodyLabel}
          </label>
          <textarea
            id={bodyId}
            name="body"
            rows={5}
            maxLength={SECTION_BODY_MAX_LENGTH}
            defaultValue={failure?.values?.body ?? section.body ?? ""}
            aria-invalid={bodyError ? true : undefined}
            aria-describedby={[bodyHintId, bodyError ? bodyErrorId : null].filter(Boolean).join(" ")}
            className={`${inputClass} min-h-32 leading-relaxed`}
          />
          <p id={bodyHintId} className="text-muted text-sm">
            {copy.sections.bodyHint}
          </p>
          {bodyError ? (
            <p id={bodyErrorId} className="text-danger text-sm font-medium">
              {bodyError}
            </p>
          ) : null}
        </div>
        <label className="flex min-h-11 items-center gap-3 font-semibold">
          <input
            type="checkbox"
            name="visible"
            defaultChecked={visible}
            className="h-5 w-5 accent-[var(--accent)]"
          />
          {copy.sections.visibleLabel}
        </label>
        <SubmitButton label={copy.sections.submit} pendingLabel={copy.sections.submitting} variant="secondary" />
      </form>
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok ? state.data.message : null}
      </p>
    </article>
  );
}
