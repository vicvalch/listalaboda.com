"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";

import { FormField } from "@/components/ui/FormField";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { secondaryButtonClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";
import { SLUG_MAX_LENGTH } from "@/lib/wedding-site/slug";

import { setSlugAction, type SlugFormState } from "./actions";

type Props = {
  weddingId: string;
  /** The saved address, or null. */
  currentSlug: string | null;
  /** Prefilled (not saved) suggestion when there is no address yet. */
  suggestion: string;
  isPublished: boolean;
  /** The visible prefix, e.g. "listalaboda.com/boda/". */
  prefix: string;
};

/**
 * Owner-only: chooses or changes the site's address. Hiding this form from
 * collaborators is cosmetic; the action and the database re-check. Changing
 * the address of a published site asks for confirmation first, because the
 * old address stops working (no redirects).
 */
export function SlugForm({ weddingId, currentSlug, suggestion, isPublished, prefix }: Props) {
  const [state, formAction] = useActionState<SlugFormState, FormData>(setSlugAction, null);
  const failure = state && !state.ok ? state : null;
  const copy = getMessages().site.slug;
  const [confirming, setConfirming] = useState(false);
  const confirmedRef = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const value = new FormData(event.currentTarget).get("slug");
    const changesPublishedAddress =
      isPublished && typeof value === "string" && value.trim() !== currentSlug;
    if (changesPublishedAddress && !confirmedRef.current) {
      event.preventDefault();
      setConfirming(true);
      return;
    }
    confirmedRef.current = false;
    setConfirming(false);
  }

  return (
    <form
      key={state?.ok ? state.data.nonce : "slug"}
      action={formAction}
      onSubmit={onSubmit}
      className="space-y-3"
      noValidate
    >
      <input type="hidden" name="weddingId" value={weddingId} />
      {failure?.formError ? <Notice tone="error">{failure.formError}</Notice> : null}
      <p className="text-muted text-sm break-all" aria-hidden="true">
        {prefix}
      </p>
      <FormField
        id="site-slug"
        name="slug"
        type="text"
        label={copy.label}
        hint={currentSlug ? copy.hint : `${copy.hint} ${suggestion ? copy.suggestion : ""}`.trim()}
        maxLength={SLUG_MAX_LENGTH}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        defaultValue={failure?.values?.slug ?? currentSlug ?? suggestion}
        error={failure?.fieldErrors?.slug}
      />
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-danger/40 bg-danger-soft p-3" id="slug-change-warning">
          <div className="space-y-1 text-sm">
            <p className="font-semibold">{copy.changeTitle}</p>
            <p>{copy.changeBody}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="submit"
              aria-describedby="slug-change-warning"
              onClick={() => {
                confirmedRef.current = true;
              }}
              className={`${secondaryButtonClass} min-h-9 border-danger px-3 py-1.5 text-danger`}
            >
              {copy.changeConfirm}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}
            >
              {copy.cancel}
            </button>
          </div>
        </div>
      ) : (
        <SubmitButton label={copy.submit} pendingLabel={copy.submitting} variant="secondary" />
      )}
      <p role="status" className="text-success min-h-5 text-sm font-medium">
        {state?.ok && !confirming ? state.data.message : null}
      </p>
    </form>
  );
}
