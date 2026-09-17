/**
 * Block access for the survey tools (walk, profile, slope), which look at a thin line or a
 * surface through the world rather than a box of it.
 *
 * A path can run for hundreds of blocks on a diagonal; reading its bounding box would mean
 * reading a square kilometre to look at one line. So the world is read one chunk at a time,
 * only over the y range actually needed, and kept as a compact slab (two bytes per block,
 * indices into one shared palette) in a small least-recently-used cache. Memory stays bounded
 * by the cache size no matter how long the path or how big the box.
 */

import type { BlockState, Box, VoxelSet } from '../voxel/voxels.js';
import { classifyBlock, CELL_CANOPY, CELL_GROUND, CELL_WATER } from './columns.js';
import { footing } from './footing.js';

export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 319;
/** Default cap on cached chunks. A full-height slab is ~200 KB, so this stays under ~13 MB. */
export const DEFAULT_CACHE_CHUNKS = 64;
/** How far below the MOTION_BLOCKING top a column is searched for real ground. Trees are the
 * reason: that heightmap stops at the canopy, and the tallest vanilla trees are ~30 blocks. */
export const GROUND_SEARCH_DEPTH = 96;

const UNKNOWN = 0xffff;

/** The two bridge calls the sampler needs, already bound to one world. */
export interface WorldReader {
  read(box: Box): Promise<{ voxels: VoxelSet; missingChunks: number }>;
  heightmap(minX: number, minZ: number, maxX: number, maxZ: number): Promise<{ heights: (number | null)[][] }>;
}

interface Slab {
  /** MOTION_BLOCKING top per column (z*16+x), undefined until asked for, null for a missing chunk. */
  tops?: Int16Array | null;
  lo: number;
  hi: number;
  data?: Uint16Array;
  missing: boolean;
}

export class ChunkCache {
  private readonly chunks = new Map<string, Slab>();
  private readonly palette: BlockState[] = [];
  private readonly paletteIndex = new Map<string, number>();
  /** Bridge calls made, for tests and for honest reporting of cost. */
  reads = 0;

  constructor(
    private readonly reader: WorldReader,
    private readonly maxChunks = DEFAULT_CACHE_CHUNKS,
  ) {}

  private slab(cx: number, cz: number): Slab {
    const k = `${cx},${cz}`;
    let s = this.chunks.get(k);
    if (s) {
      // Re-insert so Map iteration order is least-recently-used first.
      this.chunks.delete(k);
      this.chunks.set(k, s);
      return s;
    }
    while (this.chunks.size >= this.maxChunks) {
      const oldest = this.chunks.keys().next().value as string;
      this.chunks.delete(oldest);
    }
    s = { lo: 0, hi: -1, missing: false };
    this.chunks.set(k, s);
    return s;
  }

  /** MOTION_BLOCKING top of the column (highest block that is not a plant), or null when the chunk is not generated. */
  async top(x: number, z: number): Promise<number | null> {
    const s = this.slab(x >> 4, z >> 4);
    if (s.tops === undefined) {
      const x0 = (x >> 4) * 16;
      const z0 = (z >> 4) * 16;
      this.reads++;
      const r = await this.reader.heightmap(x0, z0, x0 + 15, z0 + 15);
      if (r.heights.every((row) => row.every((h) => h === null))) {
        s.tops = null;
        s.missing = true;
      } else {
        const tops = new Int16Array(256);
        for (let zi = 0; zi < 16; zi++) for (let xi = 0; xi < 16; xi++) tops[zi * 16 + xi] = r.heights[zi]?.[xi] ?? WORLD_MIN_Y - 1;
        s.tops = tops;
      }
    }
    return s.tops === null ? null : s.tops[((z & 15) << 4) | (x & 15)];
  }

