/**
 * Walks a path the way a player would, one block at a time, and says where it stops being
 * walkable: a step too tall to walk up, a drop that hurts, water, a fence across the way, a
 * ceiling too low. Numbers, not pictures — an assistant checking its own trail cannot see a
 * 1-block lip in an isometric render, but it can read "+1 at (-1119, 272)".
 */

import type { BlockState } from '../voxel/voxels.js';
import { ChunkCache, WORLD_MIN_Y } from './sampler.js';
import { footing, blocksAsObstacle, stairHalfStep } from './footing.js';
import type { PathCell } from './path.js';
import { classifyBlock, CELL_GROUND } from './columns.js';

export type WalkProblemKind = 'step_up' | 'fall' | 'no_floor' | 'water' | 'headroom' | 'obstacle' | 'ungenerated';
export const WALK_PROBLEM_KINDS: WalkProblemKind[] = ['step_up', 'fall', 'no_floor', 'water', 'headroom', 'obstacle', 'ungenerated'];

export interface WalkOptions {
  /** Tallest rise walked without jumping; the game's step height is 0.6. */
  maxStep: number;
  /** Blocks of clear space needed above the standing height (a player is 1.8 tall). */
  headroom: number;
  /** How far above and below a given y the floor is searched for. */
  searchRange?: number;
  /** Drops taller than this hurt (fall damage starts past 3 blocks). */
  fallHeight?: number;
  /** How far below the heightmap top a column without a given y is searched. */
  searchDepth?: number;
}

export interface WalkCell {
  x: number;
  z: number;
  /** Exact standing height (floor block y + its collision top), null when there is no floor. */
  stand: number | null;
  /** The floor block, or what is there instead of one. */
  surface: string;
  /** Change in standing height from the last cell that had one. */
  dh: number | null;
  flags: string[];
}

export interface WalkProblem {
  kind: WalkProblemKind;
  x: number;
  z: number;
  detail: string;
}

export interface WalkReport {
  cells: WalkCell[];
  problems: WalkProblem[];
  /** Largest rise as actually climbed (a stair's half step counts as two small steps). */
  maxUp: { dh: number; x: number; z: number } | null;
  maxDown: { dh: number; x: number; z: number } | null;
  climb: number;
  descent: number;
}

interface Candidate {
  y: number;
  state: BlockState;
  stand: number;
  blocker?: { state: BlockState; y: number };
  liquid?: { state: BlockState; y: number };
}

const EPS = 1e-6;

function candidateAt(cache: ChunkCache, x: number, z: number, y: number, headroom: number): Candidate | undefined {
  const state = cache.get(x, y, z);
  if (!state) return undefined;
  const f = footing(state);
  if (f.kind !== 'floor' || f.top <= 0) return undefined;
  const stand = y + f.top;
  const c: Candidate = { y, state, stand };
  const first = Math.ceil(stand - EPS);
  for (let by = first; by < first + headroom; by++) {
    const above = cache.get(x, by, z);
    if (!above) continue;
    const af = footing(above);
    if (af.kind === 'pass') continue;
    if (af.kind === 'water' || af.kind === 'lava') {
      c.liquid ??= { state: above, y: by };
      continue;
    }
    c.blocker = { state: above, y: by };
    break;
  }
  return c;
}

export function formatHeight(n: number): string {
  return String(Number(n.toFixed(4)));
}

export function formatDelta(n: number): string {
  const s = formatHeight(Math.abs(n));
  return n > EPS ? `+${s}` : n < -EPS ? `-${s}` : '0';
}

