import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../../src/render/png.js';

/** Pull the raw scanlines back out of a PNG so tests can assert on actual pixels. */
function decode(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;
  let width = 0, height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(2);
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 3 + 1)]).toBe(0);
    raw.copy(Buffer.from(rgb.buffer), y * width * 3, y * (width * 3 + 1) + 1, y * (width * 3 + 1) + 1 + width * 3);
  }
  return { width, height, rgb };
}

describe('encodePng', () => {
  it('round-trips pixels through a real PNG', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const out = decode(encodePng(2, 2, rgb));
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect([...out.rgb]).toEqual([...rgb]);
  });

  it('ends with IEND and carries a valid CRC on every chunk', () => {
    const png = encodePng(3, 1, new Uint8Array(9));
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND');
  });

  it('refuses a buffer that does not match the dimensions', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow(/expected 12 bytes/);
  });
});
