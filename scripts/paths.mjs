/**
 * Path helpers: which sources we may touch, optimized-twin naming, and a cached
 * directory browser used to skip files already converted.
 *
 * A source's twin extension depends on its media kind: images become `.webp`,
 * videos `.webm`, audio `.ogg`. `mediaKindOf` is the single source of truth and
 * the rest of the module branches on its result.
 *
 * All filesystem access goes through Foundry's FilePicker (v14 namespace) so
 * we never read the disk directly.
 */

import { CONVERTIBLE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from "./constants.mjs";

/** v14: the global FilePicker was removed; use the namespaced implementation. */
export function getFilePicker() {
  return foundry.applications.apps.FilePicker.implementation;
}

/**
 * Top-level data-dir segments owned by core or by packages. Files under these
 * are shipped assets that get overwritten on update — never optimize them.
 */
const PROTECTED_ROOTS = new Set([
  "modules",
  "systems",
  "icons",
  "ui",
  "cards",
  "fonts",
  "sounds",
  "css",
  "lang",
  "packs",
  "scripts",
]);

/**
 * Classify a src as convertible "image", "video", "audio", or null (not ours to
 * touch). Rejects remote URLs, data URIs, package/core assets, unknown exts.
 *
 * @param {unknown} src
 * @returns {"image"|"video"|"audio"|null}
 */
export function mediaKindOf(src) {
  if (typeof src !== "string" || src.length === 0) return null;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) return null;

  const clean = stripQuery(src);
  const ext = extensionOf(clean);
  const kind = CONVERTIBLE_EXTENSIONS.includes(ext)
    ? "image"
    : VIDEO_EXTENSIONS.includes(ext)
      ? "video"
      : AUDIO_EXTENSIONS.includes(ext)
        ? "audio"
        : null;
  if (!kind) return null;

  const root = clean.replace(/^\/+/, "").split("/")[0]?.toLowerCase();
  if (PROTECTED_ROOTS.has(root)) return null;

  return kind;
}

/** True if `src` is a local, editable image (png/jpg) we may rewrite to WebP. */
export function isEditableImage(src) {
  return mediaKindOf(src) === "image";
}

/** True if `src` is a local, editable video (mp4 family) we may rewrite to WebM. */
export function isEditableVideo(src) {
  return mediaKindOf(src) === "video";
}

/** True if `src` is local, editable audio (mp3/wav/...) we may rewrite to Ogg. */
export function isEditableAudio(src) {
  return mediaKindOf(src) === "audio";
}

/** True if `src` is any editable media (image, video, or audio). */
export function isEditableMedia(src) {
  return mediaKindOf(src) !== null;
}

/** Lower-case extension without the dot, or "" if none. */
export function extensionOf(src) {
  const base = stripQuery(src).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The optimized output extension (no dot) for a given media kind. */
export function twinExtension(kind) {
  if (kind === "video") return "webm";
  if (kind === "audio") return "ogg";
  return "webp";
}

/**
 * The optimized sibling path for a source path, preserving any query string.
 * Images get a `.webp` twin, videos `.webm`, audio `.ogg`; the kind is derived
 * from the source extension so callers don't have to pass it.
 */
export function twinOf(src) {
  const [path, query] = splitQuery(src);
  const dot = path.lastIndexOf(".");
  const base = dot === -1 ? path : path.slice(0, dot);
  return `${base}.${twinExtension(mediaKindOf(path) ?? "image")}${query}`;
}

/** Directory portion of a path (no trailing slash, no filename). */
export function dirOf(src) {
  const path = stripQuery(src);
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Filename portion of a path, query stripped. */
export function fileOf(src) {
  return stripQuery(src).split("/").pop() ?? "";
}

/** Whether a stored src is a wildcard pattern (e.g. "tokens/orc-*.png"). */
export function isWildcard(src) {
  return typeof src === "string" && src.includes("*");
}

function splitQuery(src) {
  const q = src.indexOf("?");
  return q === -1 ? [src, ""] : [src.slice(0, q), src.slice(q)];
}

/** Drop any `?query` suffix from a path. */
export function stripQuery(src) {
  return splitQuery(src)[0];
}

/**
 * Browse a directory once and cache the result for the run. Returns the set of
 * decoded file paths present, so twin-existence checks are O(1) and we never
 * re-hit the server for the same folder.
 */
export class DirectoryIndex {
  /** @param {string} source FilePicker source, e.g. "data". */
  constructor(source = "data") {
    this.source = source;
    /** @type {Map<string, Promise<Set<string>>>} */
    this._dirs = new Map();
  }

  /**
   * @param {string} dir Directory path (no filename).
   * @returns {Promise<Set<string>>} Decoded file paths in that directory.
   */
  async list(dir) {
    if (!this._dirs.has(dir)) {
      this._dirs.set(dir, this._browse(dir));
    }
    return this._dirs.get(dir);
  }

  async _browse(dir) {
    try {
      const result = await getFilePicker().browse(this.source, dir);
      return new Set((result.files ?? []).map((f) => decodeURIComponent(f)));
    } catch (err) {
      // Missing dir or denied access: treat as empty so callers proceed safely.
      return new Set();
    }
  }

  /** True if `path`'s optimized twin (.webp/.webm) already exists on disk. */
  async twinExists(path) {
    const twin = stripQuery(twinOf(path));
    const files = await this.list(dirOf(twin));
    return files.has(decodeURIComponent(twin));
  }

  /** Expand a wildcard pattern to the concrete convertible files it matches. */
  async expandWildcard(pattern) {
    const dir = dirOf(pattern);
    const files = await this.list(dir);
    const rx = wildcardRegex(pattern);
    return [...files].filter((f) => rx.test(f) && isEditableMedia(f));
  }

  /** Drop a directory from the cache so a re-list reflects new uploads. */
  invalidate(dir) {
    this._dirs.delete(dir);
  }
}

/** Build a RegExp matching a Foundry "*"-style wildcard path. */
function wildcardRegex(pattern) {
  const escaped = stripQuery(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}
