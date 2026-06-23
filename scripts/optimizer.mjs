/**
 * Optimization engine. Turns discovered field references into a plan, then
 * executes it: convert each unique source file to WebP, upload the twin via
 * Foundry's API, and repoint every referencing document field.
 *
 * Safety properties:
 *  - Dry-run converts in memory and reports real byte savings without writing.
 *  - Idempotent: files whose `.webp` twin already exists are skipped but still
 *    repointed, so re-running finishes a partially-completed run.
 *  - Originals are never deleted (Foundry exposes no file-delete API). Cleanup
 *    is a report of now-unreferenced originals for manual removal.
 */

import { convertToWebp } from "./converter.mjs";
import { dirOf, fileOf, getFilePicker, stripQuery, webpTwin } from "./paths.mjs";
import { log, warn } from "./constants.mjs";

/**
 * @typedef {Object} FileJob
 * @property {string}  src         Query-stripped source path (the conversion key).
 * @property {string}  webpSrc     Target `.webp` path.
 * @property {string}  dir         Directory for upload.
 * @property {string}  file        Target filename (decoded).
 * @property {boolean} twinExists  Twin already on disk before this run.
 * @property {string}  status      pending|uploaded|converted-dry|skipped-existing|error
 * @property {number}  sourceBytes
 * @property {number}  outputBytes
 * @property {string=} error
 */

/**
 * @typedef {Object} ResolvedRef
 * @property {import("./discovery.mjs").FieldRef} ref
 * @property {string[]} fileSrcs  Query-stripped source files this ref depends on.
 * @property {"normal"|"wildcard"|"html"} kind
 */

/**
 * @typedef {Object} Plan
 * @property {FileJob[]}     files
 * @property {ResolvedRef[]} refs
 * @property {{label: string, src: string, reason: string}[]} skipped
 */

/**
 * Build an execution plan from discovered refs. Deduplicates files, expands
 * wildcard token paths, and flags files whose twin already exists.
 *
 * @param {import("./discovery.mjs").FieldRef[]} refs
 * @param {{dirIndex: DirectoryIndex}} ctx
 * @returns {Promise<Plan>}
 */
export async function buildPlan(refs, { dirIndex }) {
  /** @type {Map<string, FileJob>} */
  const fileMap = new Map();
  const resolved = [];
  const skipped = [];

  const ensureFile = (src) => {
    const key = stripQuery(src);
    let job = fileMap.get(key);
    if (!job) {
      job = {
        src: key,
        webpSrc: webpTwin(key),
        dir: decodeURIComponent(dirOf(key)),
        file: decodeURIComponent(fileOf(webpTwin(key))),
        twinExists: false,
        status: "pending",
        sourceBytes: 0,
        outputBytes: 0,
      };
      fileMap.set(key, job);
    }
    return job;
  };

  for (const ref of refs) {
    if (ref.html) {
      const fileSrcs = ref.embedded.map(stripQuery);
      fileSrcs.forEach(ensureFile);
      resolved.push({ ref, fileSrcs, kind: "html" });
    } else if (ref.wildcard) {
      const matched = await dirIndex.expandWildcard(ref.src);
      if (matched.length === 0) {
        skipped.push({ label: ref.label, src: ref.src, reason: "wildcard matched no files" });
        continue;
      }
      const fileSrcs = matched.map(stripQuery);
      fileSrcs.forEach(ensureFile);
      resolved.push({ ref, fileSrcs, kind: "wildcard" });
    } else {
      const key = stripQuery(ref.src);
      ensureFile(key);
      resolved.push({ ref, fileSrcs: [key], kind: "normal" });
    }
  }

  // Twin-existence probes, in parallel per unique file.
  await Promise.all(
    [...fileMap.values()].map(async (job) => {
      job.twinExists = await dirIndex.twinExists(job.src);
    }),
  );

  return { files: [...fileMap.values()], refs: resolved, skipped };
}

/**
 * @typedef {Object} RunOptions
 * @property {boolean}  dryRun
 * @property {string}   source        FilePicker source ("data").
 * @property {Object}   convert       ConvertOptions for the converter.
 * @property {DirectoryIndex} dirIndex
 * @property {(p: Progress) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} Progress
 * @property {"convert"|"repoint"} phase
 * @property {number} current
 * @property {number} total
 * @property {string} label
 */

