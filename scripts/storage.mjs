/**
 * Storage-backend resolution and the convertible-media gate.
 *
 * A document media reference can live on different FilePicker backends:
 *  - `data`     — local user-data, stored as a relative path ("worlds/…").
 *  - `forgevtt` — The Forge Assets Library, stored as a full
 *                 `https://assets.forge-vtt.com/<userKey>/…` URL.
 *  - `s3`       — an AWS S3 bucket, stored as a full bucket URL.
 *
 * This module is the single source of truth for two questions the rest of the
 * pipeline asks about a reference:
 *  1. Is it ours to convert at all — and if so, what media kind is it
 *     (image → WebP, video → WebM, audio → Ogg)? See {@link classify}.
 *  2. Which backend does it live on, and what are the backend-relative paths to
 *     browse/upload/repoint through? See {@link StorageResolver}.
 *
 * Each file job carries a resolved {@link Loc}, so a single plan can span
 * multiple backends and media kinds.
 */

import { warn } from "./constants.mjs";
import {
  dirOf,
  extensionOf,
  fileOf,
  kindFromExtension,
  stripQuery,
  twinOf,
} from "./paths.mjs";

/**
 * Core Foundry app directories — bundled with the software, not user content.
 * Always skipped; converting them is never useful. (Local `data` backend only;
 * URLs are matched by host.)
 */
const CORE_ROOTS = new Set(["icons", "ui", "cards", "fonts", "sounds", "css", "lang", "packs", "scripts"]);

/**
 * Package directories — assets shipped by modules/systems. Skipped by default
 * (a package update can overwrite the original and remove our twin, breaking the
 * reference), but optionally convertible at the user's risk via `setConvertPackages`.
 */
const PACKAGE_ROOTS = new Set(["modules", "systems"]);

let convertPackages = false;

/**
 * Opt into converting linked media under modules/ and systems/. Module-scoped
 * for the duration of a run; the app sets it from the "module assets" toggle
 * before discovery/plan/cleanup. Off by default.
 */
export function setConvertPackages(enabled) {
  convertPackages = !!enabled;
}

/** assets.forge-vtt.com and any subdomain of forge-vtt.com. */
const FORGE_HOST = /(^|\.)forge-vtt\.com$/i;
/** Virtual-hosted or path-style AWS S3 endpoints. */
const S3_HOST = /\.amazonaws\.com$/i;

/**
 * @typedef {Object} Loc
 * @property {"data"|"forgevtt"|"s3"} source  FilePicker source string.
 * @property {"image"|"video"|"audio"} kind   Media kind (decides converter + twin ext).
 * @property {string|null} bucket             S3 bucket, else null.
 * @property {string} src                     Stored reference, query-stripped (fetch key + dedupe key).
 * @property {string} twin                    Stored-form optimized twin (repoint value).
 * @property {string} twinKey                 Decoded, query-stripped twin (browse-membership test).
 * @property {string} browseDir               Backend-relative directory (browse/upload), decoded.
 * @property {string} uploadName              Target twin filename, decoded.
 */

/**
 * Coarse, synchronous classifier used during discovery to decide whether a
 * reference is even a candidate, and which media kind it is. Precise backend
 * mapping (and Forge ownership) happens later in {@link StorageResolver.resolve}.
 *
 * Returns `null` for data URIs, genuinely external URLs, core/package assets
 * (unless package conversion is enabled), and unknown extensions.
 *
 * @param {unknown} src
 * @returns {{backend: "data"|"forgevtt"|"s3", kind: "image"|"video"|"audio"}|null}
 */
export function classify(src) {
  if (typeof src !== "string" || src.length === 0) return null;
  if (src.startsWith("data:")) return null;

  const clean = stripQuery(src);
  const kind = kindFromExtension(extensionOf(clean));
  if (!kind) return null;

  if (/^(https?:)?\/\//i.test(clean)) {
    let host;
    try {
      host = new URL(clean, "https://x").hostname;
    } catch {
      return null;
    }
    if (FORGE_HOST.test(host)) return { backend: "forgevtt", kind };
    if (S3_HOST.test(host)) return { backend: "s3", kind };
    return null; // genuinely external URL — leave alone
  }

  const root = clean.replace(/^\/+/, "").split("/")[0]?.toLowerCase();
  if (CORE_ROOTS.has(root)) return null;
  if (PACKAGE_ROOTS.has(root) && !convertPackages) return null;
  return { backend: "data", kind };
}

