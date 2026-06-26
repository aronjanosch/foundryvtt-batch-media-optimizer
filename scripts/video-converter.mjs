/**
 * Video converter. Pure client-side: source MP4/MOV bytes -> WebM (VP9) bytes,
 * with optional downscale. Mirrors converter.mjs's `ConvertResult` shape so the
 * optimizer can treat images and video uniformly.
 *
 * Pipeline (all in the browser, hardware-accelerated where available):
 *   mp4box demux  ->  VideoDecoder  ->  [downscale]  ->  VP9 VideoEncoder  ->  webm-muxer
 *
 * Audio is intentionally dropped — Foundry scene backgrounds and video tiles
 * are silent looping clips, so a video-only WebM is the right target and skips
 * all audio decode/encode/mux-sync complexity.
 *
 * Why WebCodecs and not ffmpeg.wasm: ffmpeg.wasm needs SharedArrayBuffer for
 * threads, which requires cross-origin isolation (COOP/COEP) that Foundry does
 * not set. WebCodecs uses the platform's native codecs and needs no isolation.
 */

import { Muxer, ArrayBufferTarget } from "./vendor/webm-muxer.mjs";
import { MP4Box, DataStream } from "./vendor/mp4box.mjs";
import { fitWithin } from "./converter.mjs";
import { warn } from "./constants.mjs";

/** Thrown when the file or environment can't be transcoded (no video track, no codec support). */
export class VideoUnsupportedError extends Error {}

/** Keyframe roughly every this many seconds, so seeking/looping stays cheap. */
const KEYFRAME_INTERVAL_SECONDS = 2;

/** True when the browser exposes the WebCodecs + OffscreenCanvas APIs we need. */
export function isWebCodecsAvailable() {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof OffscreenCanvas !== "undefined"
  );
}

/**
 * @typedef {Object} VideoConvertOptions
 * @property {number} maxDimension  Cap on the longest edge (px). 0 = no cap.
 * @property {number} videoQuality  0.3..1.0 — maps to a bits-per-pixel target.
 */

/**
 * Convert a source video Blob/File to WebM (VP9). Returns the same fields as
 * the image converter's `ConvertResult` (plus nothing extra needed by callers).
 *
 * @param {Blob} source
 * @param {VideoConvertOptions} options
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [hooks]
 * @returns {Promise<import("./converter.mjs").ConvertResult>}
 */
export async function convertToWebm(source, options, { signal, onProgress } = {}) {
  if (!isWebCodecsAvailable()) {
    throw new VideoUnsupportedError("This browser lacks the WebCodecs API required for video conversion.");
  }

  const { width, height, downscaled, buffer } = await transcode(source, options, { signal, onProgress });
  const blob = new Blob([buffer], { type: "video/webm" });

  return {
    blob,
    width,
    height,
    sourceBytes: source.size,
    outputBytes: blob.size,
    lossless: false,
    downscaled,
  };
}

/* ------------------------------------------------------------------ */
/* Demux                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse the container and pull out the video track's codec config + encoded
 * samples. The whole file is appended as one buffer, so onReady and onSamples
 * fire synchronously during append/start/flush.
 *
 * @param {Blob} blob
 * @returns {Promise<{track: any, description: Uint8Array|undefined, samples: any[], fps: number}>}
 */
async function demux(blob) {
  const file = MP4Box.createFile();
  const samples = [];

  let track = null;
  const ready = new Promise((resolve, reject) => {
    file.onError = (e) => reject(new VideoUnsupportedError(`Could not parse video container: ${e}`));
    file.onReady = (info) => {
      track = info.videoTracks?.[0];
      if (!track) {
        reject(new VideoUnsupportedError("File has no video track."));
        return;
      }
      resolve();
    };
  });
  file.onSamples = (_id, _user, s) => samples.push(...s);

  const ab = await blob.arrayBuffer();
  ab.fileStart = 0;
  file.appendBuffer(ab);
  await ready;

  const description = codecDescription(file, track.id);
  file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
  file.start();
  file.flush();

  if (samples.length === 0) {
    throw new VideoUnsupportedError("Video track contained no decodable samples.");
  }

  // fps from sample count over track duration; fall back to a sane default.
  const seconds = track.duration && track.timescale ? track.duration / track.timescale : 0;
  const fps = seconds > 0 ? Math.min(120, Math.max(1, Math.round(track.nb_samples / seconds))) : 30;

  return { track, description, samples, fps };
}

/**
 * Extract the decoder-configuration record (avcC/hvcC/vpcC/av1C box body) the
 * VideoDecoder needs. mp4box gives us the parsed box; we serialise it and strip
 * the 8-byte box header. Returns undefined for codecs that carry config in-band.
 */
