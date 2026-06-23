/** Shared module-wide constants. */

export const MODULE_ID = "batch-media-optimizer";

/** Settings keys, registered in settings.mjs. */
export const SETTINGS = {
  // Converter defaults (shared by backfill + upload-time).
  quality: "quality",
  maxDimension: "maxDimension",
  losslessPngAlphaUnder: "losslessPngAlphaUnder",
  // Upload-time auto-optimize.
  uploadOptimize: "uploadOptimize",
  // Backfill scope toggles.
  includeItems: "includeItems",
};

/** Source-image extensions we convert. Lower-case, no dot. */
export const CONVERTIBLE_EXTENSIONS = ["png", "jpg", "jpeg"];

/** WebP hard limit: max edge length the encoder accepts. */
export const WEBP_MAX_DIMENSION = 16383;

/** Console / notification prefix. */
export const LOG_PREFIX = "Batch Media Optimizer |";

export function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

export function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

export function error(...args) {
  console.error(LOG_PREFIX, ...args);
}
