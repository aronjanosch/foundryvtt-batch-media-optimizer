/**
 * Backfill UI (ApplicationV2). Scan the world, show a dry-run plan with
 * estimated savings, then apply: convert, upload, repoint. Includes a progress
 * bar with cancel and a post-run cleanup report.
 */

import { MODULE_ID } from "../constants.mjs";
import { getConvertOptions } from "../settings.mjs";
import { discoverRefs } from "../discovery.mjs";
import { DirectoryIndex } from "../paths.mjs";
import {
  RunCancelledError,
  buildPlan,
  cleanupReport,
  executeRun,
} from "../optimizer.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class OptimizerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "bmo-optimizer",
    tag: "form",
    classes: ["bmo", "bmo-optimizer"],
    window: {
      title: "BMO.app.title",
      icon: "fa-solid fa-images",
      resizable: true,
    },
    position: { width: 760, height: "auto" },
    actions: {
      scan: OptimizerApp.#onScan,
      apply: OptimizerApp.#onApply,
      cancel: OptimizerApp.#onCancel,
      cleanup: OptimizerApp.#onCleanup,
      reset: OptimizerApp.#onReset,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/optimizer.hbs` },
  };

  /** @type {"idle"|"scanning"|"preview"|"running"|"done"} */
  #phase = "idle";
  /** @type {import("../optimizer.mjs").RunSummary|null} */
  #summary = null;
  /** @type {import("../optimizer.mjs").Progress|null} */
  #progress = null;
  /** Selected options, snapshotted from the form when a run starts. */
  #options = null;
  /** @type {import("../discovery.mjs").FieldRef[]|null} */
  #refs = null;
  /** @type {{src: string, twin: string}[]|null} */
  #orphans = null;
  /** @type {AbortController|null} */
  #abort = null;

  async _prepareContext() {
    const defaults = getConvertOptions();
    const o = this.#options;
    const idle = this.#phase === "idle";
    return {
      phase: this.#phase,
      // Effective form state: snapshot if a run has started, else settings.
      conv: o ? o.convert : defaults,
      checkScenes: o ? o.scenes : true,
      checkActors: o ? o.actors : true,
      checkJournal: o ? o.journal : true,
      checkItems: o ? o.includeItems : game.settings.get(MODULE_ID, "includeItems"),
      progress: this.#progress,
      summary: this.#summary ? this.#viewSummary(this.#summary) : null,
      orphans: this.#orphans,
      busy: this.#phase === "scanning" || this.#phase === "running",
    };
  }

  /** Shape a RunSummary into display-ready rows + formatted totals. */
  #viewSummary(s) {
    const rows = s.files
      .map((f) => ({
        src: f.src,
        status: f.status,
        source: formatBytes(f.sourceBytes),
        output: formatBytes(f.outputBytes),
        saved:
          f.sourceBytes && f.outputBytes
            ? Math.round((1 - f.outputBytes / f.sourceBytes) * 100)
            : null,
        error: f.error ?? null,
      }))
      .sort((a, b) => (b.saved ?? -1) - (a.saved ?? -1))
      .map((r) => ({ ...r, savedLabel: r.saved === null ? "—" : `${r.saved}%` }));
    return {
      ...s,
      rows,
      sourceBytesH: formatBytes(s.sourceBytes),
      outputBytesH: formatBytes(s.outputBytes),
      savedBytesH: formatBytes(s.savedBytes),
      savedPct: s.sourceBytes ? Math.round((s.savedBytes / s.sourceBytes) * 100) : 0,
    };
  }

  /** Read the scope/quality form controls into a plain options object. */
  #readForm() {
    const fd = new foundry.applications.ux.FormDataExtended(this.element).object;
    return {
      scenes: !!fd.scenes,
      actors: !!fd.actors,
      journal: !!fd.journal,
      includeItems: !!fd.includeItems,
      convert: {
        quality: Number(fd.quality),
        maxDimension: Number(fd.maxDimension),
        losslessPngAlphaUnder: Number(fd.losslessPngAlphaUnder),
      },
    };
  }

  #render() {
    return this.render({ parts: ["main"] });
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                            */
  /* ------------------------------------------------------------------ */

  static async #onScan() {
    this.#options = this.#readForm();
    this.#phase = "scanning";
    this.#summary = null;
    this.#orphans = null;
    this.#progress = null;
    await this.#render();

    try {
      this.#refs = discoverRefs(this.#options);
      const dirIndex = new DirectoryIndex("data");
      const plan = await buildPlan(this.#refs, { dirIndex });
      this.#summary = await executeRun(plan, {
        dryRun: true,
        source: "data",
        convert: this.#options.convert,
        dirIndex,
        onProgress: (p) => this.#tick(p),
      });
      this.#phase = "preview";
    } catch (err) {
      this.#fail(err);
    }
    this.#progress = null;
    await this.#render();
  }

  static async #onApply() {
    if (!this.#refs || !this.#options) return;

    const ok = await DialogV2.confirm({
      window: { title: game.i18n.localize("BMO.app.confirmTitle") },
      content: `<p>${game.i18n.localize("BMO.app.confirmBody")}</p>`,
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;

    this.#phase = "running";
    this.#abort = new AbortController();
    await this.#render();

    try {
      // Rebuild against current disk state so the run stays idempotent even if
      // something changed since the dry-run preview.
      const dirIndex = new DirectoryIndex("data");
      const plan = await buildPlan(this.#refs, { dirIndex });
      this.#summary = await executeRun(plan, {
        dryRun: false,
        source: "data",
        convert: this.#options.convert,
        dirIndex,
        onProgress: (p) => this.#tick(p),
        signal: this.#abort.signal,
      });
      this.#phase = "done";
      ui.notifications.info(
        game.i18n.format("BMO.app.applyDone", {
          n: this.#summary.converted,
          saved: formatBytes(this.#summary.savedBytes),
        }),
      );
    } catch (err) {
      if (err instanceof RunCancelledError) {
        ui.notifications.warn(game.i18n.localize("BMO.app.cancelled"));
        this.#phase = "preview";
      } else {
        this.#fail(err);
        this.#phase = "preview";
      }
    }
    this.#abort = null;
    this.#progress = null;
    await this.#render();
  }

  static async #onCancel() {
    this.#abort?.abort();
  }

  static async #onCleanup() {
    this.#phase = "scanning";
    await this.#render();
    try {
      const refs = discoverRefs(this.#options ?? {});
      const dirIndex = new DirectoryIndex("data");
      // Prime the index with every directory the refs live in.
      await buildPlan(refs, { dirIndex });
      this.#orphans = await cleanupReport(refs, dirIndex);
    } catch (err) {
      this.#fail(err);
    }
    this.#phase = this.#summary ? "done" : "preview";
    await this.#render();
  }

  static async #onReset() {
    this.#phase = "idle";
    this.#summary = null;
    this.#orphans = null;
    this.#progress = null;
    await this.#render();
  }

  /* ------------------------------------------------------------------ */

  #tick(p) {
    const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
    this.#progress = { ...p, pct };
    // Re-render the part so the progress bar advances; form is disabled while busy.
    this.render({ parts: ["main"] });
  }

  #fail(err) {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error(game.i18n.format("BMO.app.error", { msg: err?.message ?? err }));
    this.#phase = this.#summary ? "preview" : "idle";
  }
}

/** Human-readable byte size. */
export function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
