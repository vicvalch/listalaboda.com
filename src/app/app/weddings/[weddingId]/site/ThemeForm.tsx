"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Notice } from "@/components/ui/Notice";
import { primaryButtonClass } from "@/components/ui/styles";
import type { WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";

import { saveThemeAction, type ThemeFormState } from "./actions";

/**
 * The theme save form (ADR-019, CP5) around server-rendered theme cards:
 * each card's "Usar este estilo" is a submit button carrying its key, so the
 * page works without JavaScript and the browser sends only the wedding id
 * and that key. Success and errors are announced once, below the cards.
 */
export function ThemeForm({ weddingId, children }: { weddingId: string; children: ReactNode }) {
  const [state, formAction] = useActionState<ThemeFormState, FormData>(saveThemeAction, null);
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="weddingId" value={weddingId} />
      {children}
      {state && !state.ok ? <Notice tone="error">{state.formError}</Notice> : null}
      <p role="status" className="text-success min-h-5 text-sm font-medium" data-testid="site-theme-status">
        {state?.ok ? state.data.message : null}
      </p>
    </form>
  );
}

/**
 * One theme's "Usar este estilo". Only the clicked button shows progress;
 * all of them wait while a save is in flight. `name` completes the
 * accessible name ("Usar este estilo: Editorial"), since every card has one.
 */
export function ThemeSubmitButton({
  theme,
  label,
  pendingLabel,
  name,
}: {
  theme: WeddingSiteThemeKey;
  label: string;
  pendingLabel: string;
  name: string;
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("theme") === theme;
  return (
    <button
      type="submit"
      name="theme"
      value={theme}
      disabled={pending}
      // The visible words start the name (WCAG label in name).
      aria-label={mine ? pendingLabel : `${label}: ${name}`}
      className={`${primaryButtonClass} w-full sm:w-auto`}
    >
      <span aria-live="polite">{mine ? pendingLabel : label}</span>
    </button>
  );
}
