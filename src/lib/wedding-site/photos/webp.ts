/**
 * Byte-level checks for wedding photos (ADR-022 §3, §13.7). Pure: no decoding,
 * no I/O. Used on upload (the declared type never counts; the magic bytes do)
 * and on every delivery (an object a member could have written straight to
 * the bucket is served only if it is a plain, still WebP within the
 * rendition's bounds and carries no metadata chunk).
 */

export type InputFormat = "jpeg" | "png" | "webp";

/** The format the first bytes prove, or null (anything else, including HEIC, GIF, SVG and text). */
export function sniffImageFormat(bytes: Uint8Array): InputFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 12 && fourCC(bytes, 0) === "RIFF" && fourCC(bytes, 8) === "WEBP") return "webp";
  return null;
}

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + bytes[offset + 3] * 0x1000000;
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/** Chunks that may never be delivered: metadata (EXIF/XMP/ICC) and animation. */
const FORBIDDEN_CHUNKS = new Set(["EXIF", "XMP ", "ICCP", "ANIM", "ANMF"]);

// VP8X flags (RIFF WebP container spec).
const VP8X_ICC = 0x20;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

export type WebpInspection = Readonly<{ width: number; height: number }>;

/**
 * Parses a RIFF WebP file and returns its canvas size, or null when it is not
 * a well-formed, still, metadata-free WebP: wrong header, RIFF size not
 * matching the bytes, a truncated or unknown first chunk, an EXIF/XMP/ICC or
 * animation flag or chunk, or no image chunk at all.
 */
export function inspectWebp(bytes: Uint8Array): WebpInspection | null {
  if (bytes.length < 20 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WEBP") return null;
  if (uint32le(bytes, 4) + 8 !== bytes.length) return null;

  let width = 0;
  let height = 0;
  let hasImage = false;
  let offset = 12;
  let first = true;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return null;
    const id = fourCC(bytes, offset);
    const size = uint32le(bytes, offset + 4);
    const data = offset + 8;
    const end = data + size + (size % 2);
    if (data + size > bytes.length || end > bytes.length) return null;
    if (FORBIDDEN_CHUNKS.has(id)) return null;

    if (id === "VP8X") {
      if (!first || size < 10) return null;
      const flags = bytes[data];
      if (flags & (VP8X_ICC | VP8X_EXIF | VP8X_XMP | VP8X_ANIMATION)) return null;
      width = uint24le(bytes, data + 4) + 1;
      height = uint24le(bytes, data + 7) + 1;
    } else if (id === "VP8 ") {
      // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width/height.
      if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null;
      const w = (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff;
      const h = (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff;
      if (first) {
        width = w;
        height = h;
      }
      hasImage = true;
    } else if (id === "VP8L") {
      if (size < 5 || bytes[data] !== 0x2f) return null;
      const bits = uint32le(bytes, data + 1);
      if (first) {
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      hasImage = true;
    } else if (first || id !== "ALPH") {
      // The first chunk must be VP8X, VP8 or VP8L; later only ALPH and the image.
      return null;
    }
    first = false;
    offset = end;
  }

  if (!hasImage || width < 1 || height < 1) return null;
  return { width, height };
}

/** Delivery check: a clean WebP whose long edge is within the rendition's bound. */
export function isDeliverableWebp(bytes: Uint8Array, maxEdge: number): boolean {
  const inspection = inspectWebp(bytes);
  return inspection !== null && Math.max(inspection.width, inspection.height) <= maxEdge;
}
