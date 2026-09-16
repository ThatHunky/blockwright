import { deflateSync } from 'node:zlib';

/**
 * Minimal PNG writer (8-bit truecolour, no alpha).
 *
 * A dependency would pull an image library in for what is, for our purposes, a header, one
 * deflate call and a CRC — and the renderer only ever emits opaque RGB, so none of the format's
 * harder corners (palettes, interlacing, alpha compositing) apply.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** `rgb` is width*height*3 bytes, row-major from the top-left. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePng: expected ${width * height * 3} bytes, got ${rgb.length}`);
  }
  // PNG stores each scanline behind a filter byte; filter 0 ("none") keeps the encoder trivial
  // and costs little, because deflate already finds the runs in flat-shaded blocky images.
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = y * (width * 3 + 1);
    raw[dst] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + src, width * 3).copy(raw, dst + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
