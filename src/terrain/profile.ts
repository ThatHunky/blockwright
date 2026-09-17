/**
 * Elevation along a line: how the ground rises and falls, where it is steep, where the line
 * crosses water or runs under trees. The ground is the terraform notion of ground (plants,
 * leaves and logs ignored), so a forest does not read as a 12-block wall.
 */

import { ChunkCache, groundAt } from './sampler.js';
import type { PathCell, PathPoint } from './path.js';
import { formatDelta, formatHeight } from './walk.js';

export interface ProfileSample {
  dist: number;
  x: number;
  z: number;
  ground: number | null;
  /** Exact height of the ground's top face (a slab 0.5 above its y, dirt_path 15/16, a block 1). */
  top: number | null;
  block: string;
  /** Water surface above the ground, or null. */
  water: number | null;
  /** Highest leaf/log above the ground, or null. */
  canopy: number | null;
  /** Change of `top` from the previous sample that had ground. */
  dy: number | null;
  /** Top heights across the line, left to right looking along it; only when width > 0. */
  cross?: (number | null)[];
}

export interface GradeWindow {
  cells: number;
  rise: number;
  from: [number, number];
  to: [number, number];
}

export interface ProfileReport {
  samples: ProfileSample[];
  rise: number;
  fall: number;
  min: { y: number; x: number; z: number } | null;
  max: { y: number; x: number; z: number } | null;
  /** Steepest change over 1, 3 and 10 consecutive cells. */
  grades: GradeWindow[];
}

export const GRADE_WINDOWS = [1, 3, 10];

export async function analyzeProfile(cache: ChunkCache, path: PathCell[], points: PathPoint[], width: number): Promise<ProfileReport> {
  const samples: ProfileSample[] = [];
  let lastTop: number | null = null;
  let rise = 0;
  let fall = 0;
  let min: ProfileReport['min'] = null;
  let max: ProfileReport['max'] = null;

  for (const cell of path) {
    const g = await groundAt(cache, cell.x, cell.z);
    const s: ProfileSample = {
      dist: cell.dist,
      x: cell.x,
      z: cell.z,
      ground: g.ground,
      top: g.top,
      block: g.known ? g.block || 'none' : '?',
      water: g.water,
      canopy: g.canopy,
      dy: null,
    };
    if (g.top !== null) {
      if (lastTop !== null) {
        s.dy = g.top - lastTop;
        if (s.dy > 0) rise += s.dy;
        else fall -= s.dy;
      }
      lastTop = g.top;
      if (!min || g.top < min.y) min = { y: g.top, x: cell.x, z: cell.z };
      if (!max || g.top > max.y) max = { y: g.top, x: cell.x, z: cell.z };
    }
    if (width > 0) {
      const a = points[Math.min(cell.segment, points.length - 1)];
      const b = points[Math.min(cell.segment + 1, points.length - 1)];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      // Perpendicular pointing to the walker's left: for a line heading east, that is north.
      const px = len === 0 ? 0 : (b.z - a.z) / len;
      const pz = len === 0 ? -1 : -(b.x - a.x) / len;
      s.cross = [];
      for (let k = width; k >= -width; k--) {
        const cx = Math.round(cell.x + k * px);
        const cz = Math.round(cell.z + k * pz);
        s.cross.push(k === 0 ? g.top : (await groundAt(cache, cx, cz)).top);
      }
    }
    samples.push(s);
  }

  const grades: GradeWindow[] = [];
  for (const w of GRADE_WINDOWS) {
    let best: GradeWindow | null = null;
    for (let i = 0; i + w < samples.length; i++) {
      const a = samples[i].top;
      const b = samples[i + w].top;
      if (a === null || b === null) continue;
      if (!best || Math.abs(b - a) > Math.abs(best.rise)) best = { cells: w, rise: b - a, from: [samples[i].x, samples[i].z], to: [samples[i + w].x, samples[i + w].z] };
    }
    if (best) grades.push(best);
  }
  return { samples, rise, fall, min, max, grades };
}

/** Runs of consecutive samples sharing a condition, as "(x, z)–(x, z)" spans. */
function spans(samples: ProfileSample[], test: (s: ProfileSample) => boolean, describe: (run: ProfileSample[]) => string): string[] {
  const out: string[] = [];
  let run: ProfileSample[] = [];
  const flush = (): void => {
    if (run.length) out.push(`(${run[0].x}, ${run[0].z})–(${run[run.length - 1].x}, ${run[run.length - 1].z}) ${run.length} cell(s)${describe(run)}`);
    run = [];
  };
  for (const s of samples) {
    if (test(s)) run.push(s);
    else flush();
  }
  flush();
  return out;
}

/**
 * A small elevation chart: one column per sample (or per bucket of samples, keeping the
 * highest ground so a peak is never averaged away), one row per y level or per few levels.
 * '#' ground, '~' water, ' ' air.
 */
