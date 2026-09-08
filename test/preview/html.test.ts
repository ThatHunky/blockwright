import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { renderHtml } from '../../src/preview/html.js';

const st = (s: string) => BlockState.parse(s);

describe('renderHtml', () => {
  it('embeds voxels, palette and controls without external resources', () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_planks'));
    const ctx = new VoxelSet();
    ctx.set(0, -1, 0, st('grass_block'));
    const html = renderHtml(v, { title: 'Test hut', context: ctx });
    expect(html).toContain('<title>Test hut</title>');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('"minecraft:stone"');
    expect(html).toContain('"minecraft:oak_planks"');
    expect(html).toContain('"context":[[0,-1,0,');
    expect(html).toContain('id="rotate"');
    expect(html).toContain('id="zoom"');
    expect(html).toContain('id="layer"');
    expect(html).toContain('id="context"');
    expect(html).toContain('<canvas');
  });
});
