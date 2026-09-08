import { describe, it, expect } from 'vitest';
import { ShapeSpecSchema, shapeToVoxels, ShapeError } from '../../src/voxel/shapes.js';

const gen = (input: unknown) => shapeToVoxels(ShapeSpecSchema.parse(input));

describe('shapes', () => {
  it('sphere', () => {
    const v = gen({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone' });
    expect(v.size).toBe(81);
    expect(v.bounds()).toEqual({ min: [-2, -2, -2], max: [2, 2, 2] });
    expect(gen({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone', hollow: true }).size).toBe(62);
  });
  it('dome is the upper half including the base layer', () => {
    expect(gen({ shape: 'dome', center: [0, 10, 0], radius: 2, block: 'stone' }).size).toBe(51);
  });
  it('cylinder and cone', () => {
    expect(gen({ shape: 'cylinder', base: [0, 0, 0], radius: 1, height: 3, block: 'stone' }).size).toBe(27);
    expect(gen({ shape: 'cylinder', base: [0, 0, 0], radius: 1, height: 3, block: 'stone', hollow: true }).size).toBe(24);
    expect(gen({ shape: 'cone', base: [0, 0, 0], radius: 2, height: 3, block: 'stone' }).size).toBe(35);
  });
  it('pyramid', () => {
    const v = gen({ shape: 'pyramid', base: [0, 0, 0], size: 5, block: 'sandstone' });
    expect(v.size).toBe(35);
    expect(v.bounds()).toEqual({ min: [0, 0, 0], max: [4, 2, 4] });
    expect(gen({ shape: 'pyramid', base: [0, 0, 0], size: 5, block: 'sandstone', hollow: true }).size).toBe(25);
  });
  it('line and circle', () => {
    const l = gen({ shape: 'line', from: [0, 0, 0], to: [3, 1, 0], block: 'stone' });
    expect(l.size).toBe(4);
    expect(l.has(3, 1, 0)).toBe(true);
    expect(gen({ shape: 'circle', center: [0, 5, 0], radius: 1, block: 'stone', hollow: true }).size).toBe(8);
    expect(gen({ shape: 'circle', center: [0, 5, 0], radius: 1, block: 'stone' }).size).toBe(9);
  });
  it('rejects missing fields', () => {
    expect(() => gen({ shape: 'sphere', radius: 2, block: 'stone' })).toThrow(ShapeError);
    expect(() => gen({ shape: 'sphere', radius: 2, block: 'stone' })).toThrow(/sphere needs center/);
    expect(() => gen({ shape: 'cylinder', base: [0, 0, 0], radius: 2, block: 'stone' })).toThrow(/cylinder needs height/);
  });
  it('bounds shape dimensions in the schema so an AI caller cannot request an unbounded allocation', () => {
    expect(() => ShapeSpecSchema.parse({ shape: 'sphere', center: [0, 0, 0], radius: 5000, block: 'stone' })).toThrow();
    expect(() => ShapeSpecSchema.parse({ shape: 'pyramid', base: [0, 0, 0], size: 100000, block: 'stone' })).toThrow();
    expect(() => ShapeSpecSchema.parse({ shape: 'cylinder', base: [0, 0, 0], radius: 2, height: 1000000, block: 'stone' })).toThrow();
    expect(() => ShapeSpecSchema.parse({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone', thickness: 999999, hollow: true })).toThrow();
    // still within bounds
    expect(() => ShapeSpecSchema.parse({ shape: 'sphere', center: [0, 0, 0], radius: 256, block: 'stone' })).not.toThrow();
  });
  it('rejects a shape whose voxel count would exceed the cap, naming the size, cap and env var', () => {
    // radius at the schema max on all axes produces ~70M voxels, well past the 5,000,000 default cap
    expect(() => gen({ shape: 'sphere', center: [0, 0, 0], radius: 256, block: 'stone' })).toThrow(ShapeError);
    let threw = false;
    try {
      gen({ shape: 'sphere', center: [0, 0, 0], radius: 256, block: 'stone' });
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      expect(msg).toMatch(/70,6\d\d,\d\d\d voxels/);
      expect(msg).toMatch(/5,000,000 voxel limit/);
      expect(msg).toMatch(/BLOCKWRIGHT_MAX_VOXELS/);
    }
    expect(threw).toBe(true);
  });
  it('honours BLOCKWRIGHT_MAX_VOXELS to raise or lower the cap', () => {
    const prev = process.env.BLOCKWRIGHT_MAX_VOXELS;
    try {
      process.env.BLOCKWRIGHT_MAX_VOXELS = '10';
      expect(() => gen({ shape: 'sphere', center: [0, 0, 0], radius: 2, block: 'stone' })).toThrow(/10 voxel limit/);
      // a straight line of 2,000,001 voxels exceeds a 1,000,000 cap but fits comfortably once raised to 3,000,000
      process.env.BLOCKWRIGHT_MAX_VOXELS = '1000000';
      expect(() => gen({ shape: 'line', from: [0, 0, 0], to: [2000000, 0, 0], block: 'stone' })).toThrow(/1,000,000 voxel limit/);
      process.env.BLOCKWRIGHT_MAX_VOXELS = '3000000';
      expect(() => gen({ shape: 'line', from: [0, 0, 0], to: [2000000, 0, 0], block: 'stone' })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.BLOCKWRIGHT_MAX_VOXELS;
      else process.env.BLOCKWRIGHT_MAX_VOXELS = prev;
    }
  });
});