function codecDescription(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // drop box size + type
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Transcode                                                          */
/* ------------------------------------------------------------------ */

async function transcode(blob, { maxDimension, videoQuality }, { signal, onProgress }) {
  throwIfAborted(signal);
  const { track, description, samples, fps } = await demux(blob);

  const srcW = track.video?.width || track.track_width;
  const srcH = track.video?.height || track.track_height;
  if (!srcW || !srcH) throw new VideoUnsupportedError("Could not determine video dimensions.");

  // VP9 wants even dimensions; round the (optionally downscaled) target down.
  const fit = fitWithin(srcW, srcH, maxDimension);
  const outW = fit.width - (fit.width % 2);
  const outH = fit.height - (fit.height % 2);
  const scaling = outW !== srcW || outH !== srcH;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "V_VP9", width: outW, height: outH, frameRate: fps },
    firstTimestampBehavior: "offset",
  });

  const encoderConfig = await pickVp9Config(outW, outH, fps, videoQuality);

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure ??= e),
  });
  encoder.configure(encoderConfig);

  // Reused across frames for downscale draws; cheaper than per-frame allocation.
  const canvas = scaling ? new OffscreenCanvas(outW, outH) : null;
  const ctx = canvas?.getContext("2d", { alpha: false });

  const keyInterval = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SECONDS));
  let frameIndex = 0;

  const decoder = new VideoDecoder({
    output: (frame) => {
      // Don't keep decoding/encoding once we've torn down on error/abort.
      if (failure) {
        frame.close();
        return;
      }
      let out = frame;
      try {
        if (scaling) {
          ctx.drawImage(frame, 0, 0, outW, outH);
          out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
        }
        encoder.encode(out, { keyFrame: frameIndex % keyInterval === 0 });
        frameIndex += 1;
      } catch (e) {
        failure ??= e;
      } finally {
        if (out !== frame) out.close();
        frame.close();
      }
    },
    error: (e) => (failure ??= e),
  });
  decoder.configure({ codec: track.codec, codedWidth: srcW, codedHeight: srcH, description });

  try {
    const total = samples.length;
    let processed = 0;
    for (const s of samples) {
      if (signal?.aborted) throw new VideoUnsupportedError("Cancelled.");
      if (failure) throw failure;

      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (1e6 * s.cts) / s.timescale,
          duration: (1e6 * s.duration) / s.timescale,
          data: s.data,
        }),
      );

      processed += 1;
      if (processed % 5 === 0 || processed === total) onProgress?.(processed, total);

      // Backpressure: let the native queues drain so memory stays bounded.
      await pace(decoder, "decodeQueueSize", 48);
      await pace(encoder, "encodeQueueSize", 48);
    }

    await decoder.flush();
    await encoder.flush();
    if (failure) throw failure;

    muxer.finalize();
    return { width: outW, height: outH, downscaled: scaling, buffer: muxer.target.buffer };
  } finally {
    safeClose(decoder);
    safeClose(encoder);
  }
}

/* ------------------------------------------------------------------ */
/* Encoder config                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build a supported VP9 encoder config. The codec string encodes a level
 * (`vp09.PP.LL.DD`); the right level depends on resolution/fps, and a too-low
 * level is rejected, so we probe from lowest upward and take the first the
 * platform accepts. Bitrate is derived from a bits-per-pixel target driven by
 * the quality setting.
 */
async function pickVp9Config(width, height, fps, quality) {
  const q = Math.min(1, Math.max(0.3, quality || 0.8));
  // Map quality 0.3..1.0 -> ~0.04..0.16 bits per pixel.
  const bpp = 0.04 + ((q - 0.3) / 0.7) * (0.16 - 0.04);
  const bitrate = Math.max(150_000, Math.round(bpp * width * height * fps));

  const base = { width, height, bitrate, framerate: fps, latencyMode: "quality" };
  const levels = ["10", "11", "20", "21", "30", "31", "40", "41", "50", "51", "52", "60", "61", "62"];
  for (const lvl of levels) {
    const cfg = { ...base, codec: `vp09.00.${lvl}.08` };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support?.supported) return support.config ?? cfg;
    } catch {
      /* try next level */
    }
  }
  throw new VideoUnsupportedError(`No supported VP9 encoder level for ${width}x${height}@${fps}.`);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Wait until a codec's queue drains below `max`, using the 'dequeue' event. */
async function pace(codec, sizeProp, max) {
  if (codec[sizeProp] <= max) return;
  await new Promise((resolve) => {
    const done = () => resolve();
    if (typeof codec.addEventListener === "function") {
      codec.addEventListener("dequeue", done, { once: true });
      // Safety net in case 'dequeue' isn't delivered on this platform.
      setTimeout(done, 50);
    } else {
      setTimeout(done, 5);
    }
  });
}

function safeClose(codec) {
  try {
    if (codec.state !== "closed") codec.close();
  } catch (e) {
    warn("Codec close failed.", e);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new VideoUnsupportedError("Cancelled.");
}
