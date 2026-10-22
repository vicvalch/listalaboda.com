import { Constants, type Database } from "@/lib/supabase/database.types";
import { SECTION_KINDS, type SectionKind } from "@/lib/wedding-site/sections";

/**
 * Wedding-site photos (UX-01B, ADR-022): the shared, pure vocabulary. Photos
 * are wedding CONTENT placed in closed blocks (a cover, galleries, carousels,
 * photos with text), never design: the theme only decides how a block is
 * drawn. The database (CHECKs, triggers, quotas) is authoritative; the limits
 * here mirror it for useful messages and for the lenient public parser.
 */

export type PhotoBlockKind = Database["public"]["Enums"]["wedding_site_photo_block_kind"];
export type PhotoBlockVariant = Database["public"]["Enums"]["wedding_site_photo_block_variant"];
export type PhotoRendition = "1600" | "640";

export const PHOTO_BLOCK_KINDS: readonly PhotoBlockKind[] = Constants.public.Enums.wedding_site_photo_block_kind;

/** The variants each kind offers, default first (the CHECK mirrors this). */
export const PHOTO_BLOCK_VARIANTS: Readonly<Record<PhotoBlockKind, readonly PhotoBlockVariant[]>> = {
  cover: ["standard"],
  gallery: ["grid", "masonry"],
  carousel: ["standard"],
  photo_text: ["image_start", "image_end"],
};

/** Kinds that hold exactly one photo. */
export const SINGLE_PHOTO_KINDS: readonly PhotoBlockKind[] = ["cover", "photo_text"];

export const PHOTO_RENDITIONS: readonly PhotoRendition[] = ["1600", "640"];

export const PHOTO_LIMITS = {
  /** What a couple may choose (checked in the browser; the server never sees larger files). */
  inputBytes: 15 * 1024 * 1024,
  /** The browser's transport copy (Vercel's request body limit is 4.5 MB). */
  transportBytes: 4 * 1024 * 1024,
  transportMaxEdge: 2400,
  /** The upload request's hard cap (multipart overhead included). */
  requestBytes: Math.floor(4.5 * 1024 * 1024),
  photosPerWedding: 20,
  blocksPerWedding: 12,
  concurrentUploads: 3,
  /** Decode limits (ADR-022 §3). */
  maxInputPixels: 50_000_000,
  maxInputEdge: 10_000,
  minShortEdge: 600,
  /** Bucket object limit (1 MB). */
  objectBytes: 1024 * 1024,
  altTextMax: 250,
  captionMax: 200,
  blockTitleMax: 120,
  blockBodyMax: 2000,
  focalMax: 10_000,
} as const;

/** The long edge of each rendition (never upscaled). */
export const RENDITION_EDGE: Readonly<Record<PhotoRendition, number>> = { "1600": 1600, "640": 640 };

export function isPhotoRendition(value: string): value is PhotoRendition {
  return (PHOTO_RENDITIONS as readonly string[]).includes(value);
}

export function isPhotoBlockKind(value: string): value is PhotoBlockKind {
  return (PHOTO_BLOCK_KINDS as readonly string[]).includes(value);
}

