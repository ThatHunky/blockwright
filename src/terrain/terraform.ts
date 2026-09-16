/**
 * The terraform core: turn a read box of world into a target ground height per column, then
 * into the voxels that realise it.
 *
 * The height solve, in order:
 *  1. Freeze what must not move — the box border (so the result meets real terrain with no
 *     seam), the keep area (the building pad), anything the caller protected, and any column
 *     we could not read.
 *  2. Solve the interior as a harmonic field with those frozen values as boundary conditions.
 *     A harmonic function has no interior extremum, so the ramp between pad and terrain can
 *     only be monotone: no terraces, no concentric rings, no per-column noise spikes.
 *  3. Add fBm, faded to nothing at every frozen edge, so the ramp reads as a landform rather
 *     than as a mathematical surface.
 *  4. Blur, round to whole blocks, and clamp 4-neighbour steps so the result is walkable.
 *
 * Every function here is pure: same input, same output, no clock, no randomness beyond the
 * seeded noise.
 */

import { BlockState, VoxelSet } from '../voxel/voxels.js';
import { fbm2 } from './noise.js';
import { boxBlur, chamferDistance, clampSteps, laplaceSweep, maxNeighbourStep, smoothstep, solveLaplace } from './field.js';
import { CELL_AIR, CELL_GROUND, cellAt, type Cell, type ColumnGrid } from './columns.js';

export type TerraformMode = 'blend' | 'smooth' | 'hill';

export interface TerraformPlanInput {
  grid: ColumnGrid;
  mode: TerraformMode;
  /** 1 where the column belongs to the keep area and must not move. */
  keep: Uint8Array;
  /**
   * Height for the keep area. Omitted, the area is frozen at whatever is there now and left
   * completely untouched. Given, the area is levelled to that height and held there — the
   * pad itself gets built, and the ramp outside it is solved against the same value, so pad
   * and slope always agree.
   */
  keepHeight?: number;
  /** 1 where the caller asked us to leave the column alone (trees, paths, someone's build). */
  protect: Uint8Array;
  seed: number;
  /** Peak-to-trough noise, in blocks, at the middle of the reshaped area. */
  amplitude: number;
  /** Wavelength of the largest noise octave, in blocks. */
  wavelength: number;
  octaves: number;
  /** Blocks over which the noise fades in from a frozen edge. */
  noiseFade: number;
  /** Box-blur radius applied to the finished field. */
  blur: number;
  /** Largest allowed height difference between 4-neighbour columns. */
  maxStep: number;
  /** smooth mode only: how many relaxation passes to run. More = flatter. */
  smoothPasses: number;
}

export interface TerraformPlan {
  w: number;
  h: number;
  /** Target ground height per column, whole blocks. */
  target: Int32Array;
  /** 1 where the column was held fixed. */
  frozen: Uint8Array;
  /** 1 where the column must be left exactly as it is (keep, protect, unreadable). */
  skip: Uint8Array;
  sweeps: number;
  residual: number;
  /** Largest 4-neighbour step left in the finished field. */
  maxStep: number;
  /** How many 4-neighbour pairs still exceed the requested max_step. */
  steepPairs: number;
  /** How many of those are between two columns terraform was free to move — the ones that
   * mean "the margin is too narrow", as opposed to meeting real terrain that is itself
   * steeper than max_step. */
  steepFreePairs: number;
  raised: number;
  lowered: number;
}

