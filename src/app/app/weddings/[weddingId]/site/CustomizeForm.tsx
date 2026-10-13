"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Notice } from "@/components/ui/Notice";
import { primaryButtonClass, secondaryButtonClass } from "@/components/ui/styles";
import type { WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";

import { saveCustomizationAction, type CustomizeFormState } from "./actions";

/**
 * The customization form (ADR-019, CP6) around server-rendered controls:
 * native radio groups (one per customizable field, the theme's options only)
 * and submit buttons whose `intent` says what to do (preview, save, reset).
 * Works without JavaScript; the browser sends the wedding id, the theme the
 * controls were drawn for, the chosen keys and the intent. Results are
 * announced once, below the controls.
 */
export function CustomizeForm({
  weddingId,
  theme,
  children,
}: {
  weddingId: string;
  theme: WeddingSiteThemeKey;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState<CustomizeFormState, FormData>(saveCustomizationAction, null);
  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="weddingId" value={weddingId} />
      <input type="hidden" name="theme" value={theme} />
      {children}
      {state && !state.ok ? <Notice tone="error">{state.formError}</Notice> : null}
      <p role="status" className="text-success min-h-5 text-sm font-medium" data-testid="site-customize-status">
        {state?.ok ? state.data.message : null}
      </p>
    </form>
  );
}

/**
 * One of the form's buttons. Only the clicked one shows progress; all wait
 * while a request is in flight. `name` completes the accessible name where
 * several buttons share their words ("Restablecer: Paleta").
 */
export function CustomizeButton({
  intent,
  label,
  pendingLabel,
  name,
  tone = "secondary",
}: {
  intent: string;
  label: string;
  pendingLabel: string;
  name?: string;
  tone?: "primary" | "secondary";
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("intent") === intent;
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      disabled={pending}
      // The visible words start the name (WCAG label in name).
      aria-label={mine ? pendingLabel : name ? `${label}: ${name}` : undefined}
      className={`${tone === "primary" ? primaryButtonClass : secondaryButtonClass} w-full sm:w-auto`}
    >
      <span aria-live="polite">{mine ? pendingLabel : label}</span>
    </button>
  );
}
