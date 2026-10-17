import { cx } from "@/components/marketing/classes";

import monogram from "../../../public/brand/logo-lb-web.webp";
import signature from "../../../public/brand/firma-lb-web.webp";

/**
 * The official listalaboda.com signature (`public/brand/firma-lb.png`, trimmed
 * for the web by `scripts/brand-assets.mjs`). Plain `<picture>`/`<img>` from a
 * static import, like `ProductShot`: hashed URL and exact intrinsic size, no
 * client JavaScript. Size it
 * by height (`h-*`); the width follows the artwork's aspect ratio.
 *
 * Its ink is dark on a transparent background, so dark mode lightens it
 * (`.brand-ink` in `globals.css`). `alt` is the brand name, so a link that
 * wraps it keeps the same accessible name the text logo had.
 */
export function BrandSignature({ alt, className }: { alt: string; className?: string }) {
  return (
    <picture>
      <img
        src={signature.src}
        width={signature.width}
        height={signature.height}
        alt={alt}
        decoding="async"
        className={cx("brand-ink block w-auto max-w-full", className)}
      />
    </picture>
  );
}

/** The LB monogram, for compact places (narrow headers). Gold on transparent: readable in both modes. */
export function BrandMonogram({ alt, className }: { alt: string; className?: string }) {
  return (
    <picture>
      <img
        src={monogram.src}
        width={monogram.width}
        height={monogram.height}
        alt={alt}
        decoding="async"
        className={cx("block aspect-square w-auto", className)}
      />
    </picture>
  );
}