export class RunCancelledError extends Error {}

/**
 * Execute a plan. On dry-run, files are fetched + converted in memory to
 * measure savings, and document writes are computed but not performed.
 *
 * @param {Plan} plan
 * @param {RunOptions} options
 * @returns {Promise<RunSummary>}
 */
export async function executeRun(plan, options) {
  const { dryRun, source, convert, dirIndex, onProgress, signal } = options;

  await convertFiles(plan.files, { dryRun, source, convert, dirIndex, onProgress, signal });

  const repoint = planRepoint(plan);
  if (!dryRun) {
    await applyRepoint(repoint, { onProgress, signal });
  }

  return summarize(plan, repoint);
}

/** Convert (and on a live run, upload) every non-skipped file in the plan. */
async function convertFiles(files, { dryRun, source, convert, dirIndex, onProgress, signal }) {
  const total = files.length;
  let current = 0;
  for (const job of files) {
    throwIfAborted(signal);
    current += 1;
    onProgress?.({ phase: "convert", current, total, label: job.src });

    if (job.twinExists) {
      job.status = "skipped-existing";
      continue;
    }

    try {
      const resp = await fetch(job.src);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const blob = await resp.blob();
      job.sourceBytes = blob.size;

      const result = await convertToWebp(blob, convert);
      job.outputBytes = result.outputBytes;

      // Don't write a twin bigger than its source — pointless and lossy.
      if (result.outputBytes >= blob.size) {
        job.status = "skipped-larger";
        continue;
      }

      if (dryRun) {
        job.status = "converted-dry";
      } else {
        const file = new File([result.blob], job.file, { type: "image/webp" });
        await getFilePicker().upload(source, job.dir, file, {}, { notify: false });
        dirIndex.invalidate(dirOf(stripQuery(job.webpSrc)));
        job.status = "uploaded";
      }
    } catch (err) {
      job.status = "error";
      job.error = err?.message ?? String(err);
      warn(`Convert failed: ${job.src}`, err);
    }
  }
}

/**
 * True once the source file is guaranteed to have a usable WebP twin.
 * "converted-dry" is included so the dry-run preview reports the projected
 * document-update count; on a live run that status never occurs (files upload).
 */
function fileAvailable(job) {
  return (
    job &&
    (job.status === "uploaded" ||
      job.status === "skipped-existing" ||
      job.status === "converted-dry")
  );
}

/**
 * Compute the document writes for a plan. A ref is only repointed when every
 * source file it depends on has an available twin (so wildcards flip only when
 * all matched files converted).
 *
 * @param {Plan} plan
 * @returns {DocUpdate[]}
 */
function planRepoint(plan) {
  const jobBySrc = new Map(plan.files.map((j) => [j.src, j]));
  /** @type {Map<string, DocUpdate>} */
  const byDoc = new Map();

  for (const { ref, fileSrcs, kind } of plan.refs) {
    const jobs = fileSrcs.map((s) => jobBySrc.get(s));
    const ready = jobs.filter(fileAvailable);
    if (ready.length === 0) continue; // nothing converted for this ref yet

    let newValue;
    if (kind === "html") {
      newValue = rewriteHtml(ref.src, ref.embedded, jobBySrc);
      if (newValue === ref.src) continue; // no embedded image became available
    } else {
      // normal + wildcard both: swap the extension, keep any query string.
      if (jobs.some((j) => !fileAvailable(j))) continue; // partial wildcard: wait
      newValue = webpTwin(ref.src);
      if (newValue === ref.src) continue;
    }

    const key = ref.doc.uuid;
    let entry = byDoc.get(key);
    if (!entry) {
      entry = { doc: ref.doc, changes: {}, labels: [] };
      byDoc.set(key, entry);
    }
    entry.changes[ref.field] = newValue;
    entry.labels.push(ref.label);
  }

  return [...byDoc.values()];
}