export async function analyzeWalk(cache: ChunkCache, path: PathCell[], opts: WalkOptions): Promise<WalkReport> {
  const range = opts.searchRange ?? 8;
  const fallHeight = opts.fallHeight ?? 3;
  const depth = opts.searchDepth ?? 96;
  const cells: WalkCell[] = [];
  const problems: WalkProblem[] = [];
  let last: { stand: number } | null = null;
  let maxUp: WalkReport['maxUp'] = null;
  let maxDown: WalkReport['maxDown'] = null;
  let climb = 0;
  let descent = 0;

  for (let i = 0; i < path.length; i++) {
    const { x, z, y: expected } = path[i];
    const cell: WalkCell = { x, z, stand: null, surface: '', dh: null, flags: [] };
    const problem = (kind: WalkProblemKind, detail: string): void => {
      if (!cell.flags.includes(kind)) cell.flags.push(kind);
      problems.push({ kind, x, z, detail });
    };
    cells.push(cell);

    let chosen: Candidate | undefined;
    /** What is in the way when no floor is found, for a diagnosis better than "nothing". */
    let instead: { kind: 'water' | 'obstacle' | 'no_floor'; name: string } | undefined;

    if (expected !== undefined) {
      const base = Math.floor(expected);
      if (!(await cache.ensure(x, z, base - range - 1, base + range + opts.headroom + 2))) {
        cell.surface = '?';
        problem('ungenerated', 'chunk is not generated');
        continue;
      }
      let best = Infinity;
      for (let y = base - range - 1; y <= base + range; y++) {
        const c = candidateAt(cache, x, z, y, opts.headroom);
        if (!c || Math.abs(c.stand - expected) > range + 0.5) continue;
        // Nearest to the given height and to where the walker already stands, so an interpolated
        // y that is a block or two off still follows the real path. A clear floor beats a buried
        // one only by a margin: a block at head height on a trail should read as missing
        // headroom, not as a two-block climb onto that block.
        const score = last ? (Math.abs(c.stand - expected) + Math.abs(c.stand - last.stand)) / 2 + (c.blocker ? 1.5 : 0) : Math.abs(c.stand - expected) + (c.blocker ? 1.5 : 0);
        if (score < best - EPS || (Math.abs(score - best) <= EPS && chosen && c.stand > chosen.stand)) {
          best = score;
          chosen = c;
        }
      }
      if (!chosen) {
        for (let y = base + 1; y >= base - 1; y--) {
          const s = cache.get(x, y, z);
          if (!s) continue;
          const k = footing(s).kind;
          if (k === 'water' || k === 'lava') instead = { kind: 'water', name: s.shortName };
          else if (k === 'obstacle' && !instead) instead = { kind: 'obstacle', name: s.shortName };
        }
      }
    } else {
      const top = await cache.top(x, z);
      if (top === null || !(await cache.ensure(x, z, top - 24, top + opts.headroom + 2))) {
        cell.surface = '?';
        problem('ungenerated', 'chunk is not generated');
        continue;
      }
      let blocked: Candidate | undefined;
      const bottom = Math.max(WORLD_MIN_Y, top - depth);
      for (let y = top; y >= bottom; y--) {
        if (!cache.get(x, y, z) && !(await cache.ensure(x, z, y - 32, top + opts.headroom + 2))) break;
        const s = cache.get(x, y, z);
        if (s && !instead) {
          const k = footing(s).kind;
          if (k === 'water' || k === 'lava') instead = { kind: 'water', name: s.shortName };
        }
        const c = candidateAt(cache, x, z, y, opts.headroom);
        if (!c) continue;
        if (!c.blocker) {
          chosen = c;
          break;
        }
        blocked ??= c;
        // Blocked real ground (say, under a tree trunk) is the surface here; searching on down
        // would only find a cave and report a 60-block fall that is not there. "Real" means
        // terrain-like and resting on something, so a lantern hanging in the leaves is not it.
        const below = cache.get(x, y - 1, z);
        if (classifyBlock(c.state) === CELL_GROUND && below && footing(below).kind !== 'pass') {
          blocked = c;
          break;
        }
      }
      chosen ??= blocked;
    }

    if (!chosen) {
      cell.surface = instead?.name ?? 'air';
      if (instead?.kind === 'water') problem('water', `${instead.name} and no floor to stand on`);
      else if (instead?.kind === 'obstacle') problem('obstacle', `${instead.name} and no floor to stand on`);
      else problem('no_floor', expected !== undefined ? `nothing to stand on within ${range} blocks of y=${formatHeight(expected)}` : 'nothing to stand on');
      continue;
    }

    cell.stand = chosen.stand;
    cell.surface = chosen.state.shortName;
    if (chosen.blocker) {
      const kind = blocksAsObstacle(chosen.blocker.state) ? 'obstacle' : 'headroom';
      problem(kind, `${chosen.blocker.state.shortName} at y=${chosen.blocker.y} above the floor (needs ${opts.headroom} clear)`);
    }
    if (chosen.liquid) problem('water', `${chosen.liquid.state.shortName} at y=${chosen.liquid.y}, in the way of a walker's body`);

    if (last) {
      const dh = chosen.stand - last.stand;
      cell.dh = dh;
      if (dh > EPS) {
        climb += dh;
        const prev = path[i - 1];
        let up = dh;
        if (prev && stairHalfStep(chosen.state, x - prev.x, z - prev.z)) {
          up = Math.max(dh - 0.5, Math.min(0.5, dh));
          if (up < dh - EPS) cell.flags.push('stairs');
        }
        if (!maxUp || up > maxUp.dh) maxUp = { dh: up, x, z };
        if (up > opts.maxStep + EPS) {
          const how = up <= 1.25 + EPS ? 'a jump' : 'too tall to jump';
          problem('step_up', `${formatHeight(last.stand)} → ${formatHeight(chosen.stand)}: ${formatDelta(up)} (${how}; max_step ${opts.maxStep})`);
        }
      } else if (dh < -EPS) {
        descent -= dh;
        if (!maxDown || -dh > maxDown.dh) maxDown = { dh: -dh, x, z };
        if (-dh > fallHeight + EPS) problem('fall', `${formatHeight(last.stand)} → ${formatHeight(chosen.stand)}: ${formatDelta(dh)} (fall damage past ${fallHeight})`);
      }
    }
    last = { stand: chosen.stand };
  }

  return { cells, problems, maxUp, maxDown, climb, descent };
}

