import { describe, it, expect } from 'vitest';
import { BuildSpecSchema, buildSpecToVoxels, buildSpecToRelativeVoxels, BuildSpecError } from '../../src/voxel/spec.js';

const parse = (input: unknown) => buildSpecToVoxels(BuildSpecSchema.parse(input));

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected fn to throw');
}

describe('buildSpecToVoxels', () => {
  it('maps rows to z, chars to x, layers to y, offset by origin', () => {
    const v = parse({ origin: [100, 64, 200], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['##', ' #'] }] });
    expect(v.size).toBe(3);
    expect(v.get(100, 64, 200)?.toCommand()).toBe('stone');
    expect(v.get(101, 64, 200)?.toCommand()).toBe('stone');
    expect(v.get(100, 64, 201)).toBeUndefined();
    expect(v.get(101, 64, 201)?.toCommand()).toBe('stone');
  });
  it('repeats a y range', () => {
    const v = parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [1, 3], rows: ['#'] }] });
    expect(v.size).toBe(3);
    expect(v.bounds()).toEqual({ min: [0, 1, 0], max: [0, 3, 0] });
  });
  it('accepts extra single blocks and property strings in the palette', () => {
    const v = parse({
      origin: [0, 0, 0],
      palette: { s: 'oak_stairs[facing=north]' },
      layers: [{ y: 0, rows: ['s'] }],
      blocks: [{ pos: [0, 1, 0], block: 'lantern[hanging=true]' }],
    });
    expect(v.get(0, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north]');
    expect(v.get(0, 1, 0)?.toString()).toBe('minecraft:lantern[hanging=true]');
  });
  it('reports unknown characters with their position', () => {
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['# ', '#Q'] }] })).toThrow(
      /layer 0 row 1 col 1: character "Q"/,
    );
  });
  it('reports bad palette entries and empty specs', () => {
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'sto ne' }, layers: [{ y: 0, rows: ['#'] }] })).toThrow(BuildSpecError);
    expect(() => parse({ origin: [0, 0, 0], palette: {}, layers: [{ y: 0, rows: ['  '] }] })).toThrow(/no blocks/);
  });
  it('rotates about the min corner', () => {
    const v = parse({ origin: [10, 0, 10], palette: { '#': 'stone', s: 'oak_stairs[facing=north]' }, layers: [{ y: 0, rows: ['s###'] }], rotation: 90 });
    expect(v.bounds()).toEqual({ min: [10, 0, 10], max: [10, 0, 13] });
    // the stairs block was at x=0 (west end); after clockwise rotation it is at the north end
    expect(v.get(10, 0, 10)?.props.facing).toBe('east');
  });
  it('rejects a layer with ragged rows', () => {
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['##', '#'] }] })).toThrow(
      /layer 0: rows must have equal length \(expected 2, row 1 has length 1\)/,
    );
    expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['##', '#'] }] })).toThrow(BuildSpecError);
  });
  it('accepts a layer whose short rows are padded with trailing spaces', () => {
    const v = parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['##', '# '] }] });
    expect(v.size).toBe(3);
    expect(v.get(0, 0, 1)?.toCommand()).toBe('stone');
    expect(v.get(1, 0, 1)).toBeUndefined();
  });
  it('applies defaults through the schema', () => {
    const s = BuildSpecSchema.parse({ origin: [0, 0, 0], layers: [{ y: 0, rows: ['#'] }], palette: { '#': 'dirt' } });
    expect(s.rotation).toBe(0);
    expect(s.mirror).toBe('none');
    expect(s.blocks).toEqual([]);
  });
  it('still builds a normal, realistic structure unchanged', () => {
    const v = parse({
      origin: [100, 64, 200],
      palette: { '#': 'stone_bricks', g: 'glass_pane' },
      layers: [
        { y: 0, rows: ['#####', '#####', '#####', '#####', '#####'] },
        { y: [1, 3], rows: ['#####', '#g g#', '#   #', '#g g#', '#####'] },
        { y: 4, rows: ['#####', '#####', '#####', '#####', '#####'] },
      ],
      blocks: [{ pos: [2, 1, 0], block: 'oak_stairs[facing=north]' }],
    });
    expect(v.size).toBeGreaterThan(0);
    expect(v.get(100, 64, 200)?.toCommand()).toBe('stone_bricks');
    expect(v.get(102, 65, 200)?.toString()).toBe('minecraft:oak_stairs[facing=north]');
  });
});