/** Replace each available embedded image src in rich-text content with its twin. */
function rewriteHtml(content, embedded, jobBySrc) {
  let out = content;
  for (const src of embedded) {
    const job = jobBySrc.get(stripQuery(src));
    if (!fileAvailable(job)) continue;
    const twin = webpTwin(src);
    for (const variant of [src, encodeHtml(src)]) {
      out = out.split(variant).join(variant === src ? twin : encodeHtml(twin));
    }
  }
  return out;
}

/**
 * @typedef {Object} DocUpdate
 * @property {foundry.abstract.Document} doc
 * @property {Object} changes
 * @property {string[]} labels
 */

/** Apply document writes, one update call per document (transactional per doc). */
async function applyRepoint(updates, { onProgress, signal }) {
  const total = updates.length;
  let current = 0;
  for (const u of updates) {
    throwIfAborted(signal);
    current += 1;
    onProgress?.({ phase: "repoint", current, total, label: u.doc.uuid });
    try {
      await u.doc.update(u.changes);
      u.ok = true;
    } catch (err) {
      u.ok = false;
      u.error = err?.message ?? String(err);
      warn(`Repoint failed: ${u.doc.uuid}`, err);
    }
  }
}

/**
 * @typedef {Object} RunSummary
 * @property {number} fileCount
 * @property {number} converted
 * @property {number} skippedExisting
 * @property {number} skippedLarger
 * @property {number} errors
 * @property {number} sourceBytes
 * @property {number} outputBytes
 * @property {number} savedBytes
 * @property {number} docUpdates
 * @property {FileJob[]} files
 * @property {DocUpdate[]} repoint
 */
function summarize(plan, repoint) {
  let converted = 0;
  let skippedExisting = 0;
  let skippedLarger = 0;
  let errors = 0;
  let sourceBytes = 0;
  let outputBytes = 0;

  for (const job of plan.files) {
    if (job.status === "skipped-existing") skippedExisting += 1;
    else if (job.status === "skipped-larger") skippedLarger += 1;
    else if (job.status === "error") errors += 1;
    else if (job.status === "uploaded" || job.status === "converted-dry") {
      converted += 1;
      sourceBytes += job.sourceBytes;
      outputBytes += job.outputBytes;
    }
  }

  return {
    fileCount: plan.files.length,
    converted,
    skippedExisting,
    skippedLarger,
    errors,
    sourceBytes,
    outputBytes,
    savedBytes: Math.max(0, sourceBytes - outputBytes),
    docUpdates: repoint.length,
    files: plan.files,
    repoint,
  };
}

/**
 * Cleanup report: list original files that now have a WebP twin and are no
 * longer referenced by any document. Foundry has no file-delete API, so this
 * returns paths for the GM to remove manually rather than deleting them.
 *
 * @param {import("./discovery.mjs").FieldRef[]} liveRefs Current world refs.
 * @param {DirectoryIndex} dirIndex
 * @returns {Promise<{src: string, twin: string}[]>}
 */
export async function cleanupReport(liveRefs, dirIndex) {
  // Every source path still referenced after optimization. DirectoryIndex
  // stores decoded paths, so normalize to decoded form for comparison.
  const referenced = new Set();
  const mark = (s) => referenced.add(decodeURIComponent(stripQuery(s)));
  for (const ref of liveRefs) {
    if (ref.html) ref.embedded.forEach(mark);
    else if (ref.wildcard) (await dirIndex.expandWildcard(ref.src)).forEach(mark);
    else mark(ref.src);
  }

  // Anything referenced that is itself a non-webp original with a twin is an
  // orphan candidate only once the doc no longer points at it — i.e. it is NOT
  // in `referenced`. So we scan the directories we know about for originals
  // whose twin exists but which are absent from `referenced`.
  const orphans = [];
  const seenDirs = new Set();
  for (const src of dirIndex._dirs.keys()) seenDirs.add(src);

  for (const dir of seenDirs) {
    const files = await dirIndex.list(dir);
    for (const f of files) {
      if (/\.webp$/i.test(f)) continue;
      if (referenced.has(f)) continue;
      if (await dirIndex.twinExists(f)) orphans.push({ src: f, twin: webpTwin(f) });
    }
  }
  log(`Cleanup report: ${orphans.length} orphaned originals.`);
  return orphans;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new RunCancelledError("Run cancelled by user.");
}

function encodeHtml(s) {
  return s.replaceAll("&", "&amp;");
}