export function elevationChart(samples: ProfileSample[], maxCols = 96, maxRows = 16): string[] {
  const valid = samples.filter((s) => s.ground !== null);
  if (!valid.length) return [];
  const bucket = Math.max(1, Math.ceil(samples.length / maxCols));
  const cols: Array<{ ground: number | null; water: number | null }> = [];
  for (let i = 0; i < samples.length; i += bucket) {
    let ground: number | null = null;
    let water: number | null = null;
    for (const s of samples.slice(i, i + bucket)) {
      if (s.ground !== null && (ground === null || s.ground > ground)) ground = s.ground;
      if (s.water !== null && (water === null || s.water > water)) water = s.water;
    }
    cols.push({ ground, water });
  }
  const lo = Math.min(...cols.map((c) => c.ground ?? Infinity));
  const hi = Math.max(...cols.map((c) => Math.max(c.ground ?? -Infinity, c.water ?? -Infinity)));
  const step = Math.max(1, Math.ceil((hi - lo + 1) / maxRows));
  const lines: string[] = [];
  for (let level = hi; level >= lo; level -= step) {
    // A row stands for the levels level-step+1..level; ground reaching into it fills it.
    const floorLevel = level - step + 1;
    const row = cols.map((c) => (c.ground !== null && c.ground >= floorLevel ? '#' : c.water !== null && c.water >= floorLevel ? '~' : ' ')).join('');
    lines.push(`  ${String(level).padStart(5)} |${row}`);
  }
  lines.push(`  ${''.padStart(5)} +${'-'.repeat(cols.length)}`);
  lines.push(`  ${''.padStart(5)}  ${bucket > 1 ? `${bucket} cells per column, ` : ''}${step > 1 ? `${step} blocks per row, ` : ''}start at the left`);
  return lines;
}

export function formatProfile(r: ProfileReport, width: number, title: string): string {
  const lines: string[] = [title];
  const header = `${'dist'.padStart(7)} ${'x'.padStart(7)} ${'z'.padStart(7)} ${'ground'.padStart(6)} ${'top'.padStart(8)}  ${'surface'.padEnd(20)} ${'dy'.padStart(7)}  notes`;
  lines.push(header);
  let run = 0;
  let runEnd: ProfileSample | undefined;
  const flush = (): void => {
    if (run > 0 && runEnd) lines.push(`${''.padStart(7)} … ${run} more level, through (${runEnd.x}, ${runEnd.z}) at ${runEnd.dist.toFixed(1)}`);
    run = 0;
  };
  for (let i = 0; i < r.samples.length; i++) {
    const s = r.samples[i];
    const notes: string[] = [];
    if (s.water !== null) notes.push(`water to y=${s.water}`);
    if (s.canopy !== null) notes.push(`tree to y=${s.canopy}`);
    const plain = i > 0 && i + 1 < r.samples.length && s.dy === 0 && !notes.length && !s.cross && s.block === r.samples[i - 1].block && s.ground === r.samples[i - 1].ground;
    if (plain) {
      run++;
      runEnd = s;
      continue;
    }
    flush();
    const ground = s.ground === null ? '—' : String(s.ground);
    const top = s.top === null ? '—' : formatHeight(s.top);
    const dy = s.dy === null ? '' : formatDelta(s.dy);
    lines.push(`${s.dist.toFixed(1).padStart(7)} ${String(s.x).padStart(7)} ${String(s.z).padStart(7)} ${ground.padStart(6)} ${top.padStart(8)}  ${s.block.padEnd(20)} ${dy.padStart(7)}  ${notes.join('; ')}`);
    if (s.cross) {
      const c = s.top;
      const cells = s.cross.map((h, k) => {
        if (k === width) return `[${h === null ? '—' : formatHeight(h)}]`;
        if (h === null) return '—';
        return c === null ? formatHeight(h) : formatDelta(Number((h - c).toFixed(2)));
      });
      lines.push(`${''.padStart(7)} across (left → right): ${cells.join(' ')}`);
    }
  }
  flush();

  lines.push('');
  if (r.min && r.max) {
    lines.push(
      `Summary: ${r.samples.length} cells; ground top ${formatHeight(r.min.y)} at (${r.min.x}, ${r.min.z}) to ${formatHeight(r.max.y)} at (${r.max.x}, ${r.max.z}); ` +
        `total rise +${formatHeight(r.rise)}, total fall -${formatHeight(r.fall)}, net ${formatDelta(r.rise - r.fall)}.`,
    );
  } else {
    lines.push(`Summary: ${r.samples.length} cells, no ground found (ungenerated chunks or open water/void).`);
  }
  for (const g of r.grades) {
    lines.push(`  steepest over ${String(g.cells).padStart(2)} cell(s): ${formatDelta(g.rise)} (${Math.round((Math.abs(g.rise) / g.cells) * 100)}% grade) from (${g.from[0]}, ${g.from[1]}) to (${g.to[0]}, ${g.to[1]})`);
  }
  const trees = spans(r.samples, (s) => s.canopy !== null, (run) => `, canopy up to y=${Math.max(...run.map((s) => s.canopy ?? -Infinity))}`);
  const water = spans(r.samples, (s) => s.water !== null, (run) => `, surface y=${Math.max(...run.map((s) => s.water ?? -Infinity))}`);
  lines.push(trees.length ? `Trees over the line (ignored for ground): ${trees.join('; ')}` : 'Trees over the line: none.');
  if (water.length) lines.push(`Water: ${water.join('; ')}`);
  const chart = elevationChart(r.samples);
  if (chart.length) lines.push('', 'Elevation:', ...chart);
  return lines.join('\n');
}
