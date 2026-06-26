/** Shared module-wide constants. */

export const MODULE_ID = "batch-media-optimizer";

/** Settings keys, registered in settings.mjs. */
export const SETTINGS = {
  // Converter defaults (shared by backfill + upload-time).
  quality: "quality",
  maxDimension: "maxDimension",
  losslessPngAlphaUnder: "losslessPngAlphaUnder",
  // Video (WebM/VP9) converter — backfill only.
  videoQuality: "videoQuality",
  // Audio (Ogg/Opus) converter — backfill only.
  audioQuality: "audioQuality",
  // Upload-time auto-optimize.
  uploadOptimize: "uploadOptimize",
  // Backfill scope toggles.
  includeItems: "includeItems",
  // Media-type toggles (run images-only / video-only / audio-only, etc).
  includeImages: "includeImages",
  includeVideo: "includeVideo",
  includeAudio: "includeAudio",
  // Opt-in: also convert linked media shipped under modules/ and systems/.
  includePackages: "includePackages",
};

/** Source-image extensions we convert to WebP. Lower-case, no dot. */
export const CONVERTIBLE_EXTENSIONS = ["png", "jpg", "jpeg"];

/**
 * Source-video extensions we convert to WebM/VP9. All ISO-BMFF (MP4 family) so
 * the mp4box demuxer can read them. Lower-case, no dot.
 */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov"];

/**
 * Source-audio extensions we convert to Ogg/Opus. Decoded via the browser's
 * decodeAudioData (no demuxer needed). `ogg`/`opus` are deliberately excluded —
 * they're already the target format. Lower-case, no dot.
 */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "aac"];

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
