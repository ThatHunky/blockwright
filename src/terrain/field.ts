/**
 * Scalar height fields on a regular x/z grid, and the operators terraforming needs on them:
 * a multigrid Laplace solve, a box blur, a chamfer distance transform and a walkability
 * (max-step) clamp.
 *
 * All of it is pure array maths with no knowledge of Minecraft. A field is stored row-major
 * with z as the outer axis (`index = zi * w + xi`), matching how the rest of blockwright
 * orders grids (rows run north→south, columns west→east).
 *
 * The Laplace solve is the part that makes terraforming look like terrain instead of like a
 * series of fills. Given the real terrain height on the box border and a fixed height over
 * the building pad, the harmonic function with those boundary values is the smoothest
 * surface that joins them: it has no interior maxima or minima, so it cannot produce a
 * terrace, a ring or a step — it can only ramp.
 */

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One in-place Gauss-Seidel sweep of the discrete Laplace equation: every free cell becomes
 * the average of its four neighbours (edge neighbours are clamped, i.e. Neumann, though in
 * practice the outer ring is always frozen). Returns the largest change, which for
 * Gauss-Seidel is exactly the largest residual, so the caller can test convergence with it.
 */
export function laplaceSweep(data: Float64Array, frozen: Uint8Array, w: number, h: number, forward = true): number {
  let worst = 0;
  const z0 = forward ? 0 : h - 1;
  const zEnd = forward ? h : -1;
  const dz = forward ? 1 : -1;
  for (let zi = z0; zi !== zEnd; zi += dz) {
    const x0 = forward ? 0 : w - 1;
    const xEnd = forward ? w : -1;
    const dx = forward ? 1 : -1;
    for (let xi = x0; xi !== xEnd; xi += dx) {
      const i = zi * w + xi;
      if (frozen[i]) continue;
      const l = data[zi * w + (xi > 0 ? xi - 1 : xi)];
      const r = data[zi * w + (xi < w - 1 ? xi + 1 : xi)];
      const u = data[(zi > 0 ? zi - 1 : zi) * w + xi];
      const d = data[(zi < h - 1 ? zi + 1 : zi) * w + xi];
      const next = (l + r + u + d) * 0.25;
      const delta = next - data[i];
      data[i] = next;
      const mag = delta < 0 ? -delta : delta;
      if (mag > worst) worst = mag;
    }
  }
  return worst;
}

/** Half-resolution copy: a coarse cell is frozen when any of its up-to-4 fine cells is, and
 * takes the mean of those frozen values so Dirichlet data survives the restriction. */
function coarsen(data: Float64Array, frozen: Uint8Array, w: number, h: number) {
  const w2 = Math.ceil(w / 2);
  const h2 = Math.ceil(h / 2);
  const data2 = new Float64Array(w2 * h2);
  const frozen2 = new Uint8Array(w2 * h2);
  for (let zi = 0; zi < h2; zi++) {
    for (let xi = 0; xi < w2; xi++) {
      let sum = 0;
      let count = 0;
      let fixedSum = 0;
      let fixedCount = 0;
      for (let dz = 0; dz < 2; dz++) {
        const z = zi * 2 + dz;
        if (z >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = xi * 2 + dx;
          if (x >= w) continue;
          const i = z * w + x;
          sum += data[i];
          count++;
          if (frozen[i]) {
            fixedSum += data[i];
            fixedCount++;
          }
        }
      }
      const j = zi * w2 + xi;
      data2[j] = fixedCount ? fixedSum / fixedCount : count ? sum / count : 0;
      frozen2[j] = fixedCount ? 1 : 0;
    }
  }
  return { data: data2, frozen: frozen2, w: w2, h: h2 };
}

/** Coarse-to-fine cascade (full multigrid without residual correction): solve the halved
 * problem first and use it as the starting guess, so the fine sweeps only have to remove
 * high-frequency error — which Gauss-Seidel does in a handful of passes. */
function cascade(data: Float64Array, frozen: Uint8Array, w: number, h: number, sweeps: number, minSize: number): void {
  if (w > minSize && h > minSize) {
    const c = coarsen(data, frozen, w, h);
    cascade(c.data, c.frozen, c.w, c.h, sweeps, minSize);
    for (let zi = 0; zi < h; zi++) {
      for (let xi = 0; xi < w; xi++) {
        const i = zi * w + xi;
        if (frozen[i]) continue;
        data[i] = c.data[(zi >> 1) * c.w + (xi >> 1)];
      }
    }
  }
  for (let s = 0; s < sweeps; s++) laplaceSweep(data, frozen, w, h, s % 2 === 0);
}

export interface LaplaceOptions {
  /** Gauss-Seidel sweeps per multigrid level. Default 12. */
  sweeps?: number;
  /** Stop once the largest residual drops below this. Default 1e-3 blocks. */
  tolerance?: number;
  /** Hard cap on finest-level sweeps. Default 4000. */
  maxSweeps?: number;
}

