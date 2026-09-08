import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { compile, mergeBoxes, splitBox, isAttachable, prefixDimension, forceloadRects } from '../../src/voxel/compile.js';

const st = (s: string) => BlockState.parse(s);
function cube(n: number, hollow: boolean): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++)
      for (let z = 0; z < n; z++) {
        const edge = x === 0 || y === 0 || z === 0 || x === n - 1 || y === n - 1 || z === n - 1;
        if (!hollow || edge) v.set(x, y, z, st('stone'));
      }
  return v;
}

describe('compile', () => {
  it('merges a solid cube into one fill', () => {
    const cmds = compile(cube(10, false));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].text).toBe('fill 0 0 0 9 9 9 stone');
    expect(cmds[0].blocks).toBe(1000);
  });
  it('merges a hollow cube into six fills', () => {
    const cmds = compile(cube(10, true));
    expect(cmds).toHaveLength(6);
    expect(cmds.reduce((n, c) => n + c.blocks, 0)).toBe(488);
    expect(cmds.every((c) => c.kind === 'fill')).toBe(true);
  });
  it('emits setblock for single voxels', () => {
    const v = new VoxelSet();
    v.set(1, 2, 3, st('oak_log[axis=y]'));
    expect(compile(v)[0].text).toBe('setblock 1 2 3 oak_log[axis=y]');
  });
  it('splits fills over the limit along the longest axis', () => {
    const boxes = splitBox({ min: [0, 0, 0], max: [39, 39, 39] }, 32768);
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1))).toEqual([32000, 32000]);
    const v = new VoxelSet();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) for (let z = 0; z < 40; z++) v.set(x, y, z, st('stone'));
    expect(compile(v)).toHaveLength(2);
  });
  it('places attachables after supports, lowest first', () => {
    const v = new VoxelSet();
    v.set(0, 1, 0, st('torch'));
    v.set(0, 0, 0, st('stone'));
    v.set(5, 0, 0, st('oak_door[half=upper]'));
    v.set(5, -1, 0, st('oak_door[half=lower]'));
    const texts = compile(v).map((c) => c.text);
    expect(texts[0]).toBe('setblock 0 0 0 stone');
    expect(texts.indexOf('setblock 5 -1 0 oak_door[half=lower]')).toBeLessThan(texts.indexOf('setblock 5 0 0 oak_door[half=upper]'));
    expect(texts.indexOf('setblock 0 1 0 torch')).toBeGreaterThan(0);
  });
  it('classifies attachables', () => {
    for (const n of ['torch', 'wall_torch', 'lantern', 'ladder', 'oak_door', 'stone_button', 'rail', 'powered_rail', 'red_carpet', 'snow', 'poppy', 'short_grass', 'oak_sign', 'oak_wall_sign', 'redstone_wire', 'glass_pane', 'cave_vines', 'candle'])
      expect(isAttachable(st(n)), n).toBe(true);
    for (const n of ['stone', 'snow_block', 'oak_trapdoor_x', 'cobblestone_wall', 'grass_block', 'mangrove_roots_block', 'oak_planks'])
      expect(isAttachable(st(n)), n).toBe(false);
    expect(isAttachable(st('oak_trapdoor'))).toBe(true);
  });
  it('does not classify solid coral blocks as attachable, but does classify coral fans and loose corals', () => {
    for (const n of ['tube_coral_block', 'dead_brain_coral_block', 'brain_coral_block', 'fire_coral_block'])
      expect(isAttachable(st(n)), n).toBe(false);
    for (const n of ['tube_coral_fan', 'dead_tube_coral_wall_fan', 'brain_coral', 'dead_horn_coral', 'fire_coral_wall_fan'])
      expect(isAttachable(st(n)), n).toBe(true);
  });
  it('prefixes non-overworld dimensions', () => {
    expect(prefixDimension('fill 0 0 0 1 1 1 stone', 'minecraft:the_nether')).toBe('execute in minecraft:the_nether run fill 0 0 0 1 1 1 stone');
    expect(prefixDimension('fill 0 0 0 1 1 1 stone', 'minecraft:overworld')).toBe('fill 0 0 0 1 1 1 stone');
    expect(prefixDimension('fill 0 0 0 1 1 1 stone')).toBe('fill 0 0 0 1 1 1 stone');
  });
  it('computes forceload rectangles of at most 256 chunks', () => {
    expect(forceloadRects({ min: [0, 60, 0], max: [39, 70, 39] })).toEqual([{ minX: 0, minZ: 0, maxX: 47, maxZ: 47 }]);
    const rects = forceloadRects({ min: [-150, 60, 180], max: [149, 70, 479] });
    expect(rects).toHaveLength(4);
    for (const r of rects) expect(((r.maxX - r.minX + 1) / 16) * ((r.maxZ - r.minZ + 1) / 16)).toBeLessThanOrEqual(256);
  });
  it('mergeBoxes covers every position exactly once', () => {
    const boxes = mergeBoxes([[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [5, 5, 5]]);
    expect(boxes).toEqual([{ min: [0, 0, 0], max: [1, 0, 1] }, { min: [5, 5, 5], max: [5, 5, 5] }]);
  });
});
