import { describe, it, expect } from 'vitest';
import { boxBlur, chamferDistance, clampSteps, maxNeighbourStep, smoothstep, solveLaplace } from '../../src/terrain/field.js';
import { hash2 } from '../../src/terrain/noise.js';

function borderMask(w: number, h: number): Uint8Array {
  const frozen = new Uint8Array(w * h);
  for (let zi = 0; zi < h; zi++) for (let xi = 0; xi < w; xi++) if (xi === 0 || zi === 0 || xi === w - 1 || zi === h - 1) frozen[zi * w + xi] = 1;
  return frozen;
}

function round(data: Float64Array): Float64Array {
  return Float64Array.from(data, Math.round);
}

function worstNeighbourDelta(data: Float64Array, w: number, h: number): number {
  let worst = 0;
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const i = zi * w + xi;
      if (xi < w - 1) worst = Math.max(worst, Math.abs(data[i] - data[i + 1]));
      if (zi < h - 1) worst = Math.max(worst, Math.abs(data[i] - data[i + w]));
    }
  }
  return worst;
}

describe('solveLaplace', () => {
  it('converges and keeps every boundary value', () => {
    const w = 21;
    const h = 17;
    const frozen = borderMask(w, h);
    const data = new Float64Array(w * h);
    for (let zi = 0; zi < h; zi++) for (let xi = 0; xi < w; xi++) if (frozen[zi * w + xi]) data[zi * w + xi] = xi;
    const before = Float64Array.from(data);
    const { residual } = solveLaplace(data, frozen, w, h, { tolerance: 1e-5 });
    expect(residual).toBeLessThanOrEqual(1e-5);
    for (let i = 0; i < data.length; i++) if (frozen[i]) expect(data[i]).toBe(before[i]);
    // h(x, z) = x is harmonic and matches this boundary data, so by uniqueness the interior
    // must be it.
    for (let zi = 1; zi < h - 1; zi++) for (let xi = 1; xi < w - 1; xi++) expect(data[zi * w + xi]).toBeCloseTo(xi, 2);
  });

  it('ramps between two different boundary levels with no interior extremum', () => {
    const w = 31;
    const h = 31;
    const frozen = new Uint8Array(w * h);
    const data = new Float64Array(w * h);
    // A flat pad in the middle at 20, the border at 0.
    for (let zi = 0; zi < h; zi++) {
      for (let xi = 0; xi < w; xi++) {
        const i = zi * w + xi;
        if (xi === 0 || zi === 0 || xi === w - 1 || zi === h - 1) {
          frozen[i] = 1;
          data[i] = 0;
        } else if (xi >= 12 && xi <= 18 && zi >= 12 && zi <= 18) {
          frozen[i] = 1;
          data[i] = 20;
        }
      }
    }
    solveLaplace(data, frozen, w, h);
    // Walking out from the pad edge to the border must descend the whole way: a terrace or a
    // ring would show up here as a flat or rising step.
    for (let xi = 18; xi < w - 1; xi++) {
      const here = data[15 * w + xi];
      const next = data[15 * w + xi + 1];
      expect(next).toBeLessThan(here + 1e-9);
    }
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(-1e-9);
      expect(data[i]).toBeLessThanOrEqual(20 + 1e-9);
    }
  });
});

