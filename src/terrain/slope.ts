/**
 * Steepness of an area as characters: every column's largest height difference to its four
 * neighbours, and the connected cliffs that difference traces. A heightmap of raw numbers asks
 * the reader to subtract; this does the subtraction, so a 2-block lip in a meadow shows up as a
 * '2' in a field of '.' instead of hiding as "71 71 73 71".
 */

import { ChunkCache, groundAt } from './sampler.js';
import { formatHeight } from './walk.js';

export interface SlopeGrid {
  minX: number;
  minZ: number;
  w: number;
  h: number;
  /** Exact top of the ground (a slab 0.5 above its y), or the top of the water; NaN where unknown. */
  height: Float64Array;
  /** Ground block y; NaN where unknown. */
  ground: Float64Array;
  water: Uint8Array;
  known: Uint8Array;
  /** Largest |Δ| to a known 4-neighbour; -1 when the column has no known neighbour. */
  maxStep: Float64Array;
  /** Smallest |Δ| to a known 4-neighbour; -1 when none. */
  minStep: Float64Array;
}

export interface Cliff {
  cells: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Largest single step inside the cliff, in blocks (exact). */
  step: number;
  /** Height span over the cliff's columns and their neighbours, highest top minus lowest. */
  height: number;
  at: [number, number];
}

/** A step that needs more than a jump. Steps are exact heights, so 1.5 (a block and a slab) counts. */
export const CLIFF_STEP = 1.5;
/** The game's step height: anything up to this is walked, not jumped. */
export const WALK_STEP = 0.6;
/** Heights this close are level: dirt_path beside grass is a 1/16 lip nobody notices. */
const LEVEL = 1 / 16 + 1e-6;

export async function buildSlopeGrid(cache: ChunkCache, minX: number, minZ: number, maxX: number, maxZ: number): Promise<SlopeGrid> {
  const w = maxX - minX + 1;
  const h = maxZ - minZ + 1;
  const g: SlopeGrid = {
    minX,
    minZ,
    w,
    h,
    height: new Float64Array(w * h).fill(NaN),
    ground: new Float64Array(w * h).fill(NaN),
    water: new Uint8Array(w * h),
    known: new Uint8Array(w * h),
    maxStep: new Float64Array(w * h).fill(-1),
    minStep: new Float64Array(w * h).fill(-1),
  };
  // Chunk by chunk, so every column of a chunk is read while that chunk is still cached.
  for (let cz = minZ >> 4; cz <= maxZ >> 4; cz++) {
    for (let cx = minX >> 4; cx <= maxX >> 4; cx++) {
      for (let z = Math.max(minZ, cz * 16); z <= Math.min(maxZ, cz * 16 + 15); z++) {
        for (let x = Math.max(minX, cx * 16); x <= Math.min(maxX, cx * 16 + 15); x++) {
          const col = await groundAt(cache, x, z);
          const i = (z - minZ) * w + (x - minX);
          // Deep water can hide its bed below the search depth; it is still known water.
          if (!col.known || (col.top === null && col.water === null)) continue;
          g.known[i] = 1;
          g.ground[i] = col.ground ?? NaN;
          g.water[i] = col.water !== null ? 1 : 0;
          // A bank level with a pond is flat to walk along; measuring against the lake bed
          // would draw a cliff around every body of water.
          g.height[i] = col.water !== null ? col.water + 1 : col.top!;
        }
      }
    }
  }
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const i = zi * w + xi;
      if (!g.known[i]) continue;
      let hi = -1;
      let lo = -1;
      for (const [nx, nz] of [[xi - 1, zi], [xi + 1, zi], [xi, zi - 1], [xi, zi + 1]]) {
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const j = nz * w + nx;
        if (!g.known[j]) continue;
        const d = Math.abs(g.height[j] - g.height[i]);
        if (d > hi) hi = d;
        if (lo < 0 || d < lo) lo = d;
      }
      g.maxStep[i] = hi;
      g.minStep[i] = lo;
    }
  }
  return g;
}

