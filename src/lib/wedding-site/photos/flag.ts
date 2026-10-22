import "server-only";

/**
 * The `WEDDING_SITE_PHOTOS` server flag (ADR-022 §11): photos exist only when
 * it is exactly `on`. Default (unset or anything else) is off: no editor, no
 * uploads, no `site_photos` on public pages and 404 for every photo route.
 * Turning it on in production is a separate, explicitly approved step.
 */
export function isWeddingSitePhotosEnabled(): boolean {
  return process.env.WEDDING_SITE_PHOTOS === "on";
}
