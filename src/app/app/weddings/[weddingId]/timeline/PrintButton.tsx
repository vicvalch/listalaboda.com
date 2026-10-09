"use client";

import { secondaryButtonClass } from "@/components/ui/styles";

/** Opens the browser's print dialog; the page's print styles do the rest. No export, no PDF. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={`${secondaryButtonClass} min-h-9 px-3 py-1.5`}>
      {label}
    </button>
  );
}
