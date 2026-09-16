/**
 * Scattering: flowers, grass, bushes and boulders placed on the ground and nowhere else.
 *
 * The one rule this module exists to enforce is that nothing floats. Every voxel it emits is
 * either sitting directly on a column's real ground surface, or directly on another voxel it
 * emitted in the same sub-column — so "a flower hovering two blocks above the hillside" is
 * not a bug that can be introduced by a bad density or a bad seed, it is unrepresentable.
 * `supportIssues` below checks exactly that invariant and is asserted in the tests.
 *
 * Placement is a pure function of (x, z, seed): previewing with dry_run and then applying
 * for real puts every plant in the same place.
 */

import { BlockState, VoxelSet } from '../voxel/voxels.js';
import { hash2 } from './noise.js';
import { CELL_AIR, CELL_GROUND, cellAt, columnSlope, type ColumnGrid } from './columns.js';

/** Plants that occupy two blocks and need half=lower / half=upper to survive placement. */
export const DOUBLE_PLANTS = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'pitcher_plant']);

export interface ScatterEntry {
  block: BlockState;
  /** Relative chance of this entry being the one placed. Default 1. */
  weight: number;
  /** 0 places a single block (or a two-block plant); 1-3 places a boulder of that radius. */
  radius: number;
}

export interface ScatterOptions {
  palette: ScatterEntry[];
  /** Chance per eligible column, 0-1. */
  density: number;
  seed: number;
  /** Skip columns whose ground differs from a 4-neighbour by more than this. */
  maxSlope?: number;
  /** Only place on these ground blocks (short names). Empty = any solid ground. */
  on?: Set<string>;
  /** Minimum Chebyshev distance in columns between two placements. */
  spacing: number;
  /** Stop after this many placements. */
  maxCount: number;
}

export interface ScatterVoxel {
  x: number;
  y: number;
  z: number;
  state: BlockState;
}

export interface ScatterResult {
  voxels: ScatterVoxel[];
  /** Columns that passed every eligibility test. */
  eligible: number;
  /** Columns that actually received something. */
  placements: number;
  rejectedSlope: number;
  rejectedGround: number;
  rejectedWater: number;
}

function pick(entries: ScatterEntry[], r: number): ScatterEntry {
  let total = 0;
  for (const e of entries) total += Math.max(0, e.weight);
  if (total <= 0) return entries[0];
  let acc = r * total;
  for (const e of entries) {
    acc -= Math.max(0, e.weight);
    if (acc <= 0) return e;
  }
  return entries[entries.length - 1];
}

/** How many air blocks sit directly above a column's ground surface, capped at `want`. */
function headroom(grid: ColumnGrid, xi: number, zi: number, want: number): number {
  const g = grid.ground[zi * grid.w + xi];
  let n = 0;
  while (n < want) {
    const y = g + 1 + n;
    if (y > grid.yMax) break;
    if (cellAt(grid, xi, zi, y) !== CELL_AIR) break;
    n++;
  }
  return n;
}

/**
 * Chooses placements column by column in a fixed order, so the output depends only on the
 * grid, the options and the seed.
 */
export function planScatter(grid: ColumnGrid, opts: ScatterOptions): ScatterResult {
  const out: ScatterVoxel[] = [];
  const taken = new Set<string>();
  let eligible = 0;
  let placements = 0;
  let rejectedSlope = 0;
  let rejectedGround = 0;
  let rejectedWater = 0;
  if (!opts.palette.length || opts.density <= 0) return { voxels: out, eligible, placements, rejectedSlope, rejectedGround, rejectedWater };

  const spaced = (xi: number, zi: number): boolean => {
    if (opts.spacing <= 0) return false;
    for (let dz = -opts.spacing; dz <= opts.spacing; dz++) {
      for (let dx = -opts.spacing; dx <= opts.spacing; dx++) {
        if (taken.has(`${xi + dx},${zi + dz}`)) return true;
      }
    }
    return false;
  };

  for (let zi = 0; zi < grid.h; zi++) {
    for (let xi = 0; xi < grid.w; xi++) {
      if (placements >= opts.maxCount) break;
      const i = zi * grid.w + xi;
      if (!grid.known[i] || grid.ground[i] < grid.yMin) continue;
      if (grid.water[i]) {
        rejectedWater++;
        continue;
      }
      if (opts.on && opts.on.size > 0 && !opts.on.has(grid.groundBlock[i])) {
        rejectedGround++;
        continue;
      }
      if (headroom(grid, xi, zi, 1) < 1) continue;
      if (opts.maxSlope !== undefined && columnSlope(grid, xi, zi) > opts.maxSlope) {
        rejectedSlope++;
        continue;
      }
      eligible++;
      const x = grid.minX + xi;
      const z = grid.minZ + zi;
      if (hash2(x, z, opts.seed) >= opts.density) continue;
      if (spaced(xi, zi)) continue;
      const entry = pick(opts.palette, hash2(x, z, (opts.seed ^ 0x5bf03635) | 0));
      const emitted = entry.radius > 0 ? boulder(grid, xi, zi, entry, out) : plant(grid, xi, zi, entry, out);
      if (!emitted) continue;
      taken.add(`${xi},${zi}`);
      placements++;
    }
  }
  return { voxels: out, eligible, placements, rejectedSlope, rejectedGround, rejectedWater };
}

