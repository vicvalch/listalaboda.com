import type { InsertableElement } from "@/lib/wedding-site/studio";

/** Small line icons for Studio's element library (decorative: always next to a text name). */
export function ElementIcon({ kind, className = "h-6 w-6" }: { kind: InsertableElement | "cover" | "text"; className?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {kind === "carousel" ? (
        <>
          <rect x="6" y="5" width="12" height="11" rx="1.5" {...common} />
          <path d="M3 9l-1.5 1.5L3 12M21 9l1.5 1.5L21 12" {...common} />
          <circle cx="10" cy="19.5" r="0.8" fill="currentColor" />
          <circle cx="12.5" cy="19.5" r="0.8" fill="currentColor" opacity="0.5" />
          <circle cx="15" cy="19.5" r="0.8" fill="currentColor" opacity="0.5" />
        </>
      ) : kind === "gallery" ? (
        <>
          <rect x="3" y="4" width="8" height="7" rx="1" {...common} />
          <rect x="13" y="4" width="8" height="7" rx="1" {...common} />
          <rect x="3" y="13" width="8" height="7" rx="1" {...common} />
          <rect x="13" y="13" width="8" height="7" rx="1" {...common} />
        </>
      ) : kind === "photo_text" ? (
        <>
          <rect x="2.5" y="5" width="10" height="14" rx="1.5" {...common} />
          <path d="M15 8h6.5M15 12h6.5M15 16h4.5" {...common} />
        </>
      ) : kind === "single" ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="1.5" {...common} />
          <path d="M3 16l5-5 4 4 3-3 6 6" {...common} />
          <circle cx="16" cy="8.5" r="1.5" {...common} />
        </>
      ) : kind === "cover" ? (
        <>
          <path d="M4 20V9.5C4 6 7.6 3 12 3s8 3 8 6.5V20z" {...common} />
          <path d="M8 15h8M9.5 18h5" {...common} />
        </>
      ) : (
        <path d="M5 6h14M5 10h14M5 14h10M5 18h12" {...common} />
      )}
    </svg>
  );
}
