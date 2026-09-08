import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { readStructure, writeStructure } from '../../src/schematic/structure.js';
import { T, parseNbt, writeNbtGz, compound, listOf } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('vanilla structure codec', () => {
  it('round-trips blocks, properties and a block entity', async () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_stairs[facing=north,half=top]'));
    v.set(1, 1, 0, st('air'));
    v.set(0, 0, 2, st('oak_sign[rotation=8]'));
    const sign = T.comp({ front_text: T.comp({ messages: T.list(T.string(['"hi"', '""', '""', '""'])) }) }).value;
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 0, 2], id: 'minecraft:sign', data: sign }]);
    const root = writeStructure(clip);
    const back = readStructure(await parseNbt(writeNbtGz(root)));
    expect(back.size).toEqual([2, 2, 3]);
    expect(back.dataVersion).toBe(4903);
    expect(back.voxels.size).toBe(4);
    expect(back.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north,half=top]');
    expect(back.voxels.get(1, 1, 0)?.isAir).toBe(true);
    expect(back.blockEntities).toHaveLength(1);
    expect(back.blockEntities[0].id).toBe('minecraft:sign');
    expect(back.blockEntities[0].pos).toEqual([0, 0, 2]);
    const frontText = compound(back.blockEntities[0].data, 'front_text');
    expect(frontText).toBeDefined();
    expect(listOf(frontText!, 'messages')).toEqual(['"hi"', '""', '""', '""']);
    expect(back.source).toBe('structure');
  });
  it('accepts the palettes (plural) variant and empty nbt-less blocks', async () => {
    // Build the nested "list of lists" by hand: T.list(T.list(...)) does not nest correctly
    // (prismarine-nbt's list() builder unwraps its argument's .value directly rather than
    // wrapping it in a new array), so a naive double T.list() call silently loses the inner
    // list's elements once the tag is actually serialized and parsed back.
    const dirtPalette = T.comp([{ Name: T.string('minecraft:dirt') }]);
    const oneList = T.list(dirtPalette);
    const palettesTag = T.list({ type: oneList.type, value: [oneList.value] });
    const root = T.comp(
      {
        size: T.list(T.int([1, 1, 1])),
        palettes: palettesTag,
        blocks: T.list(T.comp([{ state: T.int(0), pos: T.list(T.int([0, 0, 0])) }])),
        entities: T.list(T.comp([])),
        DataVersion: T.int(4903),
      },
      '',
    );
    const clip = readStructure(await parseNbt(writeNbtGz(root)));
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('dirt');
  });
});
