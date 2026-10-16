import type { StaticImageData } from "next/image";

import { cx } from "@/components/marketing/classes";

/**
 * A wedding photograph on a marketing page (MKT-5): atmosphere and emotion,
 * never proof of what the product does (real screens and the real site
 * renderer do that). Plain `<img>` with two static sizes in `srcSet`, like
 * `ProductShot`: no `next/image` runtime and no client JavaScript.
 *
 * The photo fills its box (`object-cover`); the box's position (`relative`
 * or `absolute`: one is required), size, shape and mask come from
 * `className`, and `position` chooses the crop. An empty `alt`
 * makes it decorative: hidden from assistive technology. Motion (hover zoom,
 * `drift`, reveal) and the dark-mode dimming live in `globals.css`, and stop
 * entirely under `prefers-reduced-motion: reduce`.
 */
export function LifestylePhoto({
  image,
  small,
  alt,
  sizes,
  position = "object-center",
  drift = false,
  priority = false,
  className,
}: {
  image: StaticImageData;
  /** The same photo, about half as wide, for phones and narrow boxes. */
  small: StaticImageData;
  /** Spanish description when the photo carries meaning; `""` for a decorative layer. */
  alt: string;
  /** The rendered width, as in `<img sizes>`. */
  sizes: string;
  /** An `object-*` position class (e.g. `object-[30%_center]`): which part of the photo the crop keeps. */
  position?: string;
  /** A slow decorative pan instead of the hover zoom (decorative layers only). */
  drift?: boolean;
  /** The page's first, above-the-fold photo: loaded eagerly, with high priority. */
  priority?: boolean;
  className?: string;
}) {
  const decorative = alt === "";
  return (
    <div
      aria-hidden={decorative ? "true" : undefined}
      className={cx("mkt-photo overflow-hidden", drift ? "mkt-drift" : "mkt-zoom", className)}
    >
      <picture>
        <img
          src={image.src}
          srcSet={`${small.src} ${small.width}w, ${image.src} ${image.width}w`}
          sizes={sizes}
          width={image.width}
          height={image.height}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          data-lifestyle=""
          className={cx("absolute inset-0 block h-full w-full object-cover", position)}
        />
      </picture>
    </div>
  );
}