/**
 * Build a resolver for the current session. Async because the Forge asset
 * prefix depends on the logged-in user id. Falls back gracefully when Forge is
 * not active.
 *
 * @returns {Promise<StorageResolver>}
 */
export async function createResolver() {
  let forgePrefix = null;
  const F = globalThis.ForgeVTT;
  if (F?.usingTheForge) {
    try {
      const uid = await globalThis.ForgeAPI?.getUserId?.();
      if (uid) forgePrefix = `${F.ASSETS_LIBRARY_URL_PREFIX}${uid}/`;
    } catch (err) {
      warn("Could not resolve Forge asset prefix; Forge assets will be skipped.", err);
    }
  }
  return new StorageResolver({ forgePrefix });
}

export class StorageResolver {
  /** @param {{forgePrefix: string|null}} opts */
  constructor({ forgePrefix }) {
    this.forgePrefix = forgePrefix;
  }

  /**
   * Resolve a stored reference to a {@link Loc}, or `{skip: reason}` when the
   * reference is recognized but not safely writable (e.g. a Forge asset that
   * isn't in this user's library, or Forge not active).
   *
   * @param {string} src
   * @returns {Loc | {skip: string} | null}
   */
  resolve(src) {
    const c = classify(src);
    if (!c) return null;
    if (c.backend === "data") return this.#data(src, c.kind);
    if (c.backend === "forgevtt") return this.#forge(src, c.kind);
    if (c.backend === "s3") return this.#s3(src, c.kind);
    return null;
  }

  #data(src, kind) {
    const key = stripQuery(src);
    return this.#loc("data", kind, null, key, key);
  }

  #forge(src, kind) {
    if (!this.forgePrefix) {
      return { skip: "The Forge is not active for this session." };
    }
    const key = stripQuery(src);
    if (!key.startsWith(this.forgePrefix)) {
      // Bazaar, shared, or another user's library: we can't write a twin there.
      return { skip: "Forge asset outside your Assets Library (read-only)." };
    }
    const rel = key.slice(this.forgePrefix.length);
    return this.#loc("forgevtt", kind, null, key, rel);
  }

  #s3(src, kind) {
    const parsed = parseS3(src);
    if (!parsed) return { skip: "Unrecognized S3 URL shape." };
    return this.#loc("s3", kind, parsed.bucket, stripQuery(src), parsed.key);
  }

  /**
   * Assemble a Loc. `storedKey` is the reference as stored (URL for remote
   * backends, relative path for data); `relPath` is the same file expressed
   * relative to the backend root (what browse/upload expect).
   */
  #loc(source, kind, bucket, storedKey, relPath) {
    const twin = twinOf(storedKey);
    return {
      source,
      kind,
      bucket,
      src: storedKey,
      twin,
      twinKey: decodeURIComponent(stripQuery(twin)),
      browseDir: decodeURIComponent(dirOf(relPath)),
      uploadName: decodeURIComponent(fileOf(twinOf(relPath))),
    };
  }
}

/**
 * Extract `{bucket, key}` from an S3 URL, supporting both virtual-hosted
 * (`bucket.s3.region.amazonaws.com/key`) and path-style
 * (`s3.region.amazonaws.com/bucket/key`) forms.
 *
 * @param {string} src
 * @returns {{bucket: string, key: string}|null}
 */
function parseS3(src) {
  let u;
  try {
    u = new URL(stripQuery(src), "https://x");
  } catch {
    return null;
  }
  const host = u.hostname;
  const path = u.pathname.replace(/^\/+/, "");
  // Virtual-hosted: "<bucket>.s3" or "<bucket>.s3.<region>".
  const vh = host.match(/^(.+?)\.s3[.-]/i);
  if (vh) return { bucket: vh[1], key: decodeURIComponent(path) };
  // Path-style: "s3.<region>.amazonaws.com/<bucket>/<key>".
  if (/^s3[.-]/i.test(host)) {
    const slash = path.indexOf("/");
    if (slash === -1) return null;
    return {
      bucket: decodeURIComponent(path.slice(0, slash)),
      key: decodeURIComponent(path.slice(slash + 1)),
    };
  }
  return null;
}