/**
 * Solves ∇²h = 0 on the free cells with the values already in `data` at the frozen cells
 * held fixed (Dirichlet). Mutates `data` in place.
 */
export function solveLaplace(data: Float64Array, frozen: Uint8Array, w: number, h: number, opts: LaplaceOptions = {}): { sweeps: number; residual: number } {
  const sweeps = opts.sweeps ?? 12;
  const tolerance = opts.tolerance ?? 1e-3;
  const maxSweeps = opts.maxSweeps ?? 4000;
  cascade(data, frozen, w, h, sweeps, 6);
  let n = 0;
  let residual = 0;
  do {
    residual = laplaceSweep(data, frozen, w, h, n % 2 === 0);
    n++;
  } while (residual > tolerance && n < maxSweeps);
  return { sweeps: n, residual };
}

/** Separable box blur with clamped edges. Frozen cells keep their value. */
export function boxBlur(data: Float64Array, w: number, h: number, radius: number, frozen?: Uint8Array): void {
  if (radius <= 0) return;
  const saved = frozen ? Float64Array.from(data) : undefined;
  const tmp = new Float64Array(w * h);
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      let sum = 0;
      let n = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.min(w - 1, Math.max(0, xi + dx));
        sum += data[zi * w + x];
        n++;
      }
      tmp[zi * w + xi] = sum / n;
    }
  }
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      let sum = 0;
      let n = 0;
      for (let dz = -radius; dz <= radius; dz++) {
        const z = Math.min(h - 1, Math.max(0, zi + dz));
        sum += tmp[z * w + xi];
        n++;
      }
      data[zi * w + xi] = sum / n;
    }
  }
  if (saved && frozen) for (let i = 0; i < data.length; i++) if (frozen[i]) data[i] = saved[i];
}

/**
 * Chamfer (3-4 style, scaled to 1 / √2) distance in blocks from every cell to the nearest
 * cell with `mask[i] === 1`. Two passes, so it is O(n) and deterministic. Cells in the mask
 * get 0; if the mask is empty every cell gets Infinity.
 */
export function chamferDistance(mask: Uint8Array, w: number, h: number): Float64Array {
  const D1 = 1;
  const D2 = Math.SQRT2;
  const out = new Float64Array(w * h);
  out.fill(Infinity);
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[i] = 0;
  const relax = (i: number, j: number, d: number): void => {
    const v = out[j] + d;
    if (v < out[i]) out[i] = v;
  };
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const i = zi * w + xi;
      if (xi > 0) relax(i, i - 1, D1);
      if (zi > 0) {
        relax(i, i - w, D1);
        if (xi > 0) relax(i, i - w - 1, D2);
        if (xi < w - 1) relax(i, i - w + 1, D2);
      }
    }
  }
  for (let zi = h - 1; zi >= 0; zi--) {
    for (let xi = w - 1; xi >= 0; xi--) {
      const i = zi * w + xi;
      if (xi < w - 1) relax(i, i + 1, D1);
      if (zi < h - 1) {
        relax(i, i + w, D1);
        if (xi < w - 1) relax(i, i + w + 1, D2);
        if (xi > 0) relax(i, i + w - 1, D2);
      }
    }
  }
  return out;
}

export interface StepClampResult {
  iterations: number;
  converged: boolean;
  /** Largest 4-neighbour difference left in the field, over pairs with at least one free cell. */
  maxStep: number;
  /** How many such pairs still exceed the requested limit. */
  steepPairs: number;
  /** How many of those are between two columns we were free to move. */
  steepFreePairs: number;
}

export interface NeighbourStepStats {
  maxStep: number;
  /** Pairs over the limit where at least one column is free. */
  steepPairs: number;
  /** Pairs over the limit where BOTH columns are free — the ones we actually shaped, as
   * opposed to a step inherited from the real terrain or the pad we were told to hold. */
  steepFreePairs: number;
}

/** Largest 4-neighbour height difference, counting only pairs where at least one cell is
 * free — a pair of frozen cells is real terrain we were told not to touch. */
export function maxNeighbourStep(data: Float64Array, w: number, h: number, limit: number, frozen?: Uint8Array): NeighbourStepStats {
  let maxStep = 0;
  let steepPairs = 0;
  let steepFreePairs = 0;
  const check = (a: number, b: number): void => {
    if (frozen && frozen[a] && frozen[b]) return;
    const d = Math.abs(data[a] - data[b]);
    if (d > maxStep) maxStep = d;
    // A tolerance well below a block: the relaxation lands on values like 1.00000003, which
    // is the same block as 1 once the field is rounded, and must not read as a violation.
    if (d > limit + 1e-6) {
      steepPairs++;
      if (!frozen || (!frozen[a] && !frozen[b])) steepFreePairs++;
    }
  };
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const i = zi * w + xi;
      if (xi < w - 1) check(i, i + 1);
      if (zi < h - 1) check(i, i + w);
    }
  }
  return { maxStep, steepPairs, steepFreePairs };
}

