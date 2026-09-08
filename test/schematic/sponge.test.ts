import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { readSponge, writeSponge3, encodeVarints, decodeVarints } from '../../src/schematic/sponge.js';
import { T, parseNbt, writeNbtGz } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('varints', () => {
  it('encodes and decodes values above 127', () => {
    const bytes = encodeVarints([0, 1, 127, 128, 300]);
    expect(bytes.length).toBe(1 + 1 + 1 + 2 + 2);
    expect(decodeVarints(bytes, 5)).toEqual([0, 1, 127, 128, 300]);
  });
});

describe('sponge v2', () => {
  it('reads palette, block data and WorldEdit offset metadata', async () => {
    const root = T.comp(
      {
        Version: T.int(2),
        DataVersion: T.int(3700),
        Width: T.short(2),
        Height: T.short(1),
        Length: T.short(2),
        PaletteMax: T.int(3),
        Palette: T.comp({ 'minecraft:air': T.int(0), 'minecraft:stone': T.int(1), 'minecraft:oak_stairs[facing=north,half=bottom]': T.int(2) }),
        BlockData: T.byteArray(encodeVarints([1, 2, 0, 1])),
        BlockEntities: T.list(T.comp([])),
        Metadata: T.comp({ WEOffsetX: T.int(-1), WEOffsetY: T.int(0), WEOffsetZ: T.int(-2) }),
      },
      'Schematic',
    );
    const clip = readSponge(await parseNbt(writeNbtGz(root)));
    expect(clip.size).toEqual([2, 1, 2]);
    expect(clip.offset).toEqual([-1, 0, -2]);
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('stone');
    expect(clip.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north,half=bottom]');
    expect(clip.voxels.get(0, 0, 1)?.isAir).toBe(true);
    expect(clip.voxels.get(1, 0, 1)?.toCommand()).toBe('stone');
    expect(clip.dataVersion).toBe(3700);
    expect(clip.source).toBe('sponge');
  });
});

describe('sponge v3', () => {
  it('round-trips voxels, offset and block entities', async () => {
    const v = new VoxelSet();
    for (let i = 0; i < 200; i++) v.set(i, 0, 0, st(`stone[fake=${i}]`)); // 200 distinct states forces indices >127
    v.set(0, 1, 0, st('chest[facing=north]'));
    const chest = T.comp({ Items: T.list(T.comp([])) }).value;
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 1, 0], id: 'minecraft:chest', data: chest }], [3, 0, 3]);
    const back = readSponge(await parseNbt(writeNbtGz(writeSponge3(clip))));
    expect(back.size).toEqual([200, 2, 1]);
    expect(back.offset).toEqual([3, 0, 3]);
    expect(back.voxels.get(199, 0, 0)?.toString()).toBe('minecraft:stone[fake=199]');
    expect(back.voxels.get(5, 1, 0)?.isAir).toBe(true);
    expect(back.blockEntities).toEqual([{ pos: [0, 1, 0], id: 'minecraft:chest', data: chest }]);
    expect(back.dataVersion).toBe(4903);
  });
});
