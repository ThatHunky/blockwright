import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { rotateState, mirrorState, rotatePos, mirrorPos, transformSet, transformAnchored, stepsFromDegrees } from '../../src/voxel/rotate.js';

const st = (s: string) => BlockState.parse(s);

describe('rotateState', () => {
  it('cycles facing clockwise', () => {
    expect(rotateState(st('oak_stairs[facing=north]'), 1).props.facing).toBe('east');
    expect(rotateState(st('oak_stairs[facing=north]'), 2).props.facing).toBe('south');
    expect(rotateState(st('oak_stairs[facing=north]'), 3).props.facing).toBe('west');
    expect(rotateState(st('oak_stairs[facing=north]'), 0).props.facing).toBe('north');
    expect(rotateState(st('hopper[facing=down]'), 1).props.facing).toBe('down');
  });
  it('swaps log axis and keeps y', () => {
    expect(rotateState(st('oak_log[axis=x]'), 1).props.axis).toBe('z');
    expect(rotateState(st('oak_log[axis=z]'), 1).props.axis).toBe('x');
    expect(rotateState(st('oak_log[axis=y]'), 1).props.axis).toBe('y');
  });
  it('adds 4 to sign rotation modulo 16', () => {
    expect(rotateState(st('oak_sign[rotation=14]'), 1).props.rotation).toBe('2');
  });
  it('rotates rail shapes and leaves stair shapes alone', () => {
    expect(rotateState(st('rail[shape=north_east]'), 1).props.shape).toBe('south_east');
    expect(rotateState(st('rail[shape=north_south]'), 1).props.shape).toBe('east_west');
    expect(rotateState(st('rail[shape=ascending_north]'), 1).props.shape).toBe('ascending_east');
    expect(rotateState(st('oak_stairs[facing=north,shape=inner_left]'), 1).props.shape).toBe('inner_left');
  });
  it('shifts wall sides', () => {
    const w = rotateState(st('cobblestone_wall[east=none,north=low,south=none,west=tall]'), 1);
    expect(w.props).toEqual({ east: 'low', north: 'tall', south: 'none', west: 'none' });
    const f = rotateState(st('oak_fence[north=true]'), 1);
    expect(f.props).toEqual({ east: 'true' });
  });
});

describe('mirrorState', () => {
  it('flips facing on the mirrored axis only', () => {
    expect(mirrorState(st('oak_stairs[facing=east]'), 'x').props.facing).toBe('west');
    expect(mirrorState(st('oak_stairs[facing=north]'), 'x').props.facing).toBe('north');
    expect(mirrorState(st('oak_stairs[facing=north]'), 'z').props.facing).toBe('south');
  });
  it('swaps wall sides and stair handedness and door hinge', () => {
    expect(mirrorState(st('oak_fence[east=true,west=false]'), 'x').props).toEqual({ east: 'false', west: 'true' });
    expect(mirrorState(st('oak_stairs[facing=north,shape=inner_left]'), 'x').props.shape).toBe('inner_right');
    expect(mirrorState(st('oak_door[hinge=left]'), 'z').props.hinge).toBe('right');
  });
  it('mirrors sign rotation', () => {
    expect(mirrorState(st('oak_sign[rotation=4]'), 'x').props.rotation).toBe('12');
    expect(mirrorState(st('oak_sign[rotation=0]'), 'z').props.rotation).toBe('8');
    expect(mirrorState(st('oak_sign[rotation=4]'), 'z').props.rotation).toBe('4');
  });
  it('mirrors rail shapes', () => {
    expect(mirrorState(st('rail[shape=north_east]'), 'x').props.shape).toBe('north_west');
    expect(mirrorState(st('rail[shape=north_east]'), 'z').props.shape).toBe('south_east');
    expect(mirrorState(st('rail[shape=ascending_east]'), 'x').props.shape).toBe('ascending_west');
  });
});

describe('positions and sets', () => {
  it('rotates positions clockwise seen from above', () => {
    expect(rotatePos([1, 5, 0], 1)).toEqual([0, 5, 1]);
    expect(rotatePos([0, 5, 1], 1)).toEqual([-1, 5, 0]);
    expect(rotatePos([1, 5, 0], 4 as never)).toEqual([1, 5, 0]);
  });
  it('mirrors positions', () => {
    expect(mirrorPos([3, 1, 2], 'x')).toEqual([-3, 1, 2]);
    expect(mirrorPos([3, 1, 2], 'z')).toEqual([3, 1, -2]);
    expect(mirrorPos([3, 1, 2], 'none')).toEqual([3, 1, 2]);
  });
  it('converts degrees to steps', () => {
    expect(stepsFromDegrees(270)).toBe(3);
  });
  it('transformSet rotates blocks and positions together', () => {
    const v = new VoxelSet();
    v.set(2, 0, 0, st('oak_stairs[facing=north]'));
    const t = transformSet(v, 1, 'none');
    const [[p, s]] = [...t.entries()];
    expect(p).toEqual([0, 0, 2]);
    expect(s.props.facing).toBe('east');
  });
  it('transformAnchored keeps the min corner', () => {
    const v = new VoxelSet();
    for (let x = 0; x < 5; x++) for (let z = 0; z < 2; z++) v.set(x + 10, 3, z + 20, st('stone'));
    const t = transformAnchored(v, 1, 'none');
    expect(t.bounds()).toEqual({ min: [10, 3, 20], max: [11, 3, 24] });
    const m = transformAnchored(v, 0, 'x');
    expect(m.bounds()).toEqual({ min: [10, 3, 20], max: [14, 3, 21] });
  });
});
