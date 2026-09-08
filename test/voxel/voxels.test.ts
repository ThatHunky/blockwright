import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet, box, boxSize, boxVolume, boxContains, key, unkey } from '../../src/voxel/voxels.js';

describe('BlockState', () => {
  it('parses a bare name and adds the minecraft namespace', () => {
    const s = BlockState.parse('stone');
    expect(s.name).toBe('minecraft:stone');
    expect(s.props).toEqual({});
    expect(s.toString()).toBe('minecraft:stone');
    expect(s.toCommand()).toBe('stone');
  });
  it('parses properties and sorts them', () => {
    const s = BlockState.parse('oak_stairs[half=top,facing=north]');
    expect(s.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
    expect(s.toCommand()).toBe('oak_stairs[facing=north,half=top]');
  });
  it('keeps non-minecraft namespaces in commands', () => {
    expect(BlockState.parse('create:brass_block').toCommand()).toBe('create:brass_block');
  });
  it('rejects malformed input', () => {
    for (const bad of ['stone[', 'stone[facing]', 'bad name', '', 'Stone']) {
      expect(() => BlockState.parse(bad)).toThrow(bad === '' ? /Invalid block state/ : bad);
    }
  });
  it('detects air variants', () => {
    expect(BlockState.parse('air').isAir).toBe(true);
    expect(BlockState.parse('cave_air').isAir).toBe(true);
    expect(BlockState.parse('stone').isAir).toBe(false);
  });
  it('with() returns a new state with merged props', () => {
    const s = BlockState.parse('oak_stairs[facing=north]').with({ half: 'top' });
    expect(s.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
  });

  it('accepts the real Minecraft property grammar: snake_case keys, word or signed-integer values', () => {
    expect(BlockState.parse('stone[foo_bar=baz_2]').props).toEqual({ foo_bar: 'baz_2' });
    expect(BlockState.parse('oak_sign[rotation=13]').props).toEqual({ rotation: '13' });
    expect(BlockState.parse('repeater[delay=-1]').props).toEqual({ delay: '-1' });
    expect(BlockState.parse('cobblestone_wall[east=none,north=low]').props).toEqual({ east: 'none', north: 'low' });
  });

  it('rejects block state properties that are not the plain Minecraft grammar', () => {
    // Reported XSS vector: markup smuggled through a property value.
    expect(() => BlockState.parse('stone[foo=<img src=x onerror=alert(1)>]')).toThrow(/Invalid block state property/);
    // Uppercase, whitespace, and punctuation are not valid keys or values.
    expect(() => BlockState.parse('stone[Facing=north]')).toThrow(/Invalid block state property/);
    expect(() => BlockState.parse('stone[facing=North]')).toThrow(/Invalid block state property/);
    expect(() => BlockState.parse('stone[fa cing=north]')).toThrow(/Invalid block state property/);
    expect(() => BlockState.parse('stone[facing=north-east]')).toThrow(/Invalid block state property/);
    expect(() => BlockState.parse('stone[facing="north"]')).toThrow(/Invalid block state property/);
    expect(() => BlockState.parse('stone[on<click>=true]')).toThrow(/Invalid block state property/);
  });
});

describe('keys and boxes', () => {
  it('round-trips keys', () => {
    expect(unkey(key(-1, 2, 3))).toEqual([-1, 2, 3]);
  });
  it('normalizes box corners and computes size/volume', () => {
    const b = box([3, 1, 2], [0, 5, -1]);
    expect(b.min).toEqual([0, 1, -1]);
    expect(b.max).toEqual([3, 5, 2]);
    expect(boxSize(b)).toEqual([4, 5, 4]);
    expect(boxVolume(b)).toBe(80);
    expect(boxContains(b, [3, 5, 2])).toBe(true);
    expect(boxContains(b, [4, 5, 2])).toBe(false);
  });
});

describe('VoxelSet', () => {
  it('stores, counts and bounds voxels', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, BlockState.parse('stone'));
    v.set(2, 1, -1, BlockState.parse('stone'));
    v.set(1, 0, 0, BlockState.parse('air'));
    expect(v.size).toBe(3);
    expect(v.get(2, 1, -1)?.toString()).toBe('minecraft:stone');
    expect(v.bounds()).toEqual({ min: [0, 0, -1], max: [2, 1, 0] });
    expect(Object.fromEntries(v.counts())).toEqual({ 'minecraft:stone': 2, 'minecraft:air': 1 });
    expect(v.nonAirCount()).toBe(2);
  });
  it('bounds is undefined when empty and updates after delete', () => {
    const v = new VoxelSet();
    expect(v.bounds()).toBeUndefined();
    v.set(5, 5, 5, BlockState.parse('stone'));
    v.set(9, 9, 9, BlockState.parse('stone'));
    v.delete(9, 9, 9);
    expect(v.bounds()).toEqual({ min: [5, 5, 5], max: [5, 5, 5] });
  });
  it('translates and clones without sharing state', () => {
    const v = new VoxelSet();
    v.set(1, 2, 3, BlockState.parse('stone'));
    const t = v.translate(10, 0, -3);
    expect([...t.entries()][0][0]).toEqual([11, 2, 0]);
    const c = v.clone();
    c.set(0, 0, 0, BlockState.parse('dirt'));
    expect(v.size).toBe(1);
    expect(c.size).toBe(2);
  });
  it('merges another set, later values win', () => {
    const a = new VoxelSet();
    a.set(0, 0, 0, BlockState.parse('stone'));
    const b = new VoxelSet();
    b.set(0, 0, 0, BlockState.parse('dirt'));
    b.set(1, 0, 0, BlockState.parse('dirt'));
    a.merge(b);
    expect(a.get(0, 0, 0)?.toCommand()).toBe('dirt');
    expect(a.size).toBe(2);
  });
});
