// Generates the web brand assets and app icons from the two official files.
//
//   node scripts/brand-assets.mjs
//
// Sources (never edited): public/brand/firma-lb.png (signature) and
// public/brand/logo-lb.png (LB monogram). Outputs:
//   public/brand/firma-lb-web.webp   signature, transparent padding trimmed
//   public/brand/logo-lb-web.webp    monogram, trimmed to a square
//   src/app/favicon.ico              16, 32, 48 (PNG entries, transparent)
//   src/app/icon1.png, icon2.png     16 and 32 (transparent)
//   src/app/apple-icon.png           180, on the app background (iOS fills
//                                    transparency with black)
// Uses `sharp`, which ships with Next.js. Review regenerated files like
// golden files.

import { writeFileSync } from "node:fs";
import sharp from "sharp";

const SIGNATURE = "public/brand/firma-lb.png";
const MONOGRAM = "public/brand/logo-lb.png";
const APP_BACKGROUND = "#fdfaf7"; // --background (light) in globals.css
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** The image cropped to its visible pixels (alpha-based trim). */
async function trimmed(file) {
  return sharp(await sharp(file).trim({ background: TRANSPARENT, threshold: 1 }).png().toBuffer());
}

/** The monogram trimmed, centered on a transparent square with `padding` (fraction of the side). */
async function monogramSquare(padding) {
  const image = await trimmed(MONOGRAM);
  const { width, height } = await image.metadata();
  const side = Math.round(Math.max(width, height) * (1 + 2 * padding));
  const left = Math.round((side - width) / 2);
  const top = Math.round((side - height) / 2);
  return sharp({ create: { width: side, height: side, channels: 4, background: TRANSPARENT } })
    .composite([{ input: await image.png().toBuffer(), left, top }])
    .png()
    .toBuffer();
}

async function pngAt(square, size, background) {
  let image = sharp(square).resize(size, size, { kernel: "lanczos3" });
  if (background) image = image.flatten({ background });
  return image.png({ compressionLevel: 9 }).toBuffer();
}

/** An ICO file whose entries are PNG images (supported by every current browser). */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, data }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

const signature = await trimmed(SIGNATURE);
await signature
  .resize({ width: 960 })
  .webp({ quality: 90, alphaQuality: 100, effort: 6 })
  .toFile("public/brand/firma-lb-web.webp");

await sharp(await monogramSquare(0.04))
  .resize(256, 256)
  .webp({ quality: 90, alphaQuality: 100, effort: 6 })
  .toFile("public/brand/logo-lb-web.webp");

// Tiny sizes: almost no padding, so the letters keep every pixel they can.
const iconSquare = await monogramSquare(0.02);
const icon16 = await pngAt(iconSquare, 16);
const icon32 = await pngAt(iconSquare, 32);
const icon48 = await pngAt(iconSquare, 48);
writeFileSync("src/app/favicon.ico", ico([
  { size: 16, data: icon16 },
  { size: 32, data: icon32 },
  { size: 48, data: icon48 },
]));
writeFileSync("src/app/icon1.png", icon16);
writeFileSync("src/app/icon2.png", icon32);
// Apple touch icon: opaque, with a margin so the rounded mask never cuts the leaf.
writeFileSync("src/app/apple-icon.png", await pngAt(await monogramSquare(0.14), 180, APP_BACKGROUND));

console.log("Brand assets written.");
