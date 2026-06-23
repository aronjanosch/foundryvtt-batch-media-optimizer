/**
 * Module entry point. Registers settings + the backfill menu on init, and on
 * ready (GM only) installs the upload-time hook and exposes a small API for
 * macros: `game.modules.get("batch-media-optimizer").api.open()`.
 */

import { MODULE_ID, log } from "./constants.mjs";
import { registerSettings } from "./settings.mjs";
import { OptimizerApp } from "./apps/optimizer-app.mjs";
import { installUploadHook } from "./upload-hook.mjs";

Hooks.once("init", () => {
  registerSettings();

  game.settings.registerMenu(MODULE_ID, "openOptimizer", {
    name: "BMO.menu.name",
    label: "BMO.menu.label",
    hint: "BMO.menu.hint",
    icon: "fa-solid fa-images",
    type: OptimizerApp,
    restricted: true,
  });

  log("Initialized.");
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  installUploadHook();

  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    open: () => new OptimizerApp().render(true),
    OptimizerApp,
  };
});