describe('resource-exhaustion guards on the build spec', () => {
  it('rejects the reviewer\'s [0, 2000000] y-range payload at the schema layer, naming the size, cap and env var', () => {
    // { layers: [ { y: [0, 2000000], rows: ["#"] } ] } — a single 1x1 column repeated 2,000,001
    // times. Well under the 5,000,000 voxel cap on its own, but the per-layer y-range span limit
    // exists precisely so a range like this is rejected before it is ever materialized.
    const payload = { origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [0, 2000000], rows: ['#'] }] };
    expect(() => BuildSpecSchema.parse(payload)).toThrow();
    const msg = messageOf(() => BuildSpecSchema.parse(payload));
    expect(msg).toMatch(/2,000,001/);
    expect(msg).toMatch(/5,000,000/);
    expect(msg).toMatch(/BLOCKWRIGHT_MAX_VOXELS/);
  });
  it('rejects a single row longer than the schema maximum', () => {
    const spec = { origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['#'.repeat(5000)] }] };
    expect(() => BuildSpecSchema.parse(spec)).toThrow(/4,096/);
  });
  it('rejects a build with more layers than the schema maximum', () => {
    const layers = Array.from({ length: 4097 }, () => ({ y: 0, rows: ['#'] }));
    const spec = { origin: [0, 0, 0], palette: { '#': 'stone' }, layers };
    expect(() => BuildSpecSchema.parse(spec)).toThrow(/4,096/);
  });
  it('rejects, from declared dimensions alone, a spec whose total would exceed the default voxel cap, naming the size, cap and env var', () => {
    // One layer within every individual schema bound (span 4,096 <= max, row length 1,300 <= max,
    // 1 layer <= max) but 4,097 * 1,300 = 5,326,100 voxels overall — over the 5,000,000 cap.
    const big = { origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [0, 4096], rows: ['#'.repeat(1300)] }] };
    expect(() => parse(big)).toThrow(BuildSpecError);
    const msg = messageOf(() => parse(big));
    expect(msg).toMatch(/5,326,100 voxels/);
    expect(msg).toMatch(/5,000,000 voxel limit/);
    expect(msg).toMatch(/BLOCKWRIGHT_MAX_VOXELS/);
  });
  it('checks the declared size before entering the generation loop (buildSpecToRelativeVoxels protects direct callers too)', () => {
    // Bypass the schema entirely: a hand-built spec with the same shape as the oversized one
    // above must still be rejected by buildSpecToRelativeVoxels itself, not just by the schema.
    const big = {
      origin: [0, 0, 0] as [number, number, number],
      palette: { '#': 'stone' },
      layers: [{ y: [0, 4096] as [number, number], rows: ['#'.repeat(1300)] }],
      blocks: [],
      rotation: 0 as const,
      mirror: 'none' as const,
    };
    expect(() => buildSpecToRelativeVoxels(big)).toThrow(/5,326,100 voxels/);
  });
  it('keeps a running check during generation in case an estimate that looked fine turns out to grow past the cap', () => {
    // spec.blocks entries aren't part of the pre-loop layer estimate; a huge blocks[] array must
    // still be caught by the running counter inside the loop rather than allocating unbounded memory.
    const prev = process.env.BLOCKWRIGHT_MAX_VOXELS;
    try {
      process.env.BLOCKWRIGHT_MAX_VOXELS = '5';
      const spec = {
        origin: [0, 0, 0] as [number, number, number],
        palette: {},
        layers: [],
        blocks: Array.from({ length: 10 }, (_, i) => ({ pos: [i, 0, 0] as [number, number, number], block: 'stone' })),
        rotation: 0 as const,
        mirror: 'none' as const,
      };
      expect(() => buildSpecToRelativeVoxels(spec)).toThrow(/5 voxel limit/);
    } finally {
      if (prev === undefined) delete process.env.BLOCKWRIGHT_MAX_VOXELS;
      else process.env.BLOCKWRIGHT_MAX_VOXELS = prev;
    }
  });
  it('honours BLOCKWRIGHT_MAX_VOXELS to raise or lower the effective cap', () => {
    const prev = process.env.BLOCKWRIGHT_MAX_VOXELS;
    try {
      process.env.BLOCKWRIGHT_MAX_VOXELS = '10';
      expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [0, 20], rows: ['#'] }] })).toThrow(/10 voxel limit/);
      process.env.BLOCKWRIGHT_MAX_VOXELS = '1000';
      expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [0, 2000], rows: ['#'] }] })).toThrow(/1,000 voxel limit/);
      process.env.BLOCKWRIGHT_MAX_VOXELS = '3000';
      expect(() => parse({ origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: [0, 2000], rows: ['#'] }] })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.BLOCKWRIGHT_MAX_VOXELS;
      else process.env.BLOCKWRIGHT_MAX_VOXELS = prev;
    }
  });
});