/** Builds the frozen/skip masks and the initial field, then runs the solve. */
export function planTerrain(input: TerraformPlanInput): TerraformPlan {
  const { grid } = input;
  const { w, h } = grid;
  const n = w * h;
  const frozen = new Uint8Array(n);
  const skip = new Uint8Array(n);
  const field = new Float64Array(n);

  let knownSum = 0;
  let knownCount = 0;
  for (let i = 0; i < n; i++) {
    if (grid.known[i] && grid.ground[i] >= grid.yMin) {
      knownSum += grid.ground[i];
      knownCount++;
    }
  }
  const fallback = knownCount ? Math.round(knownSum / knownCount) : grid.yMin;

  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const i = zi * w + xi;
      const border = xi === 0 || zi === 0 || xi === w - 1 || zi === h - 1;
      const readable = grid.known[i] === 1 && grid.ground[i] >= grid.yMin;
      const current = readable ? grid.ground[i] : fallback;
      field[i] = current;
      if (input.keep[i]) {
        field[i] = input.keepHeight ?? current;
        frozen[i] = 1;
        // Frozen means "the solve may not move it"; skip means "do not place blocks there".
        // A named keep_y is a pad the caller wants flattened, so it is frozen but not skipped.
        skip[i] = input.keepHeight === undefined ? 1 : 0;
      } else if (input.protect[i] || !readable) {
        frozen[i] = 1;
        skip[i] = 1;
      } else if (border) {
        frozen[i] = 1;
      }
    }
  }

  // The interior solve. blend and hill want the fully converged harmonic field between the
  // frozen values; smooth wants a bounded number of relaxation passes starting from the real
  // terrain, so the area keeps its own shape and only loses its roughness.
  let sweeps = 0;
  let residual = 0;
  if (input.mode === 'smooth') {
    for (let s = 0; s < input.smoothPasses; s++) residual = laplaceSweep(field, frozen, w, h, s % 2 === 0);
    sweeps = input.smoothPasses;
  } else {
    const r = solveLaplace(field, frozen, w, h);
    sweeps = r.sweeps;
    residual = r.residual;
  }

  // Noise, faded to zero at every frozen cell so neither the pad edge nor the box border can
  // ever show a step that the boundary conditions were supposed to prevent.
  if (input.amplitude > 0) {
    const distance = chamferDistance(frozen, w, h);
    const fade = Math.max(1e-6, input.noiseFade);
    for (let zi = 0; zi < h; zi++) {
      for (let xi = 0; xi < w; xi++) {
        const i = zi * w + xi;
        if (frozen[i]) continue;
        const env = smoothstep(0, 1, Math.min(1, distance[i] / fade));
        if (env <= 0) continue;
        const x = grid.minX + xi;
        const z = grid.minZ + zi;
        const noise = fbm2(x, z, { octaves: input.octaves, wavelength: input.wavelength, seed: input.seed });
        // hill raises a landform, so its noise is rectified into [0, 1] and scaled by the
        // same envelope — the envelope is what gives the mound its shape. blend and smooth
        // want symmetric undulation around the solved ramp instead.
        field[i] += input.mode === 'hill' ? input.amplitude * env * (0.5 + 0.5 * noise) : input.amplitude * env * noise;
      }
    }
  }

  boxBlur(field, w, h, input.blur, frozen);

  // Round before clamping: max_step is a whole-block promise about the blocks that actually
  // get placed, and clamping a continuous field can still round into a 2-block stair.
  const rounded = new Float64Array(n);
  for (let i = 0; i < n; i++) rounded[i] = Math.round(field[i]);
  clampSteps(rounded, w, h, input.maxStep, { frozen });

  const target = new Int32Array(n);
  let raised = 0;
  let lowered = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.round(rounded[i]);
    const clamped = Math.min(grid.yMax, Math.max(grid.yMin, t));
    target[i] = clamped;
    if (skip[i]) continue;
    const current = grid.ground[i];
    if (clamped > current) raised++;
    else if (clamped < current) lowered++;
  }
  // Report on the rounded targets, not the continuous field: those are the blocks that
  // actually get placed, and they are what the caller has to walk on.
  const after = maxNeighbourStep(Float64Array.from(target), w, h, input.maxStep, frozen);
  return { w, h, target, frozen, skip, sweeps, residual, maxStep: after.maxStep, steepPairs: after.steepPairs, steepFreePairs: after.steepFreePairs, raised, lowered };
}

export type ColumnEditKind = 'air' | 'top' | 'soil' | 'stone';

export interface ColumnEdit {
  y: number;
  kind: ColumnEditKind;
}

export interface ColumnPlanInput {
  /** Target surface y for this column. */
  target: number;
  /** Current ground surface y. */
  ground: number;
  /** Highest non-air y in the column. */
  top: number;
  yMin: number;
  yMax: number;
  category: (y: number) => Cell;
  /** Blocks of soil laid directly under the surface block. */
  soilDepth: number;
  /** How far below the lower of (target, ground) stone may be poured to close a void. */
  maxUnderfill?: number;
}

/**
 * The per-column edit list: air above the new surface, the surface block, a few blocks of
 * soil, then stone only where there is nothing already.
 *
 * A column whose target equals its current ground produces nothing at all. That is what
 * keeps the box border and every already-correct column completely untouched — including the
 * grass, flowers and trees standing on them — instead of being re-capped with the palette.
 */
