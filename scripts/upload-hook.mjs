/**
 * Upload-time auto-optimize. Foundry has no `preUpload` hook, so we wrap the
 * static `FilePicker.upload` (v14 namespace). Every image uploaded through
 * Foundry's API is converted to WebP before it hits disk, reusing the same
 * converter + settings as the backfill tool.
 *
 * The wrapper checks the toggle at call time, so enabling/disabling the setting
 * takes effect immediately without re-installing.
 */

import { MODULE_ID, SETTINGS, warn, log } from "./constants.mjs";
import { getConvertOptions } from "./settings.mjs";
import { getFilePicker } from "./paths.mjs";
import { convertToWebp } from "./converter.mjs";

/** Original static method, captured so we can delegate (and uninstall). */
let originalUpload = null;

export function installUploadHook() {
  const FilePicker = getFilePicker();
  if (originalUpload) return; // idempotent
  originalUpload = FilePicker.upload.bind(FilePicker);

  FilePicker.upload = async function bmoUpload(source, path, file, body = {}, options = {}) {
    let outgoing = file;
    try {
      if (game.settings.get(MODULE_ID, SETTINGS.uploadOptimize) && shouldConvert(file)) {
        const converted = await convertUpload(file);
        if (converted) outgoing = converted;
      }
    } catch (err) {
      // Never block a user's upload because optimization failed.
      warn("Upload-time optimize failed; uploading original.", err);
      outgoing = file;
    }
    return originalUpload(source, path, outgoing, body, options);
  };

  log("Upload-time optimize hook installed.");
}

export function uninstallUploadHook() {
  if (!originalUpload) return;
  getFilePicker().upload = originalUpload;
  originalUpload = null;
}

/** Only convert raster images we can improve; pass WebP/SVG/audio/etc through. */
function shouldConvert(file) {
  return file instanceof File && /^image\/(png|jpeg)$/i.test(file.type ?? "");
}

/** Convert an uploaded File to a WebP File, or null if it wouldn't help. */
async function convertUpload(file) {
  const result = await convertToWebp(file, getConvertOptions());
  if (result.outputBytes >= file.size) return null; // would bloat — keep original
  const name = file.name.replace(/\.(png|jpe?g)$/i, ".webp");
  return new File([result.blob], name, { type: "image/webp", lastModified: file.lastModified });
}