  /**
   * Makes sure the column's chunk is held over at least lo..hi. Returns false when the chunk is
   * not generated. Reads are rounded out to whole sections, and a downward extension takes at
   * least 32 rows, so a search that creeps down a column costs a few reads, not one per block.
   */
  async ensure(x: number, z: number, lo: number, hi: number): Promise<boolean> {
    const s = this.slab(x >> 4, z >> 4);
    if (s.missing) return false;
    lo = Math.max(WORLD_MIN_Y, Math.min(lo, hi));
    hi = Math.min(WORLD_MAX_Y, Math.max(lo, hi));
    if (s.data && lo >= s.lo && hi <= s.hi) return true;

    if (!s.data && s.tops) {
      // First read of a chunk whose heightmap is known: take the whole chunk's surface band at
      // once, so the next column over does not need a read of its own.
      let minTop = Infinity;
      let maxTop = -Infinity;
      for (const t of s.tops) {
        if (t < WORLD_MIN_Y) continue;
        minTop = Math.min(minTop, t);
        maxTop = Math.max(maxTop, t);
      }
      if (minTop <= maxTop) {
        lo = Math.max(WORLD_MIN_Y, Math.min(lo, minTop - 16));
        hi = Math.min(WORLD_MAX_Y, Math.max(hi, maxTop + 4));
      }
    }
    let newLo = Math.floor(lo / 16) * 16;
    let newHi = Math.ceil((hi + 1) / 16) * 16 - 1;
    if (s.data) {
      if (newLo < s.lo) newLo = Math.min(newLo, s.lo - 32);
      newLo = Math.max(WORLD_MIN_Y, Math.min(newLo, s.lo));
      newHi = Math.min(WORLD_MAX_Y, Math.max(newHi, s.hi));
    } else {
      newLo = Math.max(WORLD_MIN_Y, newLo);
      newHi = Math.min(WORLD_MAX_Y, newHi);
    }
    const rows = newHi - newLo + 1;
    const data = new Uint16Array(256 * rows).fill(UNKNOWN);
    if (s.data) data.set(s.data, 256 * (s.lo - newLo));
    const x0 = (x >> 4) * 16;
    const z0 = (z >> 4) * 16;
    const pieces: Array<[number, number]> = s.data ? [[newLo, s.lo - 1], [s.hi + 1, newHi]] : [[newLo, newHi]];
    for (const [a, b] of pieces) {
      if (a > b) continue;
      this.reads++;
      const r = await this.reader.read({ min: [x0, a, z0], max: [x0 + 15, b, z0 + 15] });
      if (r.missingChunks > 0) {
        s.missing = true;
        s.data = undefined;
        return false;
      }
      for (let y = a; y <= b; y++) {
        const base = 256 * (y - newLo);
        for (let zi = 0; zi < 16; zi++) {
          for (let xi = 0; xi < 16; xi++) {
            const state = r.voxels.get(x0 + xi, y, z0 + zi);
            if (state) data[base + zi * 16 + xi] = this.indexOf(state);
          }
        }
      }
    }
    s.lo = newLo;
    s.hi = newHi;
    s.data = data;
    return true;
  }

  private indexOf(state: BlockState): number {
    const k = state.toString();
    let i = this.paletteIndex.get(k);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(state);
      this.paletteIndex.set(k, i);
    }
    return i;
  }

  /** The block, if its chunk is currently held over that y (call ensure first); undefined otherwise. */
  get(x: number, y: number, z: number): BlockState | undefined {
    const s = this.chunks.get(`${x >> 4},${z >> 4}`);
    if (!s?.data || y < s.lo || y > s.hi) return undefined;
    const v = s.data[256 * (y - s.lo) + (((z & 15) << 4) | (x & 15))];
    return v === UNKNOWN ? undefined : this.palette[v];
  }
}

export interface GroundColumn {
  /** Highest real ground y (ignoring plants, leaves, logs and water), or null when none was found. */
  ground: number | null;
  /** Exact height of the ground's top face: a slab reads 0.5 above its y, dirt_path 15/16, a full block 1. */
  top: number | null;
  block: string;
  /** Top of the water standing on the ground, or null for a dry column. */
  water: number | null;
  /** Highest leaf/log block above the ground, or null. */
  canopy: number | null;
  /** False when the chunk is not generated. */
  known: boolean;
}

/**
 * The same notion of ground terraform uses (see columns.ts): the highest block that is not
 * air, a plant, water or part of a tree — found by walking down from the heightmap top.
 */
export async function groundAt(cache: ChunkCache, x: number, z: number): Promise<GroundColumn> {
  const top = await cache.top(x, z);
  const unknown: GroundColumn = { ground: null, top: null, block: '', water: null, canopy: null, known: false };
  if (top === null) return unknown;
  let water: number | null = null;
  let canopy: number | null = null;
  const floorY = Math.max(WORLD_MIN_Y, top - GROUND_SEARCH_DEPTH);
  if (!(await cache.ensure(x, z, top - 24, top + 1))) return unknown;
  for (let y = top + 1; y >= floorY; y--) {
    let state = cache.get(x, y, z);
    if (state === undefined) {
      if (!(await cache.ensure(x, z, y - 32, top + 1))) return unknown;
      state = cache.get(x, y, z);
      if (state === undefined) continue;
    }
    const c = classifyBlock(state);
    if (c === CELL_GROUND) {
      // Rails, signs, buttons and the like count as ground to terraform but have nothing to
      // stand on; the ground is whatever they sit on.
      const f = footing(state);
      if (f.kind === 'pass') continue;
      return { ground: y, top: y + Math.min(1, f.top || 1), block: state.shortName, water, canopy, known: true };
    }
    if (c === CELL_WATER && water === null) water = y;
    if (c === CELL_CANOPY && canopy === null) canopy = y;
  }
  return { ground: null, top: null, block: '', water, canopy, known: true };
}