/** One block on the ground, or the two halves of a double plant. */
function plant(grid: ColumnGrid, xi: number, zi: number, entry: ScatterEntry, out: ScatterVoxel[]): boolean {
  const g = grid.ground[zi * grid.w + xi];
  const x = grid.minX + xi;
  const z = grid.minZ + zi;
  const isDouble = DOUBLE_PLANTS.has(entry.block.shortName);
  const need = isDouble ? 2 : 1;
  if (headroom(grid, xi, zi, need) < need) return false;
  if (isDouble) {
    out.push({ x, y: g + 1, z, state: entry.block.with({ half: 'lower' }) });
    out.push({ x, y: g + 2, z, state: entry.block.with({ half: 'upper' }) });
  } else {
    out.push({ x, y: g + 1, z, state: entry.block });
  }
  return true;
}

/**
 * A rock that hugs the ground: each sub-column of the disk starts at its own local surface,
 * so the boulder is embedded in a slope instead of hovering over it. A sub-column starts one
 * block up unless the block under the surface is solid ground (so replacing the surface
 * block itself still leaves something underneath).
 */
function boulder(grid: ColumnGrid, xi: number, zi: number, entry: ScatterEntry, out: ScatterVoxel[]): boolean {
  const r = Math.max(1, Math.min(3, Math.round(entry.radius)));
  const cells: ScatterVoxel[] = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const sx = xi + dx;
      const sz = zi + dz;
      if (sx < 0 || sz < 0 || sx >= grid.w || sz >= grid.h) continue;
      const j = sz * grid.w + sx;
      if (!grid.known[j] || grid.ground[j] < grid.yMin) continue;
      if (grid.water[j]) continue;
      const rad2 = r * r + 0.25 - dx * dx - dz * dz;
      if (rad2 <= 0) continue;
      const height = Math.floor(Math.sqrt(rad2));
      const g = grid.ground[j];
      const buried = cellAt(grid, sx, sz, g - 1) === CELL_GROUND;
      const start = buried ? g : g + 1;
      const stack = height + (buried ? 1 : 0);
      if (stack <= 0) continue;
      if (headroom(grid, sx, sz, stack - (buried ? 1 : 0)) < stack - (buried ? 1 : 0)) continue;
      for (let k = 0; k < stack; k++) {
        const y = start + k;
        if (y > grid.yMax) break;
        cells.push({ x: grid.minX + sx, y, z: grid.minZ + sz, state: entry.block });
      }
    }
  }
  if (!cells.length) return false;
  out.push(...cells);
  return true;
}

export function scatterVoxelSet(result: ScatterResult): VoxelSet {
  const set = new VoxelSet();
  for (const v of result.voxels) set.set(v.x, v.y, v.z, v.state);
  return set;
}

/**
 * Every emitted voxel must rest on something: either another emitted voxel one block below,
 * or ground in the world. Returns the positions that fail, which should always be none — the
 * tests assert on it, and the tool reports it rather than placing a floating flower.
 */
export function supportIssues(grid: ColumnGrid, voxels: ScatterVoxel[]): ScatterVoxel[] {
  const placed = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
  const bad: ScatterVoxel[] = [];
  for (const v of voxels) {
    if (placed.has(`${v.x},${v.y - 1},${v.z}`)) continue;
    const xi = v.x - grid.minX;
    const zi = v.z - grid.minZ;
    if (xi < 0 || zi < 0 || xi >= grid.w || zi >= grid.h) {
      bad.push(v);
      continue;
    }
    if (cellAt(grid, xi, zi, v.y - 1) !== CELL_GROUND) bad.push(v);
  }
  return bad;
}
