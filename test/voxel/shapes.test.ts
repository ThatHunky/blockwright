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
});
