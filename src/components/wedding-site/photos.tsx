import type { CSSProperties } from "react";

import { cx, PHOTO_STYLE, sectionHeadingClass } from "@/components/wedding-site/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import type { ResolvedSiteDesign } from "@/lib/wedding-site/design/resolve";
import {
  focalPosition,
  photoSrc,
  renditionSize,
  type SitePhoto,
  type SitePhotoBlock,
} from "@/lib/wedding-site/photos/model";

/**
 * Photos on the wedding site (UX-01B, ADR-022). Server Components with no
 * client JavaScript (ADR-019): plain `<img>` with the rendition's real
 * width/height (no layout shift), a 640/1600 `srcset`, `sizes`, lazy loading
 * below the opening, the couple's alt text and captions as text. Text never
 * sits on a photo (WCAG AA holds whatever the image). The theme decides only
 * closed treatments (`PHOTO_STYLE`, from its section style); the one inline
 * style is the focal point as `object-position`, built from re-validated
 * integers (`focalPosition`), never a string from data.
 */

type ImageProps = Readonly<{
  photo: SitePhoto;
  basePath: string;
  sizes: string;
  className: string;
  /** The opening's photo loads at once; everything else lazily. */
  eager?: boolean;
  /** Cropped boxes keep the focal point in view; natural-ratio images need none. */
  cropped?: boolean;
}>;

export function SitePhotoImage({ photo, basePath, sizes, className, eager = false, cropped = true }: ImageProps) {
  const small = renditionSize(photo, "640");
  const style: CSSProperties | undefined = cropped ? { objectPosition: focalPosition(photo) } : undefined;
  return (
    // Plain <img> on purpose (ADR-022): our own processed renditions; next/image would add
    // paid transformations and a second, ungated path to the bytes.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photoSrc(basePath, photo.id, "1600")}
      srcSet={`${photoSrc(basePath, photo.id, "640")} ${small.width}w, ${photoSrc(basePath, photo.id, "1600")} ${photo.width}w`}
      sizes={sizes}
      width={photo.width}
      height={photo.height}
      alt={photo.alt}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : undefined}
      decoding="async"
      className={className}
      style={style}
      data-testid="site-photo"
    />
  );
}

/** The cover inside the opening; its box per hero variant comes from the hero. */
export function CoverImage({
  block,
  basePath,
  design,
  frame,
}: {
  block: SitePhotoBlock;
  basePath: string;
  design: ResolvedSiteDesign;
  frame: string;
}) {
  const photo = block.photos[0];
  if (!photo) return null;
  return (
    <figure className="m-0 space-y-2" data-testid="site-cover">
      {block.hidden ? <HiddenBadge /> : null}
      <SitePhotoImage
        photo={photo}
        basePath={basePath}
        sizes="(min-width: 56rem) 56rem, 100vw"
        className={cx("block w-full object-cover", frame, PHOTO_STYLE[design.sectionStyle].image)}
        eager
      />
      {photo.caption ? <Caption text={photo.caption} design={design} /> : null}
    </figure>
  );
}

function HiddenBadge() {
  return (
    <p className="inline-block rounded-full border border-dashed border-border px-3 py-1 text-xs font-semibold" data-testid="site-photo-hidden">
      {getMessages().publicSite.photos.hiddenBadge}
    </p>
  );
}

function Caption({ text, design }: { text: string; design: ResolvedSiteDesign }) {
  return <figcaption className={cx("text-muted text-sm break-words", PHOTO_STYLE[design.sectionStyle].caption)}>{text}</figcaption>;
}

/** One non-cover block, in its kind's markup. */
export function SitePhotoBlockView({
  block,
  basePath,
  design,
  index,
}: {
  block: SitePhotoBlock;
  basePath: string;
  design: ResolvedSiteDesign;
  /** Its place among the page's photo blocks (unique ids for the carousel's links). */
  index: number;
}) {
  const style = PHOTO_STYLE[design.sectionStyle];
  const body = (() => {
    switch (block.kind) {
      case "gallery":
        return <Gallery block={block} basePath={basePath} design={design} />;
      case "carousel":
        return <Carousel block={block} basePath={basePath} design={design} index={index} />;
      case "photo_text":
        return <PhotoWithText block={block} basePath={basePath} design={design} />;
      case "cover":
        return null;
    }
  })();
  if (!body) return null;
  return (
    <section
      className={cx("space-y-3", style.block, block.hidden && "outline-2 outline-offset-4 outline-dashed outline-border")}
      data-testid={`site-photo-block-${block.kind}`}
    >
      {block.hidden ? <HiddenBadge /> : null}
      {body}
    </section>
  );
}