describe('clampSteps', () => {
  it('guarantees no neighbour climbs more than max_step', () => {
    const w = 33;
    const h = 29;
    const data = new Float64Array(w * h);
    for (let zi = 0; zi < h; zi++) for (let xi = 0; xi < w; xi++) data[zi * w + xi] = Math.round(hash2(xi, zi, 7) * 40);
    expect(worstNeighbourDelta(data, w, h)).toBeGreaterThan(10);
    const r = clampSteps(data, w, h, 1);
    expect(r.steepPairs).toBe(0);
    expect(worstNeighbourDelta(round(data), w, h)).toBeLessThanOrEqual(1);
  });

  it('honours other max_step values', () => {
    const w = 24;
    const h = 24;
    const data = new Float64Array(w * h);
    for (let zi = 0; zi < h; zi++) for (let xi = 0; xi < w; xi++) data[zi * w + xi] = Math.round(hash2(xi, zi, 42) * 60);
    clampSteps(data, w, h, 3);
    expect(worstNeighbourDelta(round(data), w, h)).toBeLessThanOrEqual(3);
  });

  it('never moves a frozen column, and still reaches max_step around it', () => {
    // A frozen border that is itself walkable (half a block per column), so the constraint is
    // satisfiable and the clamp has to actually reach it rather than give up.
    const w = 25;
    const h = 25;
    const frozen = borderMask(w, h);
    const data = new Float64Array(w * h);
    for (let zi = 0; zi < h; zi++) for (let xi = 0; xi < w; xi++) data[zi * w + xi] = frozen[zi * w + xi] ? Math.round(xi * 0.5) : Math.round(hash2(xi, zi, 3) * 30);
    const before = Float64Array.from(data);
    clampSteps(data, w, h, 1, { frozen });
    for (let i = 0; i < data.length; i++) if (frozen[i]) expect(data[i]).toBe(before[i]);
    expect(maxNeighbourStep(round(data), w, h, 1, frozen).steepPairs).toBe(0);
  });

  it('reports the real slope instead of cliffing when the boundary data cannot be met', () => {
    // A pad 20 blocks up, two columns from a border at 0: no field can join those at 1 block
    // per column, and saying so is better than hiding a cliff.
    const w = 7;
    const h = 7;
    const frozen = borderMask(w, h);
    const data = new Float64Array(w * h);
    for (let zi = 0; zi < h; zi++) {
      for (let xi = 0; xi < w; xi++) {
        const i = zi * w + xi;
        if (frozen[i]) data[i] = 0;
        else if (xi === 3 && zi === 3) {
          frozen[i] = 1;
          data[i] = 20;
        }
      }
    }
    const r = clampSteps(data, w, h, 1, { frozen });
    expect(r.steepPairs).toBeGreaterThan(0);
    expect(r.maxStep).toBeGreaterThan(1);
    expect(data[3 * w + 3]).toBe(20);
  });
});

describe('boxBlur', () => {
  it('averages neighbours and leaves frozen cells alone', () => {
    const w = 5;
    const h = 5;
    const data = new Float64Array(w * h);
    data[2 * w + 2] = 9;
    const frozen = new Uint8Array(w * h);
    frozen[0] = 1;
    data[0] = 100;
    boxBlur(data, w, h, 1, frozen);
    expect(data[0]).toBe(100);
    expect(data[2 * w + 2]).toBeCloseTo(1, 6);
    expect(data[2 * w + 1]).toBeGreaterThan(0);
  });

  it('does nothing at radius 0', () => {
    const data = Float64Array.from([1, 2, 3, 4]);
    boxBlur(data, 2, 2, 0);
    expect([...data]).toEqual([1, 2, 3, 4]);
  });
});

describe('chamferDistance', () => {
  it('measures distance to the nearest masked cell', () => {
    const w = 9;
    const h = 9;
    const mask = new Uint8Array(w * h);
    mask[4 * w + 4] = 1;
    const d = chamferDistance(mask, w, h);
    expect(d[4 * w + 4]).toBe(0);
    expect(d[4 * w + 5]).toBeCloseTo(1, 6);
    expect(d[5 * w + 5]).toBeCloseTo(Math.SQRT2, 6);
    expect(d[4 * w + 8]).toBeCloseTo(4, 6);
  });

  it('is Infinity everywhere when nothing is masked', () => {
    const d = chamferDistance(new Uint8Array(9), 3, 3);
    for (const v of d) expect(v).toBe(Infinity);
  });
});

describe('maxNeighbourStep', () => {
  it('ignores pairs where both columns are frozen', () => {
    const w = 3;
    const h = 1;
    const data = Float64Array.from([0, 10, 20]);
    const frozen = Uint8Array.from([1, 1, 0]);
    expect(maxNeighbourStep(data, w, h, 1).maxStep).toBe(10);
    expect(maxNeighbourStep(data, w, h, 1, frozen).maxStep).toBe(10);
    expect(maxNeighbourStep(data, w, h, 1, frozen).steepPairs).toBe(1);
  });
});

describe('smoothstep', () => {
  it('is clamped and smooth', () => {
    expect(smoothstep(0, 1, -5)).toBe(0);
    expect(smoothstep(0, 1, 5)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(2, 2, 3)).toBe(1);
  });
});
