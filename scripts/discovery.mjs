/**
 * Reference discovery: walk world documents and collect every editable image
 * path, tagged with the document + field it lives in so it can be repointed
 * after conversion.
 *
 * We collect *field references*, not files. One file may be referenced by many
 * fields; the optimizer deduplicates files for conversion and updates every
 * field that pointed at the original.
 */

import { isEditableImage, isWildcard } from "./paths.mjs";

/**
 * @typedef {Object} FieldRef
 * @property {foundry.abstract.Document} doc   Document to update.
 * @property {string}  field    Dot-path of the image field within `doc`.
 * @property {string}  src      Current value (may be a wildcard pattern).
 * @property {string}  label    Human-readable location for the report.
 * @property {boolean} wildcard Whether `src` is a "*" pattern.
 * @property {boolean} html     True for rich-text fields holding many <img> srcs.
 * @property {string[]} [embedded] For html refs: the editable srcs found inside.
 */

/**
 * @typedef {Object} DiscoverOptions
 * @property {boolean} scenes       Walk scene backgrounds, tiles, tokens, etc.
 * @property {boolean} actors       Walk actor + prototype-token art.
 * @property {boolean} journal      Walk journal image pages + embedded images.
 * @property {boolean} includeItems Walk world + actor-owned item images.
 */

/**
 * Collect all editable image references from the loaded world.
 *
 * @param {DiscoverOptions} options
 * @returns {FieldRef[]}
 */
export function discoverRefs({
  scenes = true,
  actors = true,
  journal = true,
  includeItems = false,
} = {}) {
  /** @type {FieldRef[]} */
  const refs = [];

  if (scenes) for (const scene of game.scenes) collectScene(scene, refs);
  if (actors) for (const actor of game.actors) collectActor(actor, refs, includeItems);
  if (journal) for (const entry of game.journal) collectJournal(entry, refs);
  if (includeItems) {
    for (const item of game.items) collectItemImg(item, `Item "${item.name}"`, refs);
  }

  return refs;
}

function collectScene(scene, refs) {
  const name = `Scene "${scene.name}"`;
  pushField(refs, scene, "background.src", `${name} › background`);
  pushField(refs, scene, "foreground.src", `${name} › foreground`);

  for (const tile of scene.tiles) {
    pushField(refs, tile, "texture.src", `${name} › tile`);
  }
  for (const token of scene.tokens) {
    pushField(refs, token, "texture.src", `${name} › token "${token.name}"`);
  }
  for (const drawing of scene.drawings) {
    pushField(refs, drawing, "texture.src", `${name} › drawing`);
  }
  for (const note of scene.notes) {
    pushField(refs, note, "texture.src", `${name} › map note`);
  }
}

function collectActor(actor, refs, includeItems) {
  const name = `Actor "${actor.name}"`;
  pushField(refs, actor, "img", `${name} › portrait`);
  pushField(refs, actor, "prototypeToken.texture.src", `${name} › prototype token`);
  if (includeItems) {
    for (const item of actor.items) {
      collectItemImg(item, `${name} › item "${item.name}"`, refs);
    }
  }
}

function collectItemImg(item, label, refs) {
  pushField(refs, item, "img", label);
}

function collectJournal(entry, refs) {
  const name = `Journal "${entry.name}"`;
  for (const page of entry.pages) {
    if (page.type === "image") {
      pushField(refs, page, "src", `${name} › page "${page.name}"`);
    } else if (page.type === "text") {
      collectHtmlImages(page, `${name} › page "${page.name}"`, refs);
    }
  }
}

/** Find editable <img src> values embedded in a rich-text page. */
function collectHtmlImages(page, label, refs) {
  const html = page.text?.content;
  if (typeof html !== "string" || !html.includes("<img")) return;

  const embedded = [];
  const rx = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(rx)) {
    const src = decodeHtml(match[1]);
    if (isEditableImage(src) && !embedded.includes(src)) embedded.push(src);
  }
  if (embedded.length === 0) return;

  refs.push({
    doc: page,
    field: "text.content",
    src: html,
    label: `${label} › embedded images`,
    wildcard: false,
    html: true,
    embedded,
  });
}

/** Read a field, validate it, and push a ref if it points at an editable image. */
function pushField(refs, doc, field, label) {
  const src = foundry.utils.getProperty(doc, field);
  if (typeof src !== "string" || src.length === 0) return;
  if (!isEditableImage(src)) return;
  refs.push({ doc, field, src, label, wildcard: isWildcard(src), html: false });
}

function decodeHtml(s) {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