function Gallery({ block, basePath, design }: { block: SitePhotoBlock; basePath: string; design: ResolvedSiteDesign }) {
  const style = PHOTO_STYLE[design.sectionStyle];
  const label = getMessages().publicSite.photos.gallery;
  if (block.variant === "masonry") {
    return (
      <ul aria-label={label} className="m-0 list-none columns-2 gap-3 p-0 sm:columns-3 [&>li]:mb-3">
        {block.photos.map((photo) => (
          <li key={photo.id} className="break-inside-avoid">
            <figure className={cx("m-0 space-y-1.5", style.tile)}>
              <SitePhotoImage
                photo={photo}
                basePath={basePath}
                sizes="(min-width: 40rem) 33vw, 50vw"
                className={cx("block h-auto w-full", style.image)}
                cropped={false}
              />
              {photo.caption ? <Caption text={photo.caption} design={design} /> : null}
            </figure>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul aria-label={label} className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
      {block.photos.map((photo) => (
        <li key={photo.id}>
          <figure className={cx("m-0 space-y-1.5", style.tile)}>
            <SitePhotoImage
              photo={photo}
              basePath={basePath}
              sizes="(min-width: 40rem) 33vw, 50vw"
              className={cx("block aspect-square w-full object-cover", style.image)}
            />
            {photo.caption ? <Caption text={photo.caption} design={design} /> : null}
          </figure>
        </li>
      ))}
    </ul>
  );
}

/**
 * A carousel that needs no JavaScript (ADR-022 §13.8): a focusable CSS
 * scroll-snap region (arrow keys scroll it, swipe on touch), "Anterior /
 * Siguiente" as in-page links to the neighbouring slide, "3 de 8" in text.
 * No autoplay; smooth scrolling only without `prefers-reduced-motion`.
 */
function Carousel({
  block,
  basePath,
  design,
  index,
}: {
  block: SitePhotoBlock;
  basePath: string;
  design: ResolvedSiteDesign;
  index: number;
}) {
  const copy = getMessages().publicSite.photos;
  const style = PHOTO_STYLE[design.sectionStyle];
  const total = block.photos.length;
  const slideId = (position: number) => `fotos-${index + 1}-${position + 1}`;
  return (
    <div role="region" aria-roledescription={copy.carousel} aria-label={copy.carousel} className="space-y-2">
      <ul
        tabIndex={0}
        aria-label={copy.carousel}
        className="m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto p-0 motion-safe:scroll-smooth focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {block.photos.map((photo, position) => (
          <li
            key={photo.id}
            id={slideId(position)}
            className="w-full shrink-0 snap-center scroll-mt-6"
          >
            <figure className={cx("m-0 space-y-2", style.tile)}>
              <SitePhotoImage
                photo={photo}
                basePath={basePath}
                sizes="(min-width: 56rem) 56rem, 100vw"
                className={cx("block aspect-[3/2] w-full object-cover", style.image)}
              />
              <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                <span className="text-muted break-words">{photo.caption}</span>
                <span className="text-muted tabular-nums">
                  {interpolate(copy.slide, { position: String(position + 1), total: String(total) })}
                </span>
              </figcaption>
              {total > 1 ? (
                <p className="flex justify-between gap-4 text-sm font-semibold">
                  {position > 0 ? (
                    <a href={`#${slideId(position - 1)}`} aria-label={copy.previousLabel} className="text-accent underline-offset-4 hover:underline">
                      ← {copy.previous}
                    </a>
                  ) : (
                    <span />
                  )}
                  {position < total - 1 ? (
                    <a href={`#${slideId(position + 1)}`} aria-label={copy.nextLabel} className="text-accent underline-offset-4 hover:underline">
                      {copy.next} →
                    </a>
                  ) : null}
                </p>
              ) : null}
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhotoWithText({ block, basePath, design }: { block: SitePhotoBlock; basePath: string; design: ResolvedSiteDesign }) {
  const photo = block.photos[0];
  if (!photo) return null;
  const style = PHOTO_STYLE[design.sectionStyle];
  const imageFirst = block.variant !== "image_end";
  return (
    <div className="grid items-center gap-5 sm:grid-cols-2 sm:gap-8">
      <figure className={cx("m-0 space-y-1.5", style.tile, !imageFirst && "sm:order-2")}>
        <SitePhotoImage
          photo={photo}
          basePath={basePath}
          sizes="(min-width: 40rem) 50vw, 100vw"
          className={cx("block aspect-[4/5] w-full object-cover", style.image)}
        />
        {photo.caption ? <Caption text={photo.caption} design={design} /> : null}
      </figure>
      {block.title || block.body ? (
        <div className="min-w-0 space-y-3">
          {block.title ? <h2 className={sectionHeadingClass(design.headingScale, design.typography)}>{block.title}</h2> : null}
          {block.body ? <p className="leading-relaxed break-words whitespace-pre-line">{block.body}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
