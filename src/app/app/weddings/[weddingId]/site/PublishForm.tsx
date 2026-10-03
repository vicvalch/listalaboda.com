"use client";

import { useActionState } from "react";

import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { getMessages } from "@/lib/i18n";

import { publishSiteAction, type PublicationState } from "./actions";

/**
 * Owner-only "Publicar sitio". Explicit: nothing is public before this POST.
 * The server re-checks the owner role and that there is an address and
 * something visible to show.
 */
export function PublishForm({ weddingId }: { weddingId: string }) {
  const [state, formAction] = useActionState<PublicationState, FormData>(publishSiteAction, null);
  const copy = getMessages().site.publish;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="weddingId" value={weddingId} />
      {state && !state.ok ? <Notice tone="error">{state.formError}</Notice> : null}
      <p className="text-muted text-sm">{copy.hint}</p>
      <SubmitButton label={copy.submit} pendingLabel={copy.submitting} className="w-full sm:w-auto" />
    </form>
  );
}
