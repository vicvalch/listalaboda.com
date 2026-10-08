"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import { Notice } from "@/components/ui/Notice";
import { textLinkClass } from "@/components/ui/styles";
import { getMessages } from "@/lib/i18n";

/** Tailwind's `lg` breakpoint: the planner needs a desktop-sized surface. */
const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const isDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;
// Unknown on the server: render neither the planner nor the notice yet.
const unknownOnServer = () => null;

/**
 * Renders the visual planner (LB-20) only on screens at least `lg` wide.
 * Narrower screens get a short notice and a link back to the list, which
 * keeps every seating operation; the planner's DOM is never rendered there
 * (not merely hidden). Presentation only: the list and the planner use the
 * same server data and actions.
 */
export function PlannerGate({ listHref, children }: { listHref: string; children: ReactNode }) {
  const desktop = useSyncExternalStore(subscribe, isDesktop, unknownOnServer);
  const copy = getMessages().seating.planner;

  if (desktop === null) {
    return <p className="text-muted text-sm">{copy.loading}</p>;
  }
  if (!desktop) {
    return (
      <div data-testid="planner-unavailable" className="space-y-3">
        <Notice tone="info">{copy.unavailable}</Notice>
        <Link href={listHref} className={textLinkClass}>
          {copy.backToList}
        </Link>
      </div>
    );
  }
  return children;
}
