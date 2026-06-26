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

> Compatibility: Foundry VTT **v13–v14** (minimum 13, verified 14.364). GM-only.

## Screenshots

| Settings | Scope picker | Dry-run report |
|---|---|---|
| ![Settings panel](docs/images/settings.png) | ![Scope picker](docs/images/scope-picker.png) | ![Dry-run report with per-file plan and byte savings](docs/images/dry-run-report.png) |

## Install

**In-app (recommended).** In Foundry's setup screen go to **Add-on Modules →
Install Module**, search for *Batch Media Optimizer*, and click **Install**.

**Manifest URL.** If it isn't listed yet, paste this into the **Manifest URL**
field at the bottom of the Install Module dialog:

```
https://github.com/aronjanosch/foundryvtt-batch-media-optimizer/releases/latest/download/module.json
```

Either way, enable it per-world in **Manage Modules**. No build step — it ships
as plain ESM.

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
| `scripts/storage.mjs` | Resolve each reference to its backend (local data / Forge / S3): source, bucket, browse dir, WebP twin. |
| `scripts/paths.mjs` | WebP-twin naming, query handling, per-backend cached directory browser. |
| `scripts/optimizer.mjs` | Plan → convert → upload → repoint; dry-run, idempotency, cleanup report. |
| `scripts/upload-hook.mjs` | Wraps `FilePicker.upload` for upload-time conversion. |
| `scripts/apps/optimizer-app.mjs` | ApplicationV2 backfill UI: scope picker, dry-run report, progress + cancel. |
| `scripts/settings.mjs` | Shared converter settings + menu registration. |

## Storage backends

Works across the backends Foundry's FilePicker exposes, resolving each
reference automatically:

- **Local data** — relative paths (`worlds/…`, `assets/…`).
- **The Forge** — assets stored as `https://assets.forge-vtt.com/<you>/…` URLs
  in your own Assets Library. Auto-detected; no setup. Bazaar/shared assets and
  other users' libraries are read-only and skipped.
- **AWS S3** — assets stored as bucket URLs (virtual-hosted or path-style). The
  bucket must allow cross-origin `GET` (CORS) so the converter can read the
  original.

Anything referenced by a genuinely external URL, or by core/system/module
paths, is left alone.

## Limitations

- Audio/video transcoding is out of scope (needs `ffmpeg.wasm`/WebCodecs).
- Module- and system-shipped assets are left alone (they get overwritten on update).
- No automatic deletion of originals — Foundry exposes no file-delete API.
- S3 support requires bucket CORS to permit `GET` from the Foundry origin.

## License

MIT — see [LICENSE](LICENSE).
