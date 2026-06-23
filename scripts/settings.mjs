/**
 * Settings registration. Converter defaults are shared by both the backfill UI
 * and the upload-time hook, so changing quality/downscale affects both modes.
 */

import { MODULE_ID, SETTINGS } from "./constants.mjs";

/** Read all converter options as a single ConvertOptions object. */
export function getConvertOptions() {
  return {
    quality: game.settings.get(MODULE_ID, SETTINGS.quality),
    maxDimension: game.settings.get(MODULE_ID, SETTINGS.maxDimension),
    losslessPngAlphaUnder: game.settings.get(MODULE_ID, SETTINGS.losslessPngAlphaUnder),
  };
}

export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);

  reg(SETTINGS.quality, {
    name: "BMO.settings.quality.name",
    hint: "BMO.settings.quality.hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0.3, max: 1, step: 0.05 },
    default: 0.8,
  });

  reg(SETTINGS.maxDimension, {
    name: "BMO.settings.maxDimension.name",
    hint: "BMO.settings.maxDimension.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0, // 0 = no downscale cap
  });

  reg(SETTINGS.losslessPngAlphaUnder, {
    name: "BMO.settings.losslessPngAlphaUnder.name",
    hint: "BMO.settings.losslessPngAlphaUnder.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 512, // small alpha PNGs (tokens/icons) stay lossless under this edge
  });

  reg(SETTINGS.uploadOptimize, {
    name: "BMO.settings.uploadOptimize.name",
    hint: "BMO.settings.uploadOptimize.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  reg(SETTINGS.includeItems, {
    name: "BMO.settings.includeItems.name",
    hint: "BMO.settings.includeItems.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
}