/** Compact table with flat stretches run-length collapsed, then the summary and every problem. */
export function formatWalk(r: WalkReport, opts: WalkOptions, title: string): string {
  const lines: string[] = [title];
  lines.push(`${'x'.padStart(7)} ${'z'.padStart(7)} ${'stand'.padStart(9)}  ${'surface'.padEnd(24)} ${'Δh'.padStart(8)}  flags`);
  let run = 0;
  let runEnd: WalkCell | undefined;
  const flush = (): void => {
    if (run > 0 && runEnd) lines.push(`${''.padStart(7)} ${''.padStart(7)} ${''.padStart(9)}  … ${run} more at the same height and surface, through (${runEnd.x}, ${runEnd.z})`);
    run = 0;
    runEnd = undefined;
  };
  for (let i = 0; i < r.cells.length; i++) {
    const c = r.cells[i];
    const p = r.cells[i - 1];
    const plain = p && c.stand !== null && p.stand === c.stand && c.surface === p.surface && c.flags.length === 0 && p.flags.length === 0;
    if (plain && i + 1 < r.cells.length) {
      run++;
      runEnd = c;
      continue;
    }
    flush();
    const stand = c.stand === null ? '—' : formatHeight(c.stand);
    const dh = c.dh === null ? '' : formatDelta(c.dh);
    lines.push(`${String(c.x).padStart(7)} ${String(c.z).padStart(7)} ${stand.padStart(9)}  ${c.surface.padEnd(24)} ${dh.padStart(8)}  ${c.flags.join(',')}`);
  }
  flush();

  const standable = r.cells.filter((c) => c.stand !== null).length;
  const parts = [
    `${r.cells.length} cells, ${standable} with a floor`,
    `climb +${formatHeight(r.climb)}, descent -${formatHeight(r.descent)}`,
    r.maxUp ? `largest step up ${formatDelta(r.maxUp.dh)} at (${r.maxUp.x}, ${r.maxUp.z})` : 'no step up',
    r.maxDown ? `largest drop -${formatHeight(r.maxDown.dh)} at (${r.maxDown.x}, ${r.maxDown.z})` : 'no drop',
  ];
  lines.push('', `Summary: ${parts.join('; ')}.`);
  if (!r.problems.length) {
    lines.push(`Problems: none — every step ≤ ${opts.maxStep}, no drop over ${opts.fallHeight ?? 3}, ${opts.headroom} blocks of headroom throughout, no water or obstacles.`);
  } else {
    const counts = WALK_PROBLEM_KINDS.map((k) => `${k} ${r.problems.filter((p) => p.kind === k).length}`);
    lines.push(`Problems (${r.problems.length}): ${counts.join(', ')}`);
    for (const p of r.problems) lines.push(`  ${p.kind.padEnd(11)} (${p.x}, ${p.z})  ${p.detail}`);
  }
  return lines.join('\n');
}
