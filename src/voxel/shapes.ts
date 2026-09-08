import { z } from 'zod';
import { BlockState, VoxelSet, type Vec3 } from './voxels.js';
import { Vec3Schema } from './schemas.js';

/** Sanity caps on individual dimensions; the real guard against runaway allocations is the
 * voxel-count check in shapeToVoxels (BLOCKWRIGHT_MAX_VOXELS), since these can still combine
 * to exceed it (e.g. radius, radius_y and radius_z all at their max). */
const MAX_RADIUS = 256;
const MAX_HEIGHT = 512;
const MAX_SIZE = 512;
const MAX_THICKNESS = 128;

export const shapeShape = {
  shape: z.enum(['sphere', 'dome', 'cylinder', 'cone', 'pyramid', 'line', 'circle']),
  block: z.string().describe('Block state, e.g. "stone" or "oak_log[axis=y]"'),
  center: Vec3Schema.optional().describe('sphere: center; dome: center of the flat base; circle: center'),
  base: Vec3Schema.optional().describe('cylinder/cone: center of the bottom disk; pyramid: min corner of the base square'),
  from: Vec3Schema.optional().describe('line start'),
  to: Vec3Schema.optional().describe('line end'),
  radius: z.number().min(0.5).max(MAX_RADIUS).optional().describe(`Radius in blocks along x (diameter = 2r+1), up to ${MAX_RADIUS}`),
  radius_y: z.number().min(0.5).max(MAX_RADIUS).optional().describe('sphere/dome: vertical radius, defaults to radius'),
  radius_z: z.number().min(0.5).max(MAX_RADIUS).optional().describe('Radius along z, defaults to radius'),
  height: z.number().int().min(1).max(MAX_HEIGHT).optional().describe(`cylinder/cone/pyramid height in blocks, up to ${MAX_HEIGHT}`),
  size: z.number().int().min(1).max(MAX_SIZE).optional().describe(`pyramid: base side length, up to ${MAX_SIZE}`),
  hollow: z.boolean().default(false),
  thickness: z.number().int().min(1).max(MAX_THICKNESS).default(1).describe('Wall thickness when hollow'),
};
export const ShapeSpecSchema = z.object(shapeShape);
export type ShapeSpec = z.infer<typeof ShapeSpecSchema>;

export class ShapeError extends Error {}

/** Fallback voxel-count cap, overridable via BLOCKWRIGHT_MAX_VOXELS. */
export const DEFAULT_MAX_VOXELS = 5_000_000;
const MAX_VOXELS_ENV_VAR = 'BLOCKWRIGHT_MAX_VOXELS';

function maxVoxels(): number {
  const raw = process.env[MAX_VOXELS_ENV_VAR];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_VOXELS;
}

/** Rough upper-bound estimate of how many voxels a spec would produce, computed without
 * generating anything, so it can reject an oversized request before doing any real work. */
function estimateVoxels(spec: ShapeSpec): number {
  const r = spec.radius ?? 0;
  const ry = spec.radius_y ?? r;
  const rz = spec.radius_z ?? r;
  const h = spec.height ?? 0;
  const size = spec.size ?? 0;
  switch (spec.shape) {
    case 'sphere':
      return Math.ceil((4 / 3) * Math.PI * (r + 0.5) * (ry + 0.5) * (rz + 0.5));
    case 'dome':
      return Math.ceil((2 / 3) * Math.PI * (r + 0.5) * (ry + 0.5) * (rz + 0.5));
    case 'cylinder':
      return Math.ceil(Math.PI * (r + 0.5) * (rz + 0.5) * Math.max(h, 1));
    case 'cone':
      // radius shrinks linearly to 0 over the height, so the average cross-section is ~1/3 of the base
      return Math.ceil((Math.PI * (r + 0.5) * (rz + 0.5) * Math.max(h, 1)) / 3);
    case 'pyramid': {
      const hh = h || Math.ceil(size / 2);
      return size * size * Math.max(hh, 1);
    }
    case 'line': {
      if (!spec.from || !spec.to) return 0;
      const steps = Math.max(Math.abs(spec.to[0] - spec.from[0]), Math.abs(spec.to[1] - spec.from[1]), Math.abs(spec.to[2] - spec.from[2]));
      const stamp = Math.floor((spec.thickness - 1) / 2);
      const perPoint = stamp === 0 ? 1 : Math.ceil((4 / 3) * Math.PI * Math.pow(stamp + 0.5, 3));
      return (steps + 1) * perPoint;
    }
    case 'circle':
      return Math.ceil(Math.PI * (r + 0.5) * (rz + 0.5));
  }
}

function need<T>(v: T | undefined, what: string, shape: string): T {
  if (v === undefined) throw new ShapeError(`${shape} needs ${what}`);
  return v;
}

function inside2(dx: number, dz: number, rx: number, rz: number): boolean {
  return (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz) <= 1;
}

