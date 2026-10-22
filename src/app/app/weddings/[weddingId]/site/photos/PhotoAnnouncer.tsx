"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Announcement = Readonly<{ message: string; tone: "status" | "error"; nonce: number }>;

const AnnounceContext = createContext<((message: string, tone: "status" | "error") => void) | null>(null);

/**
 * One page-level live region for the photo editor. An edit can remove the
 * very control that made it ("Usar como portada" becomes "Es la portada";
 * a photo's last "Agregar" disappears), so each result is also announced
 * here, from the action's own response, before the refreshed page replaces
 * the form. Visible too, at the bottom of the screen.
 */
export function PhotoAnnouncer({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Announcement | null>(null);
  const announce = useCallback(
    (message: string, tone: "status" | "error") => setCurrent({ message, tone, nonce: Date.now() }),
    [],
  );
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
        <p
          role="status"
          aria-live="polite"
          data-testid="photo-announcer"
          className={
            current
              ? `rounded-full border px-4 py-2 text-sm font-semibold shadow-sm ${
                  current.tone === "error" ? "border-danger bg-danger-soft text-danger" : "border-border bg-surface"
                }`
              : "sr-only"
          }
        >
          {current ? <span key={current.nonce}>{current.message}</span> : null}
        </p>
      </div>
    </AnnounceContext.Provider>
  );
}

/** The page's announcer, or a no-op outside it. */
export function useAnnounce(): (message: string, tone: "status" | "error") => void {
  return useContext(AnnounceContext) ?? (() => {});
}