export function isVariantOf(kind: PhotoBlockKind, value: string): value is PhotoBlockVariant {
  return (PHOTO_BLOCK_VARIANTS[kind] as readonly string[]).includes(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lowercase canonical UUIDs only (the database's text form). */
export function isPhotoId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** The two object names of a photo in the private bucket (random id only). */
export function photoObjectName(photoId: string, rendition: PhotoRendition): string {
  return `${photoId}/${rendition}.webp`;
}

/** The CDN cache tag of a photo's public renditions (ADR-022 §4). */
export function photoCacheTag(photoId: string): string {
  return `lb-photo-${photoId}`;
}

// ------------------------------------------------------------ the DTO

export type SitePhoto = Readonly<{
  id: string;
  width: number;
  height: number;
  alt: string;
  caption: string | null;
  /** 0–10000 (hundredths of a percent): the focal point, applied as `object-position`. */
  focalX: number;
  focalY: number;
}>;

export type SitePhotoBlock = Readonly<{
  kind: PhotoBlockKind;
  variant: PhotoBlockVariant;
  /** Null = right after the opening; otherwise after that section's place in the fixed order. */
  anchor: SectionKind | null;
  title: string | null;
  body: string | null;
  /** Only in the member preview: a block the public page doesn't show. */
  hidden: boolean;
  photos: readonly SitePhoto[];
}>;

/**
 * What the renderer needs to draw photos: the blocks, and where their bytes
 * come from (`/boda/<slug>/fotos` publicly, the member route in the preview).
 */
export type SitePhotos = Readonly<{ blocks: readonly SitePhotoBlock[]; basePath: string }>;

export function photoSrc(basePath: string, photoId: string, rendition: PhotoRendition): string {
  return `${basePath}/${photoId}/${rendition}`;
}

/** The public renditions' base path for a published site's slug. */
export function publicPhotoBasePath(slug: string): string {
  return `/boda/${encodeURIComponent(slug)}/fotos`;
}

/** The member route's base path (previews and editor thumbnails). */
export function memberPhotoBasePath(weddingId: string): string {
  return `/app/weddings/${encodeURIComponent(weddingId)}/site/photos`;
}

// -------------------------------------------------------- lenient parsing

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function textUpTo(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && [...text].length <= max ? text : null;
}

function toSitePhoto(raw: unknown): SitePhoto | null {
  const row = record(raw);
  if (!row) return null;
  const id = typeof row.id === "string" && isPhotoId(row.id) ? row.id : null;
  const width = intIn(row.width, 1, 1600);
  const height = intIn(row.height, 1, 1600);
  const alt = textUpTo(row.alt, PHOTO_LIMITS.altTextMax);
  if (!id || !width || !height || !alt) return null;
  return {
    id,
    width,
    height,
    alt,
    caption: textUpTo(row.caption, PHOTO_LIMITS.captionMax),
    focalX: intIn(row.focalX, 0, PHOTO_LIMITS.focalMax) ?? 5000,
    focalY: intIn(row.focalY, 0, PHOTO_LIMITS.focalMax) ?? 5000,
  };
}

/**
 * Reads blocks as the public read (`site_photos`) or the editor shapes them,
 * field by field: an unknown kind or variant, a malformed photo or a block
 * left without photos is dropped, never drawn half-way. One cover at most;
 * single-photo kinds keep their first photo; text only on photo-with-text.
 * A database without the column (deploy skew) means no photos.
 */
export function toSitePhotoBlocks(raw: unknown): SitePhotoBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: SitePhotoBlock[] = [];
  let hasCover = false;
  for (const item of raw) {
    const row = record(item);
    if (!row || typeof row.kind !== "string" || !isPhotoBlockKind(row.kind)) continue;
    const kind = row.kind;
    if (typeof row.variant !== "string" || !isVariantOf(kind, row.variant)) continue;
    const anchor =
      kind === "cover" || row.anchor === null || row.anchor === undefined
        ? null
        : typeof row.anchor === "string" && (SECTION_KINDS as readonly string[]).includes(row.anchor)
          ? (row.anchor as SectionKind)
          : undefined;
    if (anchor === undefined) continue;
    if (kind === "cover" && hasCover) continue;

    const photos = (Array.isArray(row.photos) ? row.photos : [])
      .map(toSitePhoto)
      .filter((photo): photo is SitePhoto => photo !== null);
    const kept = SINGLE_PHOTO_KINDS.includes(kind) ? photos.slice(0, 1) : photos.slice(0, PHOTO_LIMITS.photosPerWedding);
    if (kept.length === 0) continue;

    if (kind === "cover") hasCover = true;
    blocks.push({
      kind,
      variant: row.variant,
      anchor,
      title: kind === "photo_text" ? textUpTo(row.title, PHOTO_LIMITS.blockTitleMax) : null,
      body: kind === "photo_text" ? textUpTo(row.body, PHOTO_LIMITS.blockBodyMax) : null,
      hidden: row.hidden === true,
      photos: kept,
    });
  }
  return blocks;
}

/** The cover block, if any. */
export function coverBlock(blocks: readonly SitePhotoBlock[]): SitePhotoBlock | null {
  return blocks.find((block) => block.kind === "cover") ?? null;
}

/** The non-cover blocks placed at one slot (null = after the opening), in order. */
export function blocksAt(blocks: readonly SitePhotoBlock[], anchor: SectionKind | null): SitePhotoBlock[] {
  return blocks.filter((block) => block.kind !== "cover" && block.anchor === anchor);
}

/** `object-position` from a focal point; numbers only, never a string from data. */
export function focalPosition(photo: Pick<SitePhoto, "focalX" | "focalY">): string {
  const x = Math.min(Math.max(Math.round(photo.focalX), 0), PHOTO_LIMITS.focalMax) / 100;
  const y = Math.min(Math.max(Math.round(photo.focalY), 0), PHOTO_LIMITS.focalMax) / 100;
  return `${x}% ${y}%`;
}

/** The small rendition's size, derived the way the processor resizes (never upscaled). */
export function renditionSize(photo: Pick<SitePhoto, "width" | "height">, rendition: PhotoRendition): { width: number; height: number } {
  const edge = RENDITION_EDGE[rendition];
  const long = Math.max(photo.width, photo.height);
  if (long <= edge) return { width: photo.width, height: photo.height };
  const scale = edge / long;
  return { width: Math.max(1, Math.round(photo.width * scale)), height: Math.max(1, Math.round(photo.height * scale)) };
}
