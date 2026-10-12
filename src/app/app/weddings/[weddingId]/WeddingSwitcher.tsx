"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { inputClass, textLinkClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { MY_WEDDINGS_LIST_PATH } from "@/lib/weddings/entry";
import { matchesWeddingSearch, switchWeddingPath } from "@/lib/weddings/navigation";
import type { SwitcherWedding } from "@/lib/weddings/switcher";

type Props = {
  /** Serializable identity and navigation data only (no overview, attention or money). */
  weddings: readonly SwitcherWedding[];
  /** The URL's wedding id: the only notion of "current" (no stored active wedding). */
  currentId: string;
};

/** Search appears only for longer lists. */
const SEARCH_THRESHOLD = 8;

/**
 * Wedding switcher (LB-24C, ADR-017): navigation only, over the caller's own
 * memberships given by the layout. A native disclosure (no menu role): it
 * closes on Escape (focus back to the summary), on choosing a wedding, on a
 * route change and on an outside click. Nothing is remembered anywhere.
 */
export function WeddingSwitcher({ weddings, currentId }: Props) {
  const { switcher: copy, noDate } = getMessages().app.weddings;
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const searchId = useId();

  // A foreign or unknown id never shows a name: neutral label only.
  const current = weddings.find((wedding) => wedding.id === currentId) ?? null;
  const searchable = weddings.length >= SEARCH_THRESHOLD;
  const visible = searchable ? weddings.filter((wedding) => matchesWeddingSearch(wedding, query)) : weddings;

  function close() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  // Any route change closes the panel (DOM only; no React state to sync).
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !detailsRef.current?.open) return;
    event.preventDefault();
    close();
    summaryRef.current?.focus();
  }

  return (
    <details
      ref={detailsRef}
      className="group relative"
      data-testid="wedding-switcher"
      onKeyDown={onKeyDown}
      onToggle={(event) => {
        if (!event.currentTarget.open) setQuery("");
      }}
    >
      <summary
        ref={summaryRef}
        aria-label={current ? interpolate(copy.labelCurrent, { name: current.name }) : copy.label}
        className="flex min-h-11 w-full cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm font-semibold transition-colors hover:bg-accent-soft sm:inline-flex sm:w-auto sm:max-w-md [&::-webkit-details-marker]:hidden"
      >
        <span className="line-clamp-2 break-words">{current ? current.name : copy.label}</span>
        <span aria-hidden="true" className="text-muted inline-block transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>

      <div className="mt-2 w-full rounded-xl border border-border bg-surface p-2 shadow-lg sm:absolute sm:left-0 sm:z-20 sm:w-80">
        {searchable ? (
          <div className="space-y-2 p-2">
            <label htmlFor={searchId} className="text-muted block text-xs font-semibold">
              {copy.searchLabel}
            </label>
            <input
              id={searchId}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={inputClass}
            />
            <p role="status" className="text-muted text-xs">
              {visible.length === 0
                ? copy.noResults
                : visible.length === 1
                  ? copy.searchResultsOne
                  : interpolate(copy.searchResultsMany, { count: String(visible.length) })}
            </p>
          </div>
        ) : null}

        <nav aria-label={copy.listLabel}>
          <ul className="max-h-[60vh] overflow-y-auto">
            {visible.map((wedding) => {
              const isCurrent = wedding.id === current?.id;
              return (
                <li key={wedding.id}>
                  <Link
                    href={switchWeddingPath(pathname, wedding)}
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={close}
                    data-testid="wedding-switcher-option"
                    className="flex min-h-11 items-start justify-between gap-3 rounded-lg px-3 py-2 hover:bg-accent-soft aria-[current=page]:bg-accent-soft"
                  >
                    <span className="min-w-0">
                      <span className="line-clamp-2 block text-sm font-semibold break-words">{wedding.name}</span>
                      <span className="text-muted block text-xs break-words">
                        {wedding.dateLabel ?? noDate}
                        {wedding.city ? ` · ${wedding.city}` : null}
                      </span>
                    </span>
                    {isCurrent ? (
                      <span aria-hidden="true" className="text-accent font-semibold">
                        ✓
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mt-2 flex flex-col border-t border-border pt-2">
          <Link href={MY_WEDDINGS_LIST_PATH} onClick={close} className={`${textLinkClass} flex min-h-11 items-center px-3`}>
            {copy.viewAll}
          </Link>
          <Link href="/app/weddings/new" onClick={close} className={`${textLinkClass} flex min-h-11 items-center px-3`}>
            {copy.create}
          </Link>
        </div>
      </div>
    </details>
  );
}
