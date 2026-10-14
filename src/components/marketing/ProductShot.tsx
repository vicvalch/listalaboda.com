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
  className,
}: {
  image: StaticImageData;
  mobile?: StaticImageData;
  /** Spanish description of what the screen shows. Required: these are content, not decoration. */
  alt: string;
  caption?: string;
  /** The first screenshot on the page: loaded eagerly, with high priority. */
  priority?: boolean;
  className?: string;
}) {
  return (
    <figure className={cx("min-w-0", className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(42_34_32/0.06),0_12px_32px_-12px_rgb(42_34_32/0.18)]">
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
