# Batch Media Optimizer

A Foundry VTT module that optimizes world media — scene backgrounds, token/actor
art, journal images — by converting it to **WebP** (with optional downscaling)
and repointing the document references. It works two ways:

1. **Backfill** — retroactively optimize media already present in a world.
2. **Upload-time** — auto-convert images as they are uploaded, so the world
   stays optimized going forward.

It never touches the database on disk. Every write goes through Foundry's own
API (`FilePicker.upload`, `Document#update`), so it is safe on v13/v14 LevelDB
and beyond.

> Compatibility: Foundry VTT **v14** (verified 14.364). GM-only.

## Install

Copy this folder into your Foundry `Data/modules/` directory as
`batch-media-optimizer`, then enable it in **Manage Modules**. No build step —
it ships as plain ESM.

## Usage

### Backfill an existing world

1. **Game Settings → Configure Settings → Batch Media Optimizer → Open
   Optimizer**, or run a macro:
   ```js
   game.modules.get("batch-media-optimizer").api.open();
   ```
2. Choose what to scan (scenes / actors / journals / item art) and the
   conversion options.
3. **Scan & dry-run** — converts in memory and shows a per-file plan with real
   byte savings. Nothing is written.
4. Review, then **Apply** — uploads `.webp` twins next to the originals and
   repoints every document field. Confirm the backup prompt first.
5. **Cleanup report** lists originals that now have a twin and are no longer
   referenced, so you can delete them manually (Foundry has no file-delete API).

### Auto-optimize on upload

Enable **Optimize on upload** in settings. PNG/JPG images uploaded through
Foundry are then converted to WebP before they hit disk, using the same
quality/downscale settings. WebP/SVG/audio and anything that wouldn't shrink
pass through untouched.

## Settings

| Setting | Default | Effect |
|---|---|---|
| WebP quality | `0.8` | Lossy quality (0.3–1.0), shared by both modes. |
| Max dimension (px) | `0` | Downscale longest edge above this; `0` disables. |
| Lossless PNG-alpha under (px) | `512` | Small transparent PNGs (tokens/icons) stay lossless. |
| Optimize on upload | off | Auto-convert uploads to WebP. |
| Include item art | on | Also scan world + actor-owned item images during backfill. |

## Safety

- **Dry-run by default.** The Apply button is the only thing that writes.
- **Originals are kept.** Conversion writes a sibling `.webp`; nothing is deleted.
- **Idempotent.** Files whose `.webp` twin already exists are skipped but still
  repointed, so an interrupted run can be re-applied to finish.
- **Take a fresh world backup before the first live run.**

## Architecture

Pure client-side, runs inside an authenticated GM session.

| File | Responsibility |
|---|---|
| `scripts/converter.mjs` | `OffscreenCanvas` → WebP, downscale, lossless-alpha heuristic, 16383px guard. |
| `scripts/discovery.mjs` | Walk documents, collect image field references (incl. wildcards + embedded HTML). |
| `scripts/paths.mjs` | Editable-path filter, WebP-twin naming, cached directory browser. |
| `scripts/optimizer.mjs` | Plan → convert → upload → repoint; dry-run, idempotency, cleanup report. |
| `scripts/upload-hook.mjs` | Wraps `FilePicker.upload` for upload-time conversion. |
| `scripts/apps/optimizer-app.mjs` | ApplicationV2 backfill UI: scope picker, dry-run report, progress + cancel. |
| `scripts/settings.mjs` | Shared converter settings + menu registration. |

## Limitations

- Audio/video transcoding is out of scope (needs `ffmpeg.wasm`/WebCodecs).
- Only operates on world / user data; module- and system-shipped assets are left
  alone (they get overwritten on update).
- No automatic deletion of originals — Foundry exposes no file-delete API.

## License

MIT — see [LICENSE](LICENSE).
