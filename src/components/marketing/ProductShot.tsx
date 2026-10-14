import type { StaticImageData } from "next/image";

import { cx } from "@/components/marketing/classes";

/**
 * A real product screenshot (Marketing Landing V1), captured from the
 * fictional local fixture (`npm run marketing:capture`), in a quiet frame.
 *
 * Plain `<picture>`/`<img>` from static imports: the build gives each file a
 * hashed URL and its exact size (width/height, so no layout shift), and the
 * page ships no client JavaScript for images (the `next/image` component is
 * never needed: captures are already 2× and phones get their own tighter
 * crop through `mobile`, never a shrunken desktop screen).
 */
export function ProductShot({
  image,
  mobile,
  alt,
  caption,
  priority = false,
  fade = false,
  frame = "card",
  frameClassName,
  className,
}: {
  image: StaticImageData;
  mobile?: StaticImageData;
  /** Spanish description of what the screen shows. Required: these are content, not decoration. */
  alt: string;
  caption?: string;
  /** The first screenshot on the page: loaded eagerly, with high priority. */
  priority?: boolean;
  /**
   * The frame fades out at the bottom (light mode; dark mode just crops): an
   * intentional crop of a long screen (set its height with `frameClassName`,
   * e.g. `max-h-[36rem]`). The alt text still describes the whole screen.
   */
  fade?: boolean;
  /**
   * `card` (default): a quiet border and shadow around the screen.
   * `none`: no frame at all, for a screen whose own page background matches
   * the marketing page (it becomes part of the composition) or one drawn
   * inside another container.
   * `lifted`: no border, only a deep shadow, for a screen that already has
   * its own card edge and is laid over another screen.
   */
  frame?: "card" | "none" | "lifted";
  frameClassName?: string;
  className?: string;
}) {
  return (
    <figure className={cx("min-w-0", className)}>
      <div
        className={cx(
          "overflow-hidden",
          frame === "card" &&
            "rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(42_34_32/0.06),0_12px_32px_-12px_rgb(42_34_32/0.18)]",
          frame === "lifted" && "rounded-xl shadow-[0_2px_4px_rgb(42_34_32/0.08),0_28px_56px_-20px_rgb(42_34_32/0.4)]",
          // Light only: a light screen fading into the dark page turns grey, so dark mode crops cleanly.
          fade && "[mask-image:linear-gradient(to_bottom,#000_70%,transparent)] dark:[mask-image:none]",
          frameClassName,
        )}
      >
        <picture>
          {mobile ? <source media="(max-width: 639px)" srcSet={mobile.src} width={mobile.width} height={mobile.height} /> : null}
          <img
            src={image.src}
            width={image.width}
            height={image.height}
            alt={alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={priority ? "high" : "auto"}
            className="block h-auto w-full"
          />
        </picture>
      </div>
      {caption ? <figcaption className="text-muted mt-3 text-sm">{caption}</figcaption> : null}
    </figure>
  );
}
