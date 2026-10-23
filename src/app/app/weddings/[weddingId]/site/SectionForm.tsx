"use client";

import { useActionState, type ReactNode } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inputClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import {
  SECTION_BODY_MAX_LENGTH,
  SECTION_TITLE_MAX_LENGTH,
  sectionTitle,
  type EditorSection,
} from "@/lib/wedding-site/sections";

import { saveSectionAction, type SectionFormState } from "./actions";
import { Disclosure } from "./Disclosure";

/**
 * One text section as a row of "Secciones del sitio" (UX-01D): its name, a
 * clear Visible/Oculta state and its quick switch (`toggle`, rendered by the
 * page), and the editor behind "Editar": optional title, plain-text body and
 * "Mostrar en el sitio". Any member may save it. Works without JavaScript;
 * keeps what was typed on errors and announces success in a status region.
 * The form carries only the wedding id and the section kind (lookup keys).
 */
export function SectionForm({
  weddingId,
  section,
  toggle,
}: {
  weddingId: string;
  section: EditorSection;
  toggle?: ReactNode;
}) {
  const [state, formAction] = useActionState<SectionFormState, FormData>(saveSectionAction, null);
  const failure = state && !state.ok ? state : null;
  const copy = getMessages().site;
  const id = `section-${section.kind}`;
  const bodyId = `${id}-body`;
  const bodyHintId = `${bodyId}-hint`;
  const bodyErrorId = `${bodyId}-error`;
  const bodyError = failure?.fieldErrors?.body;
  const visible = failure ? failure.values?.visible === "on" : section.isVisible;
  const name = sectionTitle(section.kind, section.title);

  return (
    <article
      id={`seccion-${section.kind}`}
      aria-labelledby={`${id}-title`}
      className={`space-y-3 rounded-2xl border bg-surface p-4 shadow-sm sm:p-5 ${section.isVisible ? "border-border" : "border-dashed border-border"}`}
      data-testid="site-section"
      data-kind={section.kind}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-muted text-xs font-semibold tracking-wide uppercase">
            {copy.sections.textKind} · {copy.kinds[section.kind]}
          </p>
          <h3 id={`${id}-title`} className="text-lg font-semibold break-words">
            {name}
          </h3>
        </div>
        <VisibilityBadge visible={section.isVisible} testId="site-section-visibility" />
      </header>
      {section.body ? (
        <p className="text-muted line-clamp-2 text-sm break-words whitespace-pre-line">{section.body}</p>
      ) : section.kind === "rsvp" ? null : (
        <p className="text-muted text-sm">{copy.sections.empty}</p>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <Disclosure
          summary={copy.sections.edit}
          summaryLabel={interpolate(copy.sections.editLabel, { name })}
          testId="site-section-editor"
        >
          {section.kind === "rsvp" ? (
            <p className="text-muted mb-4 text-sm">
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
        </Disclosure>
        {toggle}
      </div>
      <p role="status" className="text-success min-h-5 text-sm font-medium empty:min-h-0">
        {state?.ok ? state.data.message : null}
      </p>
    </article>
  );
}

/** "Visible" / "Oculta" in words and shape (filled vs dashed), never color alone. */
export function VisibilityBadge({ visible, testId }: { visible: boolean; testId?: string }) {
  const copy = getMessages().site.sections;
  return (
    <p
      className={`shrink-0 rounded-full border px-3 py-0.5 text-xs font-semibold ${
        visible ? "border-success/40 bg-success-soft text-success" : "text-muted border-dashed border-border"
      }`}
      data-testid={testId}
    >
      {visible ? copy.shown : copy.hidden}
    </p>
  );
}
