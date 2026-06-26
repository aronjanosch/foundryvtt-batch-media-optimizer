/**
 * Audio converter. Pure client-side: source audio bytes (mp3/wav/flac/m4a/aac)
 * -> Ogg/Opus bytes. Mirrors converter.mjs's `ConvertResult` shape so the
 * optimizer can treat all media kinds uniformly.
 *
 * Pipeline:
 *   decodeAudioData (any format the browser supports) -> PCM @ 48 kHz
 *     -> AudioEncoder (Opus) -> OggOpusMuxer -> .ogg
 *
 * decodeAudioData handles demuxing/decoding of every common source format, so
 * we need no per-codec demuxer. Opus is the most efficient option and Ogg is
 * Foundry's native audio container, recognised by its file picker and playlists.
 */

import { OggOpusMuxer } from "./ogg.mjs";
import { warn } from "./constants.mjs";

/** Opus operates internally at 48 kHz; decode/encode at that rate throughout. */
const OPUS_RATE = 48000;
/** Opus channel mapping family 0 supports mono/stereo only. */
const MAX_CHANNELS = 2;

/** Thrown when the environment or file can't be transcoded. */
export class AudioUnsupportedError extends Error {}

/** True when the browser exposes the WebCodecs audio APIs we need. */
export function isAudioWebCodecsAvailable() {
  return (
    typeof AudioEncoder !== "undefined" &&
    typeof AudioData !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
}

/**
 * @typedef {Object} AudioConvertOptions
 * @property {number} audioQuality  0.3..1.0 — maps to an Opus bitrate target.
 */

/**
 * Convert a source audio Blob/File to Ogg/Opus.
 *
 * @param {Blob} source
 * @param {AudioConvertOptions} options
 * @param {{signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [hooks]
 * @returns {Promise<import("./converter.mjs").ConvertResult>}
 */
export async function convertToOgg(source, options, { signal, onProgress } = {}) {
  if (!isAudioWebCodecsAvailable()) {
    throw new AudioUnsupportedError("This browser lacks the WebCodecs AudioEncoder required for audio conversion.");
  }

  const pcm = await decodePcm(source);
  const channels = Math.min(MAX_CHANNELS, pcm.numberOfChannels);
  const bytes = await encodeOpus(pcm, channels, options.audioQuality, { signal, onProgress });
  const blob = new Blob([bytes], { type: "audio/ogg" });

  return {
    blob,
    width: 0,
    height: 0,
    sourceBytes: source.size,
    outputBytes: blob.size,
    lossless: false,
    downscaled: false,
  };
}

/** Decode any supported source to a 48 kHz AudioBuffer (resampled by the API). */
async function decodePcm(blob) {
  const data = await blob.arrayBuffer();
  // A throwaway OfflineAudioContext fixes the output sample rate at 48 kHz.
  const ctx = new OfflineAudioContext(1, 1, OPUS_RATE);
  try {
    return await ctx.decodeAudioData(data);
  } catch (err) {
    throw new AudioUnsupportedError(`Could not decode audio: ${err?.message ?? err}`);
  }
}

async function encodeOpus(audioBuffer, channels, quality, { signal, onProgress }) {
  let failure = null;
  let opusHead = null;
  /** @type {{data: Uint8Array, samples: number}[]} */
  const packets = [];

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (!opusHead && meta?.decoderConfig?.description) {
        opusHead = new Uint8Array(meta.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // Granule advances by the packet's decoded length at 48 kHz.
      const samples = chunk.duration ? (chunk.duration * OPUS_RATE) / 1e6 : 960;
      packets.push({ data, samples });
    },
    error: (e) => (failure ??= e),
  });
  encoder.configure({
    codec: "opus",
    sampleRate: OPUS_RATE,
    numberOfChannels: channels,
    bitrate: opusBitrate(channels, quality),
  });

  const total = audioBuffer.length;
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(audioBuffer.getChannelData(c));

  try {
    let pos = 0;
    const segment = OPUS_RATE; // feed ~1s at a time for progress + bounded memory
    while (pos < total) {
      if (signal?.aborted) throw new AudioUnsupportedError("Cancelled.");
      if (failure) throw failure;

      const n = Math.min(segment, total - pos);
      const planar = new Float32Array(channels * n);
      for (let c = 0; c < channels; c++) planar.set(planes[c].subarray(pos, pos + n), c * n);

      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: OPUS_RATE,
        numberOfFrames: n,
        numberOfChannels: channels,
        timestamp: Math.round((pos / OPUS_RATE) * 1e6),
        data: planar,
      });
      encoder.encode(audioData);
      audioData.close();

      pos += n;
      onProgress?.(pos, total);
    }

    await encoder.flush();
    if (failure) throw failure;
  } finally {
    safeClose(encoder);
  }

  const muxer = new OggOpusMuxer(channels, opusHead);
  for (const { data, samples } of packets) muxer.addPacket(data, samples);
  return muxer.finalize();
}

/** Map quality 0.3..1.0 to an Opus bitrate; mono gets a lower target than stereo. */
function opusBitrate(channels, quality) {
  const q = Math.min(1, Math.max(0.3, quality || 0.8));
  const total = 48000 + ((q - 0.3) / 0.7) * (160000 - 48000); // 48..160 kbps
  return Math.round(channels === 1 ? total * 0.6 : total);
}

function safeClose(codec) {
  try {
    if (codec.state !== "closed") codec.close();
  } catch (e) {
    warn("AudioEncoder close failed.", e);
  }
}
