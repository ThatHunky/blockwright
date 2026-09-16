import { describe, it, expect } from 'vitest';
import { BlockState } from '../../src/voxel/voxels.js';
import { blockBoxes, isFullOpaque, occludes } from '../../src/render/model.js';

const boxes = (s: string) => blockBoxes(BlockState.parse(s));
const height = (s: string) => Math.max(...boxes(s).map((b) => b.y1));

describe('blockBoxes', () => {
  it('draws a plain block as the whole cell', () => {
    expect(boxes('stone')).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }]);
    expect(isFullOpaque(BlockState.parse('stone'))).toBe(true);
  });

  it('halves a slab and puts a top slab on top', () => {
    expect(boxes('oak_slab[type=bottom]')).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 1 }]);
    expect(boxes('oak_slab[type=top]')[0].y0).toBe(0.5);
    expect(boxes('oak_slab[type=double]')).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }]);
  });

  it('gives stairs a base and a step on the facing side', () => {
    const b = boxes('spruce_stairs[facing=east,half=bottom]');
    expect(b).toHaveLength(2);
    expect(b[0].y1).toBe(0.5);
    expect(b[1].x0).toBe(0.5);
    expect(b[1].y0).toBe(0.5);
  });

  it('turns a fence into a thin post plus the sides it connects to', () => {
    const alone = boxes('spruce_fence');
    expect(alone).toHaveLength(1);
    expect(alone[0].x1 - alone[0].x0).toBeLessThan(0.3);
    const joined = boxes('spruce_fence[north=true,south=true]');
    expect(joined).toHaveLength(3);
  });

  it('keeps lanterns, torches and plants small so they do not read as cubes', () => {
    expect(height('lantern')).toBeLessThan(0.7);
    expect(height('torch')).toBeLessThan(0.7);
    expect(height('short_grass')).toBeLessThan(0.8);
    expect(height('tall_grass')).toBe(1);
  });

  it('scales a snow layer with its depth', () => {
    expect(height('snow[layers=1]')).toBeCloseTo(0.125);
    expect(height('snow[layers=8]')).toBeCloseTo(1);
  });

  it('drops air and other blocks with nothing to draw', () => {
    expect(boxes('air')).toEqual([]);
    expect(boxes('cave_air')).toEqual([]);
    expect(boxes('barrier')).toEqual([]);
  });

  it('draws water just below the cell top so a pond is not a hole', () => {
    const w = boxes('water');
    expect(w).toHaveLength(1);
    expect(w[0].y1).toBeCloseTo(0.875);
    // ...but it must not cull the bank beside it the way a solid block would.
    expect(isFullOpaque(BlockState.parse('water'))).toBe(false);
    expect(occludes(BlockState.parse('water'))).toBe(true);
  });

  it('does not treat see-through or part-cell blocks as opaque fill', () => {
    for (const s of ['glass', 'oak_slab[type=bottom]', 'spruce_fence', 'lantern', 'air', 'water', 'ice']) {
      expect(isFullOpaque(BlockState.parse(s))).toBe(false);
    }
  });

  it('falls back to a full cube for blocks it has never heard of', () => {
    expect(blockBoxes(BlockState.parse('somemod:strange_thing'))).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }]);
  });
});
