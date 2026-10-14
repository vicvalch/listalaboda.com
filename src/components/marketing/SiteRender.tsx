import { WeddingSite } from "@/components/wedding-site/WeddingSite";
import { cx } from "@/components/marketing/classes";
import { SHOWCASE_SITE } from "@/lib/marketing/showcase";
import { resolveSiteDesign } from "@/lib/wedding-site/design/resolve";
import type { WeddingSiteThemeKey } from "@/lib/wedding-site/design/themes";

/**
 * One wedding site theme drawn by the REAL renderer (`WeddingSite` +
 * `resolveSiteDesign`) from the fictional showcase content, scaled into a box
 * (Marketing Landing V1). Decorative: `aria-hidden` and `inert`, so nothing
 * inside is read or focusable; the page names the theme in real text when it
 * matters. The box's size and shape come from `className` (e.g. an aspect
 * ratio); `scale` sets how much of the site fits in it.
 */
export function SiteRender({
  theme,
  scale = "quarter",
  className,
}: {
  theme: WeddingSiteThemeKey;
  /** `quarter`: drawn 4× wider, then scaled to ¼ (a thumbnail). `half`: 2×, scaled to ½ (a large render). */
  scale?: "quarter" | "half";
  className?: string;
}) {
  return (
    <div aria-hidden="true" inert className={cx("relative overflow-hidden bg-background text-foreground", className)}>
      {/* At least as tall as the box (before scaling), so the site's own
          background fills it (its root grows with flex-1). */}
      <div
        className={cx(
          "pointer-events-none absolute top-0 left-0 flex origin-top-left flex-col select-none",
          scale === "quarter" ? "min-h-[400%] w-[400%] scale-25" : "min-h-[200%] w-[200%] scale-50",
        )}
      >
        <WeddingSite site={SHOWCASE_SITE} design={resolveSiteDesign(theme)} element="div" />
      </div>
    </div>
  );
}