/** Connected (4-neighbour) groups of dry columns whose largest step is at least CLIFF_STEP. */
export function findCliffs(g: SlopeGrid, minStep = CLIFF_STEP): Cliff[] {
  const seen = new Uint8Array(g.w * g.h);
  const cliffs: Cliff[] = [];
  const steep = (i: number): boolean => g.known[i] === 1 && !g.water[i] && g.maxStep[i] >= minStep;
  const stack: number[] = [];
  for (let start = 0; start < g.w * g.h; start++) {
    if (seen[start] || !steep(start)) continue;
    const c: Cliff = { cells: 0, minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity, step: 0, height: 0, at: [0, 0] };
    let top = -Infinity;
    let bottom = Infinity;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const xi = i % g.w;
      const zi = (i - xi) / g.w;
      const x = g.minX + xi;
      const z = g.minZ + zi;
      c.cells++;
      c.minX = Math.min(c.minX, x);
      c.maxX = Math.max(c.maxX, x);
      c.minZ = Math.min(c.minZ, z);
      c.maxZ = Math.max(c.maxZ, z);
      if (g.maxStep[i] > c.step) {
        c.step = g.maxStep[i];
        c.at = [x, z];
      }
      for (const [nx, nz] of [[xi - 1, zi], [xi + 1, zi], [xi, zi - 1], [xi, zi + 1]]) {
        if (nx < 0 || nz < 0 || nx >= g.w || nz >= g.h) continue;
        const j = nz * g.w + nx;
        // The height counts the foot and the top of the cliff even where one side is water.
        if (g.known[j]) {
          top = Math.max(top, g.height[j], g.height[i]);
          bottom = Math.min(bottom, g.height[j], g.height[i]);
        }
        if (seen[j] || !steep(j)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    c.height = top - bottom;
    cliffs.push(c);
  }
  cliffs.sort((a, b) => b.step - a.step || b.height - a.height || b.cells - a.cells);
  return cliffs;
}

function stepChar(step: number): string {
  if (step <= LEVEL) return '.';
  if (step <= WALK_STEP) return ':';
  const blocks = Math.max(1, Math.round(step));
  return blocks >= 10 ? '#' : String(blocks);
}

export function formatSlope(g: SlopeGrid, sample: number, title: string, maxCliffs = 25): string {
  const lines: string[] = [title];
  const cells = g.w * g.h;
  let known = 0;
  let water = 0;
  let flat = 0;
  let walkable = 0;
  let jump = 0;
  let steep = 0;
  let noJump = 0;
  let reachable = 0;
  let isolated = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < cells; i++) {
    if (!g.known[i]) continue;
    known++;
    if (!Number.isNaN(g.ground[i])) {
      lo = Math.min(lo, g.ground[i]);
      hi = Math.max(hi, g.ground[i]);
    }
    if (g.water[i]) {
      water++;
      continue;
    }
    const m = g.maxStep[i];
    if (m <= LEVEL) flat++;
    else if (m <= WALK_STEP) walkable++;
    else if (m < CLIFF_STEP) jump++;
    else steep++;
    const n = g.minStep[i];
    if (n >= 0 && n <= WALK_STEP) noJump++;
    if (n >= 0 && n < CLIFF_STEP) reachable++;
    else if (n >= CLIFF_STEP) isolated++;
  }
  const dry = known - water;
  const pct = (n: number, of: number): string => (of ? `${((n / of) * 100).toFixed(1)}%` : '0%');

  lines.push(`Legend: largest step to a 4-neighbour — '.' level (≤1/16), ':' a walkable half step (≤0.6), '1'..'9' blocks (rounded), '#' 10 or more; '~' water, '?' ungenerated.`);
  if (sample > 1) lines.push(`Each character covers ${sample}×${sample} columns and shows the steepest one in it.`);
  lines.push(`Rows z=${g.minZ}.. downwards, columns x=${g.minX}.. rightwards:`);
  for (let zi = 0; zi < g.h; zi += sample) {
    let row = '';
    for (let xi = 0; xi < g.w; xi += sample) {
      let worst = -1;
      let anyKnown = false;
      let allWater = true;
      for (let dz = 0; dz < sample && zi + dz < g.h; dz++) {
        for (let dx = 0; dx < sample && xi + dx < g.w; dx++) {
          const i = (zi + dz) * g.w + xi + dx;
          if (!g.known[i]) continue;
          anyKnown = true;
          if (g.water[i]) continue;
          allWater = false;
          worst = Math.max(worst, g.maxStep[i]);
        }
      }
      row += !anyKnown ? '?' : allWater ? '~' : stepChar(worst);
    }
    lines.push(`  z=${String(g.minZ + zi).padStart(6)} |${row}`);
  }

  lines.push('');
  if (!known) {
    lines.push('Summary: no generated ground in this box.');
    return lines.join('\n');
  }
  lines.push(
    `Summary: ${cells} columns, ${known} generated; ${lo <= hi ? `ground y ${lo}..${hi}` : "no dry ground"}; water ${pct(water, known)}.`,
    `  Dry columns by largest step: level ${pct(flat, dry)}, half step ≤0.6 ${pct(walkable, dry)}, a jump (under 1.5) ${pct(jump, dry)}, 1.5+ ${pct(steep, dry)}.`,
    `  Walkable without jumping (some neighbour within 0.6): ${pct(noJump, dry)}; within a jump (some neighbour under 1.5): ${pct(reachable, dry)}; cut off on all sides (every neighbour 1.5+ away): ${isolated} column(s).`,
  );
  const cliffs = findCliffs(g);
  if (!cliffs.length) {
    lines.push(`Cliffs (connected steps of ${CLIFF_STEP}+ blocks): none.`);
  } else {
    lines.push(`Cliffs (connected steps of ${CLIFF_STEP}+ blocks): ${cliffs.length}, steepest first:`);
    for (const c of cliffs.slice(0, maxCliffs)) {
      const length = Math.max(c.maxX - c.minX + 1, c.maxZ - c.minZ + 1);
      lines.push(`  step ${formatHeight(c.step).padStart(6)} at (${c.at[0]}, ${c.at[1]}); spans x ${c.minX}..${c.maxX}, z ${c.minZ}..${c.maxZ}; length ${length}, ${c.cells} column(s), height ${formatHeight(c.height)}`);
    }
    if (cliffs.length > maxCliffs) lines.push(`  … and ${cliffs.length - maxCliffs} smaller`);
  }
  return lines.join('\n');
}
