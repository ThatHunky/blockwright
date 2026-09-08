import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { renderAscii } from '../../src/preview/ascii.js';

const st = (s: string) => BlockState.parse(s);

function hut(): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) v.set(x + 10, 60, z + 20, st('stone_bricks'));
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) if (x === 1 && z === 1) v.set(x + 10, 61, z + 20, st('air')); else v.set(x + 10, 61, z + 20, st('oak_planks'));
  v.set(11, 62, 21, st('torch'));
  return v;
}

describe('renderAscii', () => {
  it('renders legend, top-down view and layers', () => {
    const r = renderAscii(hut());
    expect(r.legend['#']).toBe('minecraft:stone_bricks');
    expect(r.legend['@']).toBe('minecraft:oak_planks');
    expect(r.text).toContain('Bounds: (10, 60, 20) to (12, 62, 22), size 3x3x3, 19 blocks (18 non-air)');
    expect(r.text).toContain('# stone_bricks (9)');
    expect(r.text).toContain('. air (1)');
    expect(r.text).toContain('Layer y=61 (+1):');
    expect(r.text).toMatch(/@@@\n\s*@\.@\n\s*@@@/);
    expect(r.text).toContain('Top-down');
  });
  it('caps layers', () => {
    const v = new VoxelSet();
    for (let y = 0; y < 30; y++) v.set(0, y, 0, st('stone'));
    const r = renderAscii(v, { maxLayers: 4 });
    expect((r.text.match(/Layer y=/g) ?? []).length).toBe(4);
    expect(r.text).toContain('26 more layers omitted');
  });
});
