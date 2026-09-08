import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { validateState, validateSet, suggestBlocks } from '../../src/blocks/registry.js';

const st = (s: string) => BlockState.parse(s);

describe('validateState', () => {
  it('accepts valid states', () => {
    expect(validateState(st('stone'))).toBeUndefined();
    expect(validateState(st('oak_stairs[facing=north,half=top]'))).toBeUndefined();
    expect(validateState(st('oak_sign[rotation=13]'))).toBeUndefined();
    expect(validateState(st('create:brass_block'))).toBeUndefined();
  });
  it('rejects bad names, properties and values', () => {
    expect(validateState(st('stoen'))?.message).toMatch(/unknown block "stoen"/);
    expect(validateState(st('stoen'))?.message).toMatch(/allow_unknown_blocks: true/);
    expect(validateState(st('oak_stairs[facing=up]'))?.message).toMatch(/facing.*north/);
    expect(validateState(st('oak_stairs[color=red]'))?.message).toMatch(/no property "color"/);
    expect(validateState(st('oak_stairs[waterlogged=maybe]'))?.message).toMatch(/true or false/);
  });
  it('range-checks int properties against the block definition, not just their shape', () => {
    expect(validateState(st('oak_sign[rotation=13]'))).toBeUndefined();
    expect(validateState(st('oak_sign[rotation=99]'))?.message).toMatch(/rotation.*between 0 and 15.*got 99/);
    expect(validateState(st('oak_sign[rotation=-1]'))?.message).toMatch(/rotation.*between 0 and 15.*got -1/);
  });
  it('validates a set and suggests names', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stoen'));
    v.set(1, 0, 0, st('stoen'));
    v.set(2, 0, 0, st('dirt'));
    expect(validateSet(v)).toHaveLength(1);
    expect(suggestBlocks('stoen')).toContain('stone');
    expect(suggestBlocks('oak_plank')).toContain('oak_planks');
  });
});
