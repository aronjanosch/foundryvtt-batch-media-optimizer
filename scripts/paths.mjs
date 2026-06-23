/**
 * Path helpers: which sources we may touch, WebP-twin naming, and a cached
 * directory browser used to skip files already converted.
 *
 * All filesystem access goes through Foundry's FilePicker (v14 namespace) so
 * we never read the disk directly.
 */

import { CONVERTIBLE_EXTENSIONS } from "./constants.mjs";

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
 * True if `src` is a local, editable, convertible image we are allowed to
 * rewrite. Rejects remote URLs, data URIs, package/core assets and
 * non-image extensions.
 *
 * @param {unknown} src
 * @returns {boolean}
 */
export function isEditableImage(src) {
  if (typeof src !== "string" || src.length === 0) return false;
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:")) return false;

  const clean = stripQuery(src);
  const ext = extensionOf(clean);
  if (!CONVERTIBLE_EXTENSIONS.includes(ext)) return false;

  const root = clean.replace(/^\/+/, "").split("/")[0]?.toLowerCase();
  if (PROTECTED_ROOTS.has(root)) return false;

  return true;
}

/** Lower-case extension without the dot, or "" if none. */
export function extensionOf(src) {
  const base = stripQuery(src).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The `.webp` sibling path for a source path, preserving any query string. */
export function webpTwin(src) {
  const [path, query] = splitQuery(src);
  const dot = path.lastIndexOf(".");
  const base = dot === -1 ? path : path.slice(0, dot);
  return `${base}.webp${query}`;
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

  /** True if `path`'s WebP twin already exists on disk. */
  async twinExists(path) {
    const twin = stripQuery(webpTwin(path));
    const files = await this.list(dirOf(twin));
    return files.has(decodeURIComponent(twin));
  }

  /** Expand a wildcard pattern to the concrete convertible files it matches. */
  async expandWildcard(pattern) {
    const dir = dirOf(pattern);
    const files = await this.list(dir);
    const rx = wildcardRegex(pattern);
    return [...files].filter((f) => rx.test(f) && isEditableImage(f));
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
