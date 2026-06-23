# Foundry VTT Batch Media Optimizer — Roadmap

A Foundry VTT module that optimizes media (scene backgrounds, token/actor art,
journal images) by converting to WebP and optionally downscaling, then
repointing document references. It works in **two modes**:

1. **Backfill** — retroactively optimize media already present in a world.
2. **Upload-time** — auto-convert media as it is uploaded (`preUpload` hook),
   so worlds stay optimized going forward.

This makes both the paid upload-time module and the broken free backfill tool
unnecessary. Upload-time optimizers (e.g. the paid "auto-convert on upload"
module) only handle **future** uploads and never backfill. The known free
alternative (`NearWasTaken/Foundry-VTT-Media-Optimizer`) rewrites flat NeDB
`.db` files via regex and **does not work on Foundry v13+ (LevelDB)**. This
module covers both jobs in one.

## Goals

- **Backfill**: optimize **existing** world media to cut scene/load times.
- **Upload-time**: auto-convert media on upload via `preUpload` hook (on/off,
  shares the same converter + settings as backfill).
- **Version-proof**: never touch the database on disk. All writes go through
  Foundry's own API (`FilePicker.upload`, `Document#update`) so it works on
  v13/v14 LevelDB and beyond.
- **Safe**: dry-run by default for backfill, keep originals, idempotent (skip
  when an optimized twin already exists).
- Images first. Audio/video out of scope for v1.

## Non-Goals (v1)

- Audio (mp3→ogg) / video (→webm) transcoding — needs `ffmpeg.wasm`/WebCodecs.
  Defer to a later phase.
- Optimizing module/system-shipped assets (they get overwritten on update).
  Only operate on files under the **world** dir and the user `assets/` area.
- Editing LevelDB / NeDB on disk. Explicitly rejected — corruption risk and
  version-fragile.

## Architecture

Pure client-side, runs inside an authenticated GM session:

1. **Discover refs** — walk world documents and collect image paths:
   - Scenes: `background.src`, `foreground.src`, tiles (`texture.src`),
     notes (`texture.src`), drawings.
   - Actors: `img`, `prototypeToken.texture.src`; placed Tokens:
     `texture.src` (incl. wildcard `*` token paths).
   - Journal entries/pages: embedded image paths.
   - Optionally: items `img`, playlists (covers) — flag, low priority.
2. **Filter** — keep only paths that live under the world / user data area and
   are convertible (`.png/.jpg/.jpeg`). Skip if a `.webp` twin already exists.
3. **Convert in browser** — load to `OffscreenCanvas` →
   `canvas.toBlob('image/webp', quality)`. Optional downscale to a max-dimension
   cap. Lossless for small PNGs with alpha (configurable threshold); lossy for
   large backgrounds.
4. **Write back** — `FilePicker.upload()` writes the `.webp` next to the
   original (Foundry server handles disk write).
5. **Repoint refs** — `Document#update()` for every collected location.
6. **Originals** — left in place (rename/relocate to a sidecar is a later
   convenience). A separate "cleanup" action removes originals once verified.

## Phases

### Phase 0 — Project setup
- [ ] `module.json` manifest (compatibility v14 / `13.x` minimum, verify exact).
- [ ] Build tooling (esbuild/vite or plain ESM — keep minimal).
- [ ] License (MIT), README, repo scaffolding.

### Phase 1 — Core converter
- [ ] Canvas → WebP converter with quality param.
- [ ] Optional downscale to max-dimension cap.
- [ ] Lossless-for-small-PNG-with-alpha heuristic (configurable).
- [ ] Handle canvas max-dimension limits / huge maps gracefully (skip + warn).

### Phase 2 — Reference discovery
- [ ] Scene refs (background, foreground, tiles, notes, drawings).
- [ ] Actor + token refs (img, prototype, placed tokens, wildcards).
- [ ] Journal image refs.
- [ ] World/user-data path filter + `.webp`-twin skip.

### Phase 3 — Batch run + UI
- [ ] "Optimize world" dialog: target picker, quality, downscale cap, dry-run.
- [ ] Dry-run report: count, estimated savings, per-file plan.
- [ ] Progress UI + cancel.
- [ ] Idempotent re-runs.

### Phase 4 — Backfill apply + cleanup
- [ ] Live run: convert → upload → update refs, transactional per doc.
- [ ] Error handling + per-file skip log.
- [ ] Separate "remove originals" action (post-verify).

### Phase 5 — Upload-time auto-optimize (core)
- [ ] `preUpload` / file-picker hook: intercept image uploads, convert to WebP
      (+ downscale to cap) before write, reusing the Phase 1 converter.
- [ ] Toggle on/off; shares the same quality/downscale settings as backfill.
- [ ] Skip already-WebP / non-image uploads cleanly.
- [ ] Make sure document refs created by the upload point at the `.webp`.

### Phase 6 — Settings + polish
- [ ] Settings page (defaults, thresholds, on/off for each mode).
- [ ] Audio/video via `ffmpeg.wasm` (separate, opt-in, heavy) — out of v1.

## Testing

- Target server: **trantor** Foundry VTT (`felddy/foundryvtt:14`, core 14.364).
  World DB = LevelDB under `worlds/<world>/data/`.
- First test world: **`dh-ovdm`** (heaviest world media). Then the rest.
- Inventory at time of writing: ~105 convertible images (76 PNG, 7 JPG) across
  worlds + `assets/`; biggest 7.7 MB, most 1–2 MB; all under WebP's 16383px cap.

## Safety / Ops

- **Take a fresh restic snapshot on trantor before any live run.** Daily backup
  exists (`restic-backup.timer`, stops the Foundry container for a consistent
  world snapshot) but snapshot manually right before first apply.
- Dry-run before every live run.
- Keep originals until the world is verified visually.
- Never edit LevelDB/NeDB directly.

## References

- Paid upload-time module: converts on upload only (WebP/WebM/OGG, downscale,
  default 0.75 ratio, max 8K). No backfill of existing media — the gap this
  project fills.
- `NearWasTaken/Foundry-VTT-Media-Optimizer` (GPL-3.0, bash, regex on flat
  `.db`): broken on v13+ LevelDB. Reference for what **not** to do.
- Foundry API: `FilePicker.upload`, `Document#update`, `OffscreenCanvas`,
  `canvas.toBlob`.
