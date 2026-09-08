import { BlockState, VoxelSet, type Vec3 } from './voxels.js';

/** Clockwise quarter turns seen from above (+y). Matches vanilla clockwise_90. */
export type RotationSteps = 0 | 1 | 2 | 3;
export type Mirror = 'none' | 'x' | 'z';

export function stepsFromDegrees(deg: 0 | 90 | 180 | 270): RotationSteps {
  return (deg / 90) as RotationSteps;
}

const FACING_CW: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const RAIL_CW: Record<string, string> = {
  north_south: 'east_west',
  east_west: 'north_south',
  ascending_north: 'ascending_east',
  ascending_east: 'ascending_south',
  ascending_south: 'ascending_west',
  ascending_west: 'ascending_north',
  north_east: 'south_east',
  south_east: 'south_west',
  south_west: 'north_west',
  north_west: 'north_east',
};
const SIDES = ['north', 'east', 'south', 'west'] as const;
const STAIR_MIRROR: Record<string, string> = {
  inner_left: 'inner_right',
  inner_right: 'inner_left',
  outer_left: 'outer_right',
  outer_right: 'outer_left',
};
const RAIL_MIRROR: Record<Exclude<Mirror, 'none'>, Record<string, string>> = {
  x: {
    ascending_east: 'ascending_west',
    ascending_west: 'ascending_east',
    north_east: 'north_west',
    north_west: 'north_east',
    south_east: 'south_west',
    south_west: 'south_east',
  },
  z: {
    ascending_north: 'ascending_south',
    ascending_south: 'ascending_north',
    north_east: 'south_east',
    south_east: 'north_east',
    north_west: 'south_west',
    south_west: 'north_west',
  },
};

function rotateOnce(s: BlockState): BlockState {
  const p: Record<string, string> = { ...s.props };
  if (p.facing !== undefined && FACING_CW[p.facing]) p.facing = FACING_CW[p.facing];
  if (p.axis === 'x') p.axis = 'z';
  else if (p.axis === 'z') p.axis = 'x';
  if (p.rotation !== undefined) p.rotation = String((Number(p.rotation) + 4) % 16);
  if (p.shape !== undefined && RAIL_CW[p.shape]) p.shape = RAIL_CW[p.shape];
  if (SIDES.some((k) => k in s.props)) {
    for (const k of SIDES) delete p[k];
    SIDES.forEach((from, i) => {
      const to = SIDES[(i + 1) % 4];
      if (from in s.props) p[to] = s.props[from];
    });
  }
  return new BlockState(s.name, p);
}

export function rotateState(s: BlockState, steps: RotationSteps): BlockState {
  let out = s;
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) out = rotateOnce(out);
  return out;
}

export function mirrorState(s: BlockState, mirror: Mirror): BlockState {
  if (mirror === 'none') return s;
  const p: Record<string, string> = { ...s.props };
  const [a, b] = mirror === 'x' ? (['east', 'west'] as const) : (['north', 'south'] as const);
  if (p.facing === a) p.facing = b;
  else if (p.facing === b) p.facing = a;
  if (a in s.props || b in s.props) {
    const va = s.props[a];
    const vb = s.props[b];
    delete p[a];
    delete p[b];
    if (vb !== undefined) p[a] = vb;
    if (va !== undefined) p[b] = va;
  }
  if (p.rotation !== undefined) {
    const r = Number(p.rotation);
    p.rotation = String(mirror === 'x' ? (16 - r) % 16 : (24 - r) % 16);
  }
  if (p.shape !== undefined) p.shape = RAIL_MIRROR[mirror][p.shape] ?? STAIR_MIRROR[p.shape] ?? p.shape;
  if (p.hinge === 'left') p.hinge = 'right';
  else if (p.hinge === 'right') p.hinge = 'left';
  return new BlockState(s.name, p);
}

function noNegZero(n: number): number {
  return n === 0 ? 0 : n;
}

export function rotatePos(p: Vec3, steps: RotationSteps): Vec3 {
  let [x, z] = [p[0], p[2]];
  for (let i = 0; i < ((steps % 4) + 4) % 4; i++) [x, z] = [-z, x];
  return [noNegZero(x), p[1], noNegZero(z)];
}

export function mirrorPos(p: Vec3, mirror: Mirror): Vec3 {
  if (mirror === 'x') return [noNegZero(-p[0]), p[1], p[2]];
  if (mirror === 'z') return [p[0], p[1], noNegZero(-p[2])];
  return [p[0], p[1], p[2]];
}

/** Mirror, then rotate, about (0,0,0). */
export function transformSet(set: VoxelSet, steps: RotationSteps, mirror: Mirror): VoxelSet {
  if (steps === 0 && mirror === 'none') return set.clone();
  const out = new VoxelSet();
  for (const [p, s] of set.entries()) {
    const rp = rotatePos(mirrorPos(p, mirror), steps);
    out.set(rp[0], rp[1], rp[2], rotateState(mirrorState(s, mirror), steps));
  }
  return out;
}

/** Like transformSet, then shifted so the bounding box min x/z are unchanged. */
export function transformAnchored(set: VoxelSet, steps: RotationSteps, mirror: Mirror): VoxelSet {
  const before = set.bounds();
  if (!before) return new VoxelSet();
  const t = transformSet(set, steps, mirror);
  const after = t.bounds()!;
  return t.translate(before.min[0] - after.min[0], 0, before.min[2] - after.min[2]);
}