export function planColumn(input: ColumnPlanInput): ColumnEdit[] {
  const { yMin, yMax, category } = input;
  const t = Math.min(yMax, Math.max(yMin, input.target));
  if (t === input.ground) return [];
  const edits: ColumnEdit[] = [];

  // Everything standing above the new surface goes, whether it is the old ground we are
  // cutting into or the cover that was sitting on it.
  for (let y = Math.min(yMax, input.top); y > t; y--) {
    if (category(y) !== CELL_AIR) edits.push({ y, kind: 'air' });
  }

  edits.push({ y: t, kind: 'top' });
  for (let y = t - 1; y >= t - input.soilDepth && y >= yMin; y--) edits.push({ y, kind: 'soil' });

  // Below the soil we only ever *add*: fill the void left under a raised column, and stop at
  // the first block that is already there, so existing stone, ores and caves survive.
  const floor = Math.max(yMin, Math.min(input.ground, t) - (input.maxUnderfill ?? 8));
  for (let y = t - input.soilDepth - 1; y >= floor; y--) {
    const c = category(y);
    if (c === CELL_GROUND) break;
    edits.push({ y, kind: 'stone' });
  }
  return edits;
}

export interface TerraformPalette {
  top: BlockState;
  soil: BlockState;
  stone: BlockState;
}

export interface TerraformVoxelOptions {
  soilDepth: number;
  /** Shape columns whose surface is under water too. Off by default: a lake bed reshaped
   * without asking is almost never what the caller meant. */
  includeWater: boolean;
  /** Existing block at a position, used to drop edits that would change nothing. */
  blockAt?: (x: number, y: number, z: number) => BlockState | undefined;
}

export interface TerraformVoxelResult {
  set: VoxelSet;
  /** Columns that produced at least one edit. */
  columns: number;
  cleared: number;
  placed: number;
  /** Water columns left alone because includeWater was false. */
  skippedWater: number;
}

const AIR = BlockState.parse('air');

/** Realises a plan as voxels, ready for the normal apply/snapshot/dry-run pipeline. */
export function terraformVoxels(grid: ColumnGrid, plan: TerraformPlan, palette: TerraformPalette, opts: TerraformVoxelOptions): TerraformVoxelResult {
  const set = new VoxelSet();
  let columns = 0;
  let cleared = 0;
  let placed = 0;
  let skippedWater = 0;
  for (let zi = 0; zi < grid.h; zi++) {
    for (let xi = 0; xi < grid.w; xi++) {
      const i = zi * grid.w + xi;
      if (plan.skip[i]) continue;
      if (!grid.known[i] || grid.ground[i] < grid.yMin) continue;
      if (grid.water[i] && !opts.includeWater) {
        skippedWater++;
        continue;
      }
      const x = grid.minX + xi;
      const z = grid.minZ + zi;
      const edits = planColumn({
        target: plan.target[i],
        ground: grid.ground[i],
        top: grid.top[i],
        yMin: grid.yMin,
        yMax: grid.yMax,
        category: (y) => cellAt(grid, xi, zi, y),
        soilDepth: opts.soilDepth,
      });
      if (!edits.length) continue;
      let touched = false;
      for (const e of edits) {
        const state = e.kind === 'air' ? AIR : e.kind === 'top' ? palette.top : e.kind === 'soil' ? palette.soil : palette.stone;
        const existing = opts.blockAt?.(x, e.y, z);
        if (existing && existing.equals(state)) continue;
        set.set(x, e.y, z, state);
        touched = true;
        if (e.kind === 'air') cleared++;
        else placed++;
      }
      if (touched) columns++;
    }
  }
  return { set, columns, cleared, placed, skippedWater };
}

/** Defaults that differ per mode, so the tool only has to ask for what the caller wants to
 * change. blend adds a little roll to the ramp; smooth is meant to take roughness away, not
 * add it; hill *is* the noise, so it gets a real amplitude and a box-wide fade. */
export function modeDefaults(mode: TerraformMode, w: number, h: number): { amplitude: number; noiseFade: number; blur: number } {
  switch (mode) {
    case 'smooth':
      return { amplitude: 0, noiseFade: 8, blur: 1 };
    case 'hill':
      return { amplitude: 10, noiseFade: Math.max(4, Math.floor(Math.min(w, h) / 3)), blur: 1 };
    case 'blend':
    default:
      return { amplitude: 2, noiseFade: 8, blur: 1 };
  }
}
