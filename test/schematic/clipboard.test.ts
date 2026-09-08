import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels, clipboardVoxelsAt, tileBox } from '../../src/schematic/clipboard.js';
import { T } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('clipboard', () => {
  it('normalizes to a zero min corner and shifts block entities', () => {
    const v = new VoxelSet();
    v.set(10, 5, 20, st('stone'));
    v.set(12, 6, 21, st('oak_sign[rotation=0]'));
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [12, 6, 21], id: 'minecraft:sign', data: T.comp({}).value }]);
    expect(clip.size).toEqual([3, 2, 2]);
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('stone');
    expect(clip.blockEntities[0].pos).toEqual([2, 1, 1]);
    expect(clip.offset).toEqual([0, 0, 0]);
    expect(clip.dataVersion).toBe(4903);
  });
  it('places at origin, honours useOffset, rotation and ignoreAir', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('oak_stairs[facing=north]'));
    v.set(2, 0, 0, st('air'));
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 0, 0], id: 'minecraft:x', data: {} }], [-1, 0, -1]);
    const plain = clipboardVoxelsAt(clip, [100, 64, 100], {});
    expect(plain.voxels.get(100, 64, 100)?.props.facing).toBe('north');
    expect(plain.voxels.get(102, 64, 100)?.isAir).toBe(true);
    const noAir = clipboardVoxelsAt(clip, [100, 64, 100], { ignoreAir: true });
    expect(noAir.voxels.size).toBe(1);
    const off = clipboardVoxelsAt(clip, [100, 64, 100], { useOffset: true });
    expect(off.voxels.get(99, 64, 99)?.props.facing).toBe('north');
    const rot = clipboardVoxelsAt(clip, [100, 64, 100], { rotation: 1 });
    expect(rot.voxels.bounds()!.min).toEqual([100, 64, 100]);
    expect(rot.voxels.get(100, 64, 100)?.props.facing).toBe('east');
    expect(rot.blockEntities[0].pos).toEqual([100, 64, 100]);
  });
  it('tiles boxes to 48 per axis', () => {
    const tiles = tileBox({ min: [0, 0, 0], max: [59, 19, 99] });
    expect(tiles).toHaveLength(2 * 1 * 3);
    expect(tiles[0]).toEqual({ min: [0, 0, 0], max: [47, 19, 47] });
    expect(tiles[tiles.length - 1]).toEqual({ min: [48, 0, 96], max: [59, 19, 99] });
  });
});
