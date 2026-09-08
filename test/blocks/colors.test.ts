import { describe, it, expect } from 'vitest';
import { BlockState } from '../../src/voxel/voxels.js';
import { blockColor, cssColor } from '../../src/blocks/colors.js';

const st = (s: string) => BlockState.parse(s);

describe('blockColor', () => {
  it('uses the table, colour words and material keywords', () => {
    expect(blockColor(st('stone'))).toEqual({ r: 125, g: 125, b: 125, a: 1 });
    const red = blockColor(st('red_wool'));
    expect(red.r).toBeGreaterThan(red.g + 50);
    const oak = blockColor(st('oak_stairs[facing=north]'));
    expect(oak).toEqual(blockColor(st('oak_planks')));
    expect(blockColor(st('glass')).a).toBeLessThan(1);
    expect(blockColor(st('air')).a).toBe(0);
  });
  it('hashes unknown names deterministically', () => {
    const a = blockColor(st('mod:weird_block'));
    expect(a).toEqual(blockColor(st('mod:weird_block')));
    expect(a).not.toEqual(blockColor(st('mod:other_block')));
    expect(cssColor(a)).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
  });
});
