/**
 * Minimal Ogg muxer for an Opus bitstream (RFC 7845 / RFC 3533).
 *
 * WebCodecs' AudioEncoder hands us raw Opus packets; this wraps them in Ogg
 * pages so the result is a standard `.ogg` file Foundry recognises. Self-
 * contained (no external dependency) — Ogg page framing is small and fully
 * specified, and writing it ourselves avoids vendoring an unvetted muxer.
 *
 * We pack as many packets per page as the 255-segment lacing limit allows to
 * keep per-page overhead low, and stamp each page's granule position with the
 * cumulative decoded sample count at 48 kHz (Opus' fixed internal rate).
 */

const CONTINUED = 0x01;
const BOS = 0x02; // beginning of stream
const EOS = 0x04; // end of stream

/** Ogg's CRC-32: poly 0x04c11db7, no input/output reflection, init 0, xorout 0. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/** Build the 19-byte OpusHead identification packet. */
export function buildOpusHead(channelCount, preSkip, inputSampleRate) {
  const head = new Uint8Array(19);
  const dv = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1; // version
  head[9] = channelCount;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputSampleRate, true);
  dv.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0 (mono/stereo)
  return head;
}

/** Build an OpusTags comment packet with a single vendor string. */
function buildOpusTags(vendor) {
  const v = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(8 + 4 + v.length + 4);
  const dv = new DataView(tags.buffer);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  dv.setUint32(8, v.length, true);
  tags.set(v, 12);
  dv.setUint32(12 + v.length, 0, true); // user comment count
  return tags;
}

export class OggOpusMuxer {
  /**
   * @param {number} channelCount
   * @param {Uint8Array} opusHead  19-byte OpusHead (use the encoder's if it
   *   provides one, so preSkip/gain match exactly).
   */
  constructor(channelCount, opusHead) {
    this.serial = (Math.random() * 0xffffffff) >>> 0;
    this.pageSeq = 0;
    /** @type {Uint8Array[]} */
    this.pages = [];

    // Header pages: OpusHead (BOS) and OpusTags, each on its own page.
    this._emitPage([opusHead ?? buildOpusHead(channelCount, 3840, 48000)], BOS, 0n);
    this._emitPage([buildOpusTags("batch-media-optimizer")], 0, 0n);

    /** @type {Uint8Array[]} */
    this._pending = [];
    this._pendingSegments = 0;
    this._granule = 0n; // cumulative 48 kHz samples
  }

  /**
   * Queue one Opus packet. `samples` is its decoded length in 48 kHz samples,
   * used to advance the granule position.
   *
   * @param {Uint8Array} packet
   * @param {number} samples
   */
  addPacket(packet, samples) {
    const segs = segmentCount(packet.length);
    // A page holds at most 255 lacing segments; flush before overflowing.
    if (this._pendingSegments + segs > 255) this._flush(false);
    this._pending.push(packet);
    this._pendingSegments += segs;
    this._granule += BigInt(Math.max(0, Math.round(samples)));
  }

  /** Flush remaining packets as the final (EOS) page and return the file bytes. */
  finalize() {
    this._flush(true);
    return concat(this.pages);
  }

  _flush(last) {
    if (this._pending.length === 0) {
      if (last) {
        // Emit an empty EOS page so the stream is terminated cleanly.
        this._emitPage([], EOS, this._granule);
      }
      return;
    }
    this._emitPage(this._pending, last ? EOS : 0, this._granule);
    this._pending = [];
    this._pendingSegments = 0;
  }

  _emitPage(packets, headerType, granule) {
    const lacing = [];
    for (const p of packets) {
      let len = p.length;
      while (len >= 255) {
        lacing.push(255);
        len -= 255;
      }
      lacing.push(len); // final value 0..254 marks the packet boundary
    }

    const bodyLen = packets.reduce((n, p) => n + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0; // stream structure version
    page[5] = headerType;
    dv.setBigUint64(6, BigInt.asUintN(64, granule), true);
    dv.setUint32(14, this.serial, true);
    dv.setUint32(18, this.pageSeq, true);
    dv.setUint32(22, 0, true); // CRC, filled in below over the whole page
    page[26] = lacing.length;
    page.set(lacing, 27);

    let off = 27 + lacing.length;
    for (const p of packets) {
      page.set(p, off);
      off += p.length;
    }

    dv.setUint32(22, oggCrc(page), true);
    this.pageSeq += 1;
    this.pages.push(page);
  }
}

function segmentCount(byteLength) {
  return Math.floor(byteLength / 255) + 1;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
