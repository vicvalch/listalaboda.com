"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * An editor behind "Editar" (UX-01D): a native <details>, so it works with
 * the keyboard and without JavaScript. `defaultOpen` counts on the first
 * render only: a save refreshes the page, and the editor stays as the person
 * left it instead of snapping shut. `focusOnOpen` moves focus to the summary
 * once (a section that was just created), so keyboard and screen reader
 * users land on it. Inside a row of buttons, an open editor drops below
 * them and takes the full width.
 */
export function Disclosure({
  summary,
  summaryLabel,
  defaultOpen = false,
  focusOnOpen = false,
  testId,
  children,
}: {
  summary: ReactNode;
  summaryLabel?: string;
  defaultOpen?: boolean;
  focusOnOpen?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusOnOpen) summaryRef.current?.focus();
  }, [focusOnOpen]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} data-testid={testId} className="group open:order-last open:basis-full">
      <summary
        ref={summaryRef}
        aria-label={summaryLabel}
        className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