/**
 * Pulls every free cell into [max(neighbour) − maxStep, min(neighbour) + maxStep] until the
 * field stops moving, so the result is walkable: no 4-neighbour pair climbs more than
 * `maxStep` blocks. Frozen cells never move.
 *
 * When the neighbours disagree by more than 2·maxStep the interval is empty and the cell
 * takes the midpoint, which splits the difference instead of picking a side and oscillating.
 *
 * The field is left in floating point. Rounding it to whole blocks afterwards cannot break
 * the bound, because |round(a) − round(b)| ≤ ceil(|a − b|), so a field within `maxStep`
 * (an integer) stays within `maxStep` once rounded.
 *
 * A guarantee and its limit, both worth being explicit about:
 *  - With no frozen cells the constraint is always satisfiable, and a final monotone
 *    lowering pass (`h ← min(h, min(neighbours) + maxStep)`, which only ever decreases and
 *    so must terminate) is run if the main loop has not already got there. Its fixed point
 *    is exactly "no cell is more than maxStep above any neighbour", which — applied to both
 *    cells of a pair — is the two-sided bound.
 *  - With frozen cells the boundary data can simply be infeasible: a pad 20 blocks above
 *    terrain 8 columns away cannot be joined at 1 block per column by any field at all. The
 *    caller is told what the real maximum came out as (`maxStep`) rather than being handed a
 *    cliff at the border, which is what forcing the constraint would produce.
 */
export interface StepClampOptions {
  /** Columns that must not move. */
  frozen?: Uint8Array;
  maxIterations?: number;
}

/** Cell updates the relaxation is allowed to spend, so a 512x512 terraform costs about as
 * much as a 25x25 one instead of a thousand times more. */
const CLAMP_WORK_BUDGET = 30_000_000;

export function clampSteps(data: Float64Array, w: number, h: number, maxStep: number, opts: StepClampOptions = {}): StepClampResult {
  const { frozen } = opts;
  const limit = Math.max(0, maxStep);
  const cap = opts.maxIterations ?? Math.max(64, Math.min(4096, Math.floor(CLAMP_WORK_BUDGET / Math.max(1, w * h))));
  const neighbours = (i: number, xi: number, zi: number, fn: (j: number) => void): void => {
    if (xi > 0) fn(i - 1);
    if (xi < w - 1) fn(i + 1);
    if (zi > 0) fn(i - w);
    if (zi < h - 1) fn(i + w);
  };
  let iterations = 0;
  let moved = true;
  while (moved && iterations < cap) {
    moved = false;
    const forward = iterations % 2 === 0;
    const z0 = forward ? 0 : h - 1;
    const zEnd = forward ? h : -1;
    const dz = forward ? 1 : -1;
    for (let zi = z0; zi !== zEnd; zi += dz) {
      const x0 = forward ? 0 : w - 1;
      const xEnd = forward ? w : -1;
      const dx = forward ? 1 : -1;
      for (let xi = x0; xi !== xEnd; xi += dx) {
        const i = zi * w + xi;
        if (frozen?.[i]) continue;
        let lo = -Infinity;
        let hi = Infinity;
        neighbours(i, xi, zi, (j) => {
          if (data[j] - limit > lo) lo = data[j] - limit;
          if (data[j] + limit < hi) hi = data[j] + limit;
        });
        if (lo === -Infinity) continue;
        const current = data[i];
        let next = current;
        if (lo > hi) next = (lo + hi) / 2;
        else if (current < lo) next = lo;
        else if (current > hi) next = hi;
        if (Math.abs(next - current) > 1e-9) {
          data[i] = next;
          moved = true;
        }
      }
    }
    iterations++;
  }

  let stats = maxNeighbourStep(data, w, h, limit, frozen);
  const anyFrozen = frozen ? frozen.some((v) => v === 1) : false;
  if (stats.steepPairs > 0 && !anyFrozen) {
    // Unconstrained case: lower until nothing sits more than `limit` above a neighbour. This
    // only ever decreases values, is bounded below by the field's own minimum, and so always
    // terminates at a field that satisfies the constraint.
    let lowering = true;
    let guard = 0;
    while (lowering && guard < cap * 4) {
      lowering = false;
      for (let zi = 0; zi < h; zi++) {
        for (let xi = 0; xi < w; xi++) {
          const i = zi * w + xi;
          let lowest = Infinity;
          neighbours(i, xi, zi, (j) => {
            if (data[j] < lowest) lowest = data[j];
          });
          if (lowest === Infinity) continue;
          if (data[i] > lowest + limit + 1e-6) {
            data[i] = lowest + limit;
            lowering = true;
          }
        }
      }
      guard++;
      iterations++;
    }
    stats = maxNeighbourStep(data, w, h, limit, frozen);
  }
  return { iterations, converged: !moved, maxStep: stats.maxStep, steepPairs: stats.steepPairs, steepFreePairs: stats.steepFreePairs };
}
