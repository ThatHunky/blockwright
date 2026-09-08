import { describe, it, expect } from 'vitest';
import { BuildSpecSchema, buildSpecToVoxels, BuildSpecError } from '../../src/voxel/spec.js';

const parse = (input: unknown) => buildSpecToVoxels(BuildSpecSchema.parse(input));

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
});
