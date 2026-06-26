/**
 * Storage-backend resolution.
 *
 * A document image reference can live on different FilePicker backends:
 *  - `data`     — local user-data, stored as a relative path ("worlds/…").
 *  - `forgevtt` — The Forge Assets Library, stored as a full
 *                 `https://assets.forge-vtt.com/<userKey>/…` URL.
 *  - `s3`       — an AWS S3 bucket, stored as a full bucket URL.
 *
 * The optimizer needs three things for any reference: which FilePicker source
 * to browse/upload through, the backend-relative directory (browse/upload want
 * a path relative to that backend's root, never the full URL), and the
 * stored-form `.webp` twin (used both to repoint the document and to test
 * twin-existence, since `browse` returns paths in the same stored form).
 *
 * This module centralizes every assumption about non-`data` backends so the
 * rest of the pipeline stays backend-agnostic and just carries a resolved
 * {@link Loc} on each file job.
 */

import { CONVERTIBLE_EXTENSIONS, warn } from "./constants.mjs";
import { dirOf, extensionOf, fileOf, stripQuery, webpTwin } from "./paths.mjs";

/**
 * Top-level data-dir segments owned by core or by packages. Files under these
 * are shipped assets that get overwritten on update — never optimize them.
 * (Only applies to the local `data` backend; URLs are matched by host.)
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

/** assets.forge-vtt.com and any subdomain of forge-vtt.com. */
const FORGE_HOST = /(^|\.)forge-vtt\.com$/i;
/** Virtual-hosted or path-style AWS S3 endpoints. */
const S3_HOST = /\.amazonaws\.com$/i;

/**
 * @typedef {Object} Loc
 * @property {"data"|"forgevtt"|"s3"} source  FilePicker source string.
 * @property {string|null} bucket             S3 bucket, else null.
 * @property {string} src                     Stored reference, query-stripped (fetch key + dedupe key).
 * @property {string} twin                    Stored-form `.webp` twin (repoint value).
 * @property {string} twinKey                 Decoded, query-stripped twin (browse-membership test).
 * @property {string} browseDir              Backend-relative directory (browse/upload), decoded.
 * @property {string} uploadName             Target `.webp` filename, decoded.
 */

/**
 * Coarse, synchronous classifier used during discovery to decide whether a
 * reference is even a candidate. Precise backend mapping (and Forge ownership)
 * happens later in {@link StorageResolver.resolve}.
 *
 * @param {unknown} src
 * @returns {"data"|"forgevtt"|"s3"|null}
 */
export function classify(src) {
  if (typeof src !== "string" || src.length === 0) return null;
  if (src.startsWith("data:")) return null;

  const clean = stripQuery(src);
  if (!CONVERTIBLE_EXTENSIONS.includes(extensionOf(clean))) return null;

  if (/^(https?:)?\/\//i.test(clean)) {
    let host;
    try {
      host = new URL(clean, "https://x").hostname;
    } catch {
      return null;
    }
    if (FORGE_HOST.test(host)) return "forgevtt";
    if (S3_HOST.test(host)) return "s3";
    return null; // genuinely external URL — leave alone
  }

  const root = clean.replace(/^\/+/, "").split("/")[0]?.toLowerCase();
  if (PROTECTED_ROOTS.has(root)) return null;
  return "data";
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
    const kind = classify(src);
    if (!kind) return null;
    if (kind === "data") return this.#data(src);
    if (kind === "forgevtt") return this.#forge(src);
    if (kind === "s3") return this.#s3(src);
    return null;
  }

  #data(src) {
    const key = stripQuery(src);
    return this.#loc("data", null, key, key);
  }

  #forge(src) {
    if (!this.forgePrefix) {
      return { skip: "The Forge is not active for this session." };
    }
    const key = stripQuery(src);
    if (!key.startsWith(this.forgePrefix)) {
      // Bazaar, shared, or another user's library: we can't write a twin there.
      return { skip: "Forge asset outside your Assets Library (read-only)." };
    }
    const rel = key.slice(this.forgePrefix.length);
    return this.#loc("forgevtt", null, key, rel);
  }

  #s3(src) {
    const parsed = parseS3(src);
    if (!parsed) return { skip: "Unrecognized S3 URL shape." };
    return this.#loc("s3", parsed.bucket, stripQuery(src), parsed.key);
  }

  /**
   * Assemble a Loc. `storedKey` is the reference as stored (URL for remote
   * backends, relative path for data); `relPath` is the same file expressed
   * relative to the backend root (what browse/upload expect).
   */
  #loc(source, bucket, storedKey, relPath) {
    const twin = webpTwin(storedKey);
    return {
      source,
      bucket,
      src: storedKey,
      twin,
      twinKey: decodeURIComponent(stripQuery(twin)),
      browseDir: decodeURIComponent(dirOf(relPath)),
      uploadName: decodeURIComponent(fileOf(webpTwin(relPath))),
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
