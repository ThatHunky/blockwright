import { describe, it, expect } from 'vitest';
import { VoxelSet, BlockState } from '../../src/voxel/voxels.js';
import { renderScene, VIEWS } from '../../src/render/scene.js';

function cube(block = 'stone'): VoxelSet {
  const s = new VoxelSet();
  s.set(0, 0, 0, BlockState.parse(block));
  return s;
}

function solid(w: number, h: number, d: number, block = 'stone'): VoxelSet {
  const s = new VoxelSet();
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) s.set(x, y, z, BlockState.parse(block));
  return s;
}

function pixel(scene: { width: number; pixels: Uint8Array }, x: number, y: number): [number, number, number] {
  const i = (y * scene.width + x) * 3;
  return [scene.pixels[i], scene.pixels[i + 1], scene.pixels[i + 2]];
}

function painted(scene: { width: number; height: number; pixels: Uint8Array }, bg: [number, number, number]): number {
  let n = 0;
  for (let i = 0; i < scene.width * scene.height; i++) {
    const p: [number, number, number] = [scene.pixels[i * 3], scene.pixels[i * 3 + 1], scene.pixels[i * 3 + 2]];
    if (p[0] !== bg[0] || p[1] !== bg[1] || p[2] !== bg[2]) n++;
  }
  return n;
}

const BG: [number, number, number] = [150, 180, 215];

describe('renderScene', () => {
  it('renders every camera without blowing up', () => {
    for (const view of VIEWS) {
      const scene = renderScene(solid(3, 3, 3), { view, scale: 6 });
      expect(scene.width).toBeGreaterThan(0);
      expect(scene.height).toBeGreaterThan(0);
      expect(scene.pixels.length).toBe(scene.width * scene.height * 3);
      expect(painted(scene, BG)).toBeGreaterThan(0);
    }
  });

  it('shades the three visible faces of a cube differently', () => {
    const scene = renderScene(cube(), { view: 'iso_se', scale: 16 });
    const seen = new Set<string>();
    for (let y = 0; y < scene.height; y++) {
      for (let x = 0; x < scene.width; x++) {
        const p = pixel(scene, x, y);
        if (p[0] !== BG[0] || p[1] !== BG[1] || p[2] !== BG[2]) seen.add(p.join(','));
      }
    }
    // top, and the two sides facing the camera
    expect(seen.size).toBe(3);
  });

  it('shows only the top face from directly above', () => {
    const scene = renderScene(cube(), { view: 'top', scale: 12 });
    const seen = new Set<string>();
    for (let i = 0; i < scene.width * scene.height; i++) {
      const p = [scene.pixels[i * 3], scene.pixels[i * 3 + 1], scene.pixels[i * 3 + 2]];
      if (p[0] !== BG[0] || p[1] !== BG[1] || p[2] !== BG[2]) seen.add(p.join(','));
    }
    expect(seen.size).toBe(1);
  });

  it('draws a fence as far fewer pixels than a full block', () => {
    const post = renderScene(cube('spruce_fence'), { view: 'iso_se', scale: 16 });
    const block = renderScene(cube('spruce_planks'), { view: 'iso_se', scale: 16 });
    expect(painted(post, BG)).toBeLessThan(painted(block, BG) * 0.4);
  });

  it('skips blocks that are completely walled in', () => {
    // A 3x3x3 solid has exactly one buried block; only the 26 on the shell are worth drawing.
    expect(renderScene(solid(3, 3, 3), { view: 'iso_se', scale: 4 }).blocks).toBe(26);
  });

  it('hides blocks by name and by prefix glob', () => {
    const s = solid(2, 1, 2, 'stone');
    s.set(0, 1, 0, BlockState.parse('oak_leaves'));
    s.set(1, 1, 1, BlockState.parse('spruce_leaves'));
    expect(renderScene(s, { view: 'top', scale: 4 }).blocks).toBe(6);
    expect(renderScene(s, { view: 'top', scale: 4, hide: ['oak_leaves'] }).blocks).toBe(5);
    expect(renderScene(s, { view: 'top', scale: 4, hide: ['*_leaves'] }).blocks).toBe(4);
  });

  it('cuts the roof off at cutaway_y', () => {
    const s = solid(2, 4, 2);
    expect(renderScene(s, { view: 'iso_se', scale: 4, cutawayY: 1 }).blocks).toBe(8);
  });

  it('fits the image inside max_pixels when no scale is given', () => {
    const scene = renderScene(solid(40, 4, 40), { view: 'top', maxPixels: 200 });
    expect(Math.max(scene.width, scene.height)).toBeLessThanOrEqual(220);
    expect(scene.scale).toBeGreaterThanOrEqual(1);
  });

  it('honours an explicit background', () => {
    const scene = renderScene(cube(), { view: 'top', scale: 4, background: [0, 0, 0] });
    expect(pixel(scene, 0, 0)).toEqual([0, 0, 0]);
  });

  it('draws a taller stack taller from a side view', () => {
    const short = renderScene(solid(1, 1, 1), { view: 'north', scale: 8 });
    const tall = renderScene(solid(1, 5, 1), { view: 'north', scale: 8 });
    expect(tall.height).toBeGreaterThan(short.height * 3);
    expect(tall.width).toBe(short.width);
  });

  it('is deterministic', () => {
    const a = renderScene(solid(4, 3, 4), { view: 'iso_nw', scale: 5 });
    const b = renderScene(solid(4, 3, 4), { view: 'iso_nw', scale: 5 });
    expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels))).toBe(true);
  });

  it('says so plainly when there is nothing to draw', () => {
    expect(() => renderScene(new VoxelSet(), { view: 'top' })).toThrow(/empty/);
    expect(() => renderScene(cube('air'), { view: 'top' })).toThrow(/air or hidden/);
  });
});
