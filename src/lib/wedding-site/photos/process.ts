import "server-only";

import sharp from "sharp";

import { PHOTO_LIMITS, RENDITION_EDGE, type PhotoRendition } from "@/lib/wedding-site/photos/model";
import { inspectWebp, sniffImageFormat } from "@/lib/wedding-site/photos/webp";

/**
 * Server-side photo processing (ADR-022 §3, §13.7). Nothing the browser sent
 * is trusted: the magic bytes decide the format (JPEG, PNG or WebP only), the
 * decoder runs under pixel limits, the orientation is applied, and both
 * renditions are RE-ENCODED from pixels as WebP in sRGB with no EXIF, GPS,
 * XMP or ICC data (sharp keeps no metadata unless asked). Each output is then
 * checked with the same byte parser the delivery uses. The original is never
 * kept.
 */

export type ProcessedRendition = Readonly<{ data: Uint8Array; width: number; height: number }>;

export type ProcessResult =
  | Readonly<{ ok: true; renditions: Readonly<Record<PhotoRendition, ProcessedRendition>> }>
  | Readonly<{ ok: false; reason: "unsupported" | "too_small" | "too_large" | "unprocessable" }>;

/** WebP qualities tried in order until a rendition fits the bucket's object limit. */
const QUALITY_LADDER = [80, 70, 60] as const;

async function encode(
  input: Uint8Array,
  edge: number,
): Promise<ProcessedRendition | null> {
  for (const quality of QUALITY_LADDER) {
    const { data, info } = await sharp(input, {
      limitInputPixels: PHOTO_LIMITS.maxInputPixels,
      failOn: "error",
      animated: false,
    })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .webp({ quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (data.length > PHOTO_LIMITS.objectBytes - 16 * 1024) continue;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
    const inspection = inspectWebp(bytes);
    // The processor's own output must pass the delivery check.
    if (!inspection || inspection.width !== info.width || inspection.height !== info.height) return null;
    return { data: bytes, width: info.width, height: info.height };
  }
  return null;
}

export async function processPhoto(input: Uint8Array): Promise<ProcessResult> {
  const format = sniffImageFormat(input);
  if (!format) return { ok: false, reason: "unsupported" };

  let width: number;
  let height: number;
  try {
    const metadata = await sharp(input, {
      limitInputPixels: PHOTO_LIMITS.maxInputPixels,
      failOn: "error",
      animated: false,
    }).metadata();
    // The decoder must agree with the magic bytes (no polyglots slipping through).
    if (metadata.format !== format || !metadata.width || !metadata.height) return { ok: false, reason: "unsupported" };
    width = metadata.width;
    height = metadata.height;
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) return { ok: false, reason: "too_large" };
    return { ok: false, reason: "unprocessable" };
  }

  if (width > PHOTO_LIMITS.maxInputEdge || height > PHOTO_LIMITS.maxInputEdge) return { ok: false, reason: "too_large" };
  if (width * height > PHOTO_LIMITS.maxInputPixels) return { ok: false, reason: "too_large" };
  if (Math.min(width, height) < PHOTO_LIMITS.minShortEdge) return { ok: false, reason: "too_small" };

  try {
    const large = await encode(input, RENDITION_EDGE["1600"]);
    const small = large ? await encode(input, RENDITION_EDGE["640"]) : null;
    if (!large || !small) return { ok: false, reason: "unprocessable" };
    return { ok: true, renditions: { "1600": large, "640": small } };
  } catch {
    return { ok: false, reason: "unprocessable" };
  }
}
