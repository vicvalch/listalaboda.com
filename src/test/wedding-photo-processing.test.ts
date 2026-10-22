import sharp, { type Sharp } from "sharp";
import { describe, expect, it, vi } from "vitest";

import { inspectWebp, isDeliverableWebp, sniffImageFormat } from "@/lib/wedding-site/photos/webp";

vi.mock("server-only", () => ({}));

const { processPhoto } = await import("@/lib/wedding-site/photos/process");

/**
 * UX-01B (ADR-022 §3, §13.7): photo processing and delivery validation, with
 * fixtures generated here (no real photographs). The re-encode must remove
 * EXIF/GPS/XMP/ICC, apply the orientation, never upscale, and refuse
 * anything that isn't a decodable JPEG/PNG/WebP within the limits.
 */

async function noise(width: number, height: number): Promise<Sharp> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 251;
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

async function jpegWithMetadata(width = 1200, height = 800, orientation = 1): Promise<Buffer> {
  return (await noise(width, height))
    .jpeg({ quality: 85 })
    .withMetadata({ orientation })
    .withExif({
      IFD0: { Make: "TestCam", Model: "Fixture 1", Copyright: "Fixture owner" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "9/1 56/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "84/1 5/1 0/1" },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Fixture person"/></rdf:RDF></x:xmpmeta>')
    .toBuffer();
}

function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
}

describe("format sniffing", () => {
  it("knows JPEG, PNG and WebP by their bytes and nothing else", async () => {
    const jpeg = await (await noise(8, 8)).jpeg().toBuffer();
    const png = await (await noise(8, 8)).png().toBuffer();
    const webp = await (await noise(8, 8)).webp().toBuffer();
    const gif = await (await noise(8, 8)).gif().toBuffer();
    expect(sniffImageFormat(jpeg)).toBe("jpeg");
    expect(sniffImageFormat(png)).toBe("png");
    expect(sniffImageFormat(webp)).toBe("webp");
    expect(sniffImageFormat(gif)).toBeNull();
    expect(sniffImageFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array())).toBeNull();
  });
});

describe("processPhoto", () => {
  it("re-encodes a JPEG into two WebP renditions without EXIF, GPS or XMP", async () => {
    const input = await jpegWithMetadata(2400, 1600);
    expect(contains(input, "TestCam")).toBe(true);
    expect(contains(input, "Fixture person")).toBe(true);

    const result = await processPhoto(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const large = result.renditions["1600"];
    const small = result.renditions["640"];
    expect([large.width, large.height]).toEqual([1600, 1067]);
    expect([small.width, small.height]).toEqual([640, 427]);

    for (const rendition of [large, small]) {
      expect(sniffImageFormat(rendition.data)).toBe("webp");
      expect(rendition.data.length).toBeLessThanOrEqual(1024 * 1024);
      expect(inspectWebp(rendition.data)).toEqual({ width: rendition.width, height: rendition.height });
      for (const marker of ["Exif", "EXIF", "XMP ", "ICCP", "TestCam", "Fixture", "GPS", "xmpmeta"]) {
        expect(contains(rendition.data, marker)).toBe(false);
      }
      const metadata = await sharp(rendition.data).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    }
  });

  it("applies the EXIF orientation before dropping it", async () => {
    // Orientation 6 = rotate 90° clockwise: a landscape file shows as portrait.
    const result = await processPhoto(await jpegWithMetadata(1200, 800, 6));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.renditions["1600"].width, result.renditions["1600"].height]).toEqual([800, 1200]);
  });

  it("accepts PNG and WebP input, and never upscales", async () => {
    const png = await processPhoto(await (await noise(900, 700)).png().toBuffer());
    expect(png.ok && [png.renditions["1600"].width, png.renditions["1600"].height]).toEqual([900, 700]);
    const webp = await processPhoto(await (await noise(1000, 800)).webp().toBuffer());
    expect(webp.ok && [webp.renditions["640"].width, webp.renditions["640"].height]).toEqual([640, 512]);
  });

  it("removes an embedded ICC profile and outputs sRGB", async () => {
    const input = await (await noise(1000, 800)).jpeg().withIccProfile("p3").toBuffer();
    expect((await sharp(input).metadata()).icc).toBeDefined();
    const result = await processPhoto(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await sharp(result.renditions["1600"].data).metadata()).icc).toBeUndefined();
    expect(contains(result.renditions["1600"].data, "ICCP")).toBe(false);
  });

  it("refuses unsupported, wrong-signature and polyglot-looking files", async () => {
    const gif = await (await noise(800, 800)).gif().toBuffer();
    expect(await processPhoto(gif)).toEqual({ ok: false, reason: "unsupported" });
    expect(await processPhoto(Buffer.from("not an image at all"))).toEqual({ ok: false, reason: "unsupported" });
    // A PNG body behind JPEG magic bytes: the decoder disagrees with the signature.
    const png = await (await noise(800, 800)).png().toBuffer();
    const disguised = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), png]);
    const result = await processPhoto(disguised);
    expect(result.ok).toBe(false);
  });

  it("refuses truncated and corrupted files", async () => {
    const jpeg = await jpegWithMetadata(1200, 900);
    expect((await processPhoto(jpeg.subarray(0, Math.floor(jpeg.length / 2)))).ok).toBe(false);
    const png = await (await noise(800, 800)).png().toBuffer();
    const corrupted = Buffer.from(png);
    corrupted.fill(0x41, 40, 400);
    expect((await processPhoto(corrupted)).ok).toBe(false);
  });

  it("refuses photos that are too small to look good", async () => {
    expect(await processPhoto(await (await noise(1200, 500)).jpeg().toBuffer())).toEqual({ ok: false, reason: "too_small" });
  });

  it("refuses decompression bombs and oversized dimensions before decoding pixels", async () => {
    // 8000 × 8000 = 64 MP of a single color: a tiny file, above the 50 MP limit.
    const bomb = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#ffffff" } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    expect(await processPhoto(bomb)).toEqual({ ok: false, reason: "too_large" });
    // One side above 10,000 px, under the pixel limit.
    const strip = await sharp({ create: { width: 12_000, height: 1000, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer();
    expect(await processPhoto(strip)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("delivery validation", () => {
  it("accepts the processor's output within the rendition bound", async () => {
    const result = await processPhoto(await jpegWithMetadata(1600, 1200));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDeliverableWebp(result.renditions["1600"].data, 1600)).toBe(true);
    expect(isDeliverableWebp(result.renditions["640"].data, 640)).toBe(true);
    expect(isDeliverableWebp(result.renditions["1600"].data, 640)).toBe(false);
  });

  it("refuses a WebP a member wrote directly with EXIF, XMP or ICC data", async () => {
    const withExif = await (await noise(800, 600))
      .webp()
      .withExif({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N" } })
      .toBuffer();
    expect(inspectWebp(withExif)).toBeNull();
    const withXmp = await (await noise(800, 600)).webp().withXmp("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>").toBuffer();
    expect(inspectWebp(withXmp)).toBeNull();
    const withIcc = await (await noise(800, 600)).webp().withIccProfile("p3").toBuffer();
    expect(inspectWebp(withIcc)).toBeNull();
  });

  it("refuses animation, other formats, truncation and RIFF size lies", async () => {
    // A translucent image is stored as VP8X + ALPH + VP8; setting the VP8X
    // animation flag must be refused.
    const translucent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .webp()
      .toBuffer();
    expect(translucent.subarray(12, 16).toString("latin1")).toBe("VP8X");
    expect(inspectWebp(translucent)).toEqual({ width: 64, height: 64 });
    const animated = Buffer.from(translucent);
    animated[20] |= 0x02;
    expect(inspectWebp(animated)).toBeNull();
    expect(inspectWebp(await (await noise(64, 64)).jpeg().toBuffer())).toBeNull();
    const clean = await (await noise(64, 64)).webp().toBuffer();
    expect(inspectWebp(clean)).toEqual({ width: 64, height: 64 });
    expect(inspectWebp(clean.subarray(0, clean.length - 4))).toBeNull();
    const lying = Buffer.from(clean);
    lying.writeUInt32LE(lying.readUInt32LE(4) + 100, 4);
    expect(inspectWebp(lying)).toBeNull();
    // A trailing payload after a valid file (polyglot) breaks the RIFF size.
    expect(inspectWebp(Buffer.concat([clean, Buffer.from("PK\u0003\u0004 zip payload")]))).toBeNull();
  });
});
