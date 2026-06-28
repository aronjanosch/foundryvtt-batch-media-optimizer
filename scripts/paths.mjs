/**
 * Path helpers: optimized-twin naming, query handling, and a cached per-backend
 * directory browser used to skip files already converted.
 *
 * A source's twin extension depends on its media kind: images become `.webp`,
 * videos `.webm`, audio `.ogg`. The kind is derived purely from the file
 * extension here (so it works for any backend, including full URLs); which
 * backend a reference lives on — and whether it is ours to touch — is decided
 * in storage.mjs. This module is purely about path strings and the directory
 * cache.
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
 * Media kind implied by a file extension, ignoring any backend/root rules.
 * Pure string logic, so it is correct for relative paths and full URLs alike.
 *
 * @param {string} ext Lower-case extension without the dot.
 * @returns {"image"|"video"|"audio"|null}
 */
export function kindFromExtension(ext) {
  if (CONVERTIBLE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  return null;
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
  return `${base}.${twinExtension(kindFromExtension(extensionOf(path)) ?? "image")}${query}`;
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
 * Browse directories once per (source, bucket, dir) and cache the result for
 * the run. Returns the set of decoded paths present — in the same stored form
 * the backend reports (relative paths for `data`, full URLs for Forge/S3) — so
 * twin-existence checks are O(1) and we never re-hit the server for a folder.
 */
export class DirectoryIndex {
  constructor() {
    /** @type {Map<string, Promise<Set<string>>>} */
    this._dirs = new Map();
  }

  /** Cache key for a backend directory. */
  static #key(source, bucket, dir) {
    return `${source} ${bucket ?? ""} ${dir}`;
  }

  /**
   * @param {{source: string, bucket: string|null, browseDir: string}} loc
   * @returns {Promise<Set<string>>} Decoded file paths in that directory.
   */
  async list({ source, bucket, browseDir }) {
    const key = DirectoryIndex.#key(source, bucket, browseDir);
    if (!this._dirs.has(key)) {
      this._dirs.set(key, this._browse(source, bucket, browseDir));
    }
    return this._dirs.get(key);
  }

  async _browse(source, bucket, dir) {
    try {
      const options = source === "s3" ? { bucket } : {};
      const result = await getFilePicker().browse(source, dir, options);
      return new Set((result.files ?? []).map((f) => decodeURIComponent(f)));
    } catch (err) {
      // Missing dir or denied access: treat as empty so callers proceed safely.
      return new Set();
    }
  }

  /** True if the resolved location's optimized twin already exists on its backend. */
  async twinExists(loc) {
    const files = await this.list(loc);
    return files.has(loc.twinKey);
  }

  /** Drop a backend directory from the cache so a re-list reflects new uploads. */
  invalidate(loc) {
    this._dirs.delete(DirectoryIndex.#key(loc.source, loc.bucket, loc.browseDir));
  }
}

/** Build a RegExp matching a Foundry "*"-style wildcard path. */
export function wildcardRegex(pattern) {
  const escaped = stripQuery(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}