function inside3(dx: number, dy: number, dz: number, rx: number, ry: number, rz: number): boolean {
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz) <= 1;
}

/** Horizontal disk; wall=0 fills it, wall>0 keeps a ring of that thickness. */
function disk(cx: number, cz: number, r: number, rz: number, wall: number, put: (x: number, z: number) => void): void {
  const RX = r + 0.5;
  const RZ = rz + 0.5;
  const ix = Math.max(RX - wall, 0);
  const iz = Math.max(RZ - wall, 0);
  const ex = Math.ceil(r);
  const ez = Math.ceil(rz);
  for (let dx = -ex; dx <= ex; dx++) {
    for (let dz = -ez; dz <= ez; dz++) {
      if (!inside2(dx, dz, RX, RZ)) continue;
      if (wall > 0 && inside2(dx, dz, ix, iz)) continue;
      put(cx + dx, cz + dz);
    }
  }
}

function ellipsoid(c: Vec3, r: number, ry: number, rz: number, wall: number, upperHalf: boolean, put: (x: number, y: number, z: number) => void): void {
  const RX = r + 0.5;
  const RY = ry + 0.5;
  const RZ = rz + 0.5;
  const ix = Math.max(RX - wall, 0);
  const iy = Math.max(RY - wall, 0);
  const iz = Math.max(RZ - wall, 0);
  for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
    for (let dy = upperHalf ? 0 : -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
      for (let dz = -Math.ceil(rz); dz <= Math.ceil(rz); dz++) {
        if (!inside3(dx, dy, dz, RX, RY, RZ)) continue;
        if (wall > 0 && inside3(dx, dy, dz, ix, iy, iz)) continue;
        put(c[0] + dx, c[1] + dy, c[2] + dz);
      }
    }
  }
}

export function shapeToVoxels(spec: ShapeSpec): VoxelSet {
  const cap = maxVoxels();
  const estimate = estimateVoxels(spec);
  if (estimate > cap) {
    throw new ShapeError(
      `${spec.shape} would produce approximately ${estimate.toLocaleString()} voxels, which exceeds the ${cap.toLocaleString()} voxel limit. ` +
        `Reduce its size, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`,
    );
  }
  const block = BlockState.parse(spec.block);
  const out = new VoxelSet();
  let count = 0;
  const put = (x: number, y: number, z: number) => {
    count++;
    if (count > cap) {
      throw new ShapeError(
        `${spec.shape} would produce more than ${cap.toLocaleString()} voxels, exceeding the ${cap.toLocaleString()} voxel limit. ` +
          `Reduce its size, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`,
      );
    }
    out.set(x, y, z, block);
  };
  const wall = spec.hollow ? spec.thickness : 0;
  switch (spec.shape) {
    case 'sphere':
    case 'dome': {
      const c = need(spec.center, 'center', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      ellipsoid(c, r, spec.radius_y ?? r, spec.radius_z ?? r, wall, spec.shape === 'dome', put);
      break;
    }
    case 'cylinder':
    case 'cone': {
      const b = need(spec.base, 'base', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      const rz = spec.radius_z ?? r;
      const h = need(spec.height, 'height', spec.shape);
      for (let i = 0; i < h; i++) {
        const f = spec.shape === 'cone' ? 1 - i / h : 1;
        disk(b[0], b[2], r * f, rz * f, wall, (x, z) => put(x, b[1] + i, z));
      }
      break;
    }
    case 'pyramid': {
      const b = need(spec.base, 'base', spec.shape);
      const size = need(spec.size, 'size', spec.shape);
      const h = spec.height ?? Math.ceil(size / 2);
      for (let i = 0; i < h; i++) {
        const inset = h === 1 ? 0 : Math.round((i * ((size - 1) / 2)) / (h - 1));
        const lo = inset;
        const hi = size - 1 - inset;
        if (lo > hi) break;
        for (let x = lo; x <= hi; x++) {
          for (let z = lo; z <= hi; z++) {
            if (spec.hollow && x !== lo && x !== hi && z !== lo && z !== hi) continue;
            put(b[0] + x, b[1] + i, b[2] + z);
          }
        }
      }
      break;
    }
    case 'line': {
      const a = need(spec.from, 'from', spec.shape);
      const b = need(spec.to, 'to', spec.shape);
      const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
      const stamp = Math.floor((spec.thickness - 1) / 2);
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const p: Vec3 = [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
        if (stamp === 0) put(p[0], p[1], p[2]);
        else ellipsoid(p, stamp, stamp, stamp, 0, false, put);
      }
      break;
    }
    case 'circle': {
      const c = need(spec.center, 'center', spec.shape);
      const r = need(spec.radius, 'radius', spec.shape);
      disk(c[0], c[2], r, spec.radius_z ?? r, wall, (x, z) => put(x, c[1], z));
      break;
    }
  }
  return out;
}
