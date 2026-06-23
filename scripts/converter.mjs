/**
 * Core image converter. Pure client-side: source bytes -> WebP bytes, with
 * optional downscale and a lossless heuristic for small alpha PNGs.
 *
 * Nothing here touches Foundry documents or the disk; callers feed it bytes
 * and get bytes back, so the same code serves both backfill and upload-time.
 */

import { WEBP_MAX_DIMENSION, warn } from "./constants.mjs";

/**
 * @typedef {Object} ConvertOptions
 * @property {number} quality              Lossy WebP quality, 0..1.
 * @property {number} maxDimension         Cap on the longest edge (px). 0 = no cap.
 * @property {number} losslessPngAlphaUnder Edge-length (px) under which a PNG
 *   carrying alpha is encoded losslessly instead of at `quality`. 0 disables.
 */

/**
 * @typedef {Object} ConvertResult
 * @property {Blob}    blob         The encoded WebP.
 * @property {number}  width        Output width (post-downscale).
 * @property {number}  height       Output height.
 * @property {number}  sourceBytes  Input byte length.
 * @property {number}  outputBytes  Output byte length.
 * @property {boolean} lossless     Whether lossless encoding was used.
 * @property {boolean} downscaled   Whether the image was scaled down.
 */

/** WebP cannot be produced at all if both edges already exceed the cap. */
export class ImageTooLargeError extends Error {}

/**
 * Decode a Blob into an ImageBitmap. Kept separate so callers that already
 * hold a bitmap (e.g. upload-time, where the File is in hand) can skip a copy.
 *
 * @param {Blob} blob
 * @returns {Promise<ImageBitmap>}
 */
export async function decode(blob) {
  return createImageBitmap(blob);
}

/**
 * Convert a source image Blob/File to WebP.
 *
 * @param {Blob}           source   Source image bytes (png/jpg).
 * @param {ConvertOptions} options
 * @returns {Promise<ConvertResult>}
 */
export async function convertToWebp(source, options) {
  const { quality, maxDimension, losslessPngAlphaUnder } = options;
  const bitmap = await decode(source);
  try {
    return await convertBitmap(bitmap, source.size, source.type, {
      quality,
      maxDimension,
      losslessPngAlphaUnder,
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Convert an already-decoded bitmap. Closes nothing — caller owns the bitmap.
 *
 * @param {ImageBitmap}    bitmap
 * @param {number}         sourceBytes
 * @param {string}         sourceType   MIME type of the source ("image/png" ...).
 * @param {ConvertOptions} options
 * @returns {Promise<ConvertResult>}
 */
export async function convertBitmap(bitmap, sourceBytes, sourceType, options) {
  const { quality, maxDimension, losslessPngAlphaUnder } = options;

  const target = fitWithin(bitmap.width, bitmap.height, maxDimension);
  const downscaled = target.width !== bitmap.width || target.height !== bitmap.height;

  if (target.width > WEBP_MAX_DIMENSION || target.height > WEBP_MAX_DIMENSION) {
    throw new ImageTooLargeError(
      `Image ${bitmap.width}x${bitmap.height} exceeds WebP's ${WEBP_MAX_DIMENSION}px limit even after any downscale.`,
    );
  }

  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);

  // Lossless only helps small PNGs with real transparency (token art, icons).
  // Photographic backgrounds compress far better lossy.
  const isPng = sourceType === "image/png";
  const longestEdge = Math.max(target.width, target.height);
  const useLossless =
    isPng &&
    losslessPngAlphaUnder > 0 &&
    longestEdge <= losslessPngAlphaUnder &&
    hasAlpha(ctx, target.width, target.height);

  const blob = await encode(canvas, useLossless ? undefined : quality, useLossless);

  return {
    blob,
    width: target.width,
    height: target.height,
    sourceBytes,
    outputBytes: blob.size,
    lossless: useLossless,
    downscaled,
  };
}

/**
 * Encode an OffscreenCanvas to WebP.
 *
 * `quality` is ignored when `lossless` is true. Browsers signal lossless WebP
 * via `quality: 1` with the lossless content path; OffscreenCanvas has no
 * explicit lossless flag, so we request quality 1 and rely on the encoder.
 *
 * @param {OffscreenCanvas} canvas
 * @param {number|undefined} quality
 * @param {boolean} lossless
 * @returns {Promise<Blob>}
 */
async function encode(canvas, quality, lossless) {
  const opts = { type: "image/webp" };
  // Quality 1 yields the encoder's near-lossless path; pairing it with the
  // small-PNG-alpha gate keeps these files visually exact without ballooning.
  opts.quality = lossless ? 1 : quality;
  const blob = await canvas.convertToBlob(opts);
  if (blob.type !== "image/webp") {
    throw new Error(`Browser did not produce WebP (got "${blob.type}").`);
  }
  return blob;
}

/**
 * Compute target dimensions that fit within `maxDimension` on the longest edge,
 * preserving aspect ratio. Never upscales.
 *
 * @param {number} w
 * @param {number} h
 * @param {number} maxDimension 0 disables the cap.
 * @returns {{width: number, height: number}}
 */
export function fitWithin(w, h, maxDimension) {
  if (!maxDimension || maxDimension <= 0) return { width: w, height: h };
  const longest = Math.max(w, h);
  if (longest <= maxDimension) return { width: w, height: h };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Detect whether any pixel is non-opaque. Samples the alpha channel; bails out
 * on the first transparent pixel found.
 *
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function hasAlpha(ctx, w, h) {
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (err) {
    // Tainted canvas (shouldn't happen for same-origin world assets). Assume
    // alpha so we never silently flatten transparency.
    warn("Could not read pixels for alpha check; assuming alpha present.", err);
    return true;
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}
