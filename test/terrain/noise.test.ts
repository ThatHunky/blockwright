import { describe, it, expect } from 'vitest';
import { fbm2, hash2, valueNoise2 } from '../../src/terrain/noise.js';

describe('hash2', () => {
  it('is deterministic and in [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = hash2(i * 7 - 300, i * -13 + 91, 1234);
      expect(v).toBe(hash2(i * 7 - 300, i * -13 + 91, 1234));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('separates seeds and neighbouring lattice points', () => {
    expect(hash2(0, 0, 0)).not.toBe(hash2(0, 0, 1));
    expect(hash2(0, 0, 0)).not.toBe(hash2(1, 0, 0));
    expect(hash2(0, 0, 0)).not.toBe(hash2(0, 1, 0));
    // The origin with seed 0 is the degenerate case for an xor-based hash; it must not be 0.
    expect(hash2(0, 0, 0)).toBeGreaterThan(0);
  });

  it('spreads roughly uniformly', () => {
    const buckets = new Array<number>(10).fill(0);
    for (let x = 0; x < 100; x++) for (let z = 0; z < 100; z++) buckets[Math.floor(hash2(x, z, 5) * 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(700);
  });
});

describe('valueNoise2', () => {
  it('stays in [-1, 1] and is continuous', () => {
    let previous = valueNoise2(0, 0, 3);
    for (let i = 1; i <= 400; i++) {
      const v = valueNoise2(i / 8, 2.5, 3);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      // A step of 1/8 of a lattice cell can never jump the full range.
      expect(Math.abs(v - previous)).toBeLessThan(0.8);
      previous = v;
    }
  });

  it('reproduces the lattice values at integer points', () => {
    expect(valueNoise2(4, -7, 11)).toBeCloseTo(hash2(4, -7, 11) * 2 - 1, 12);
  });
});

describe('fbm2', () => {
  const opts = { octaves: 4, wavelength: 32, seed: 99 };

  it('is deterministic for a seed', () => {
    const first = Array.from({ length: 64 }, (_, i) => fbm2(i, i * 2, opts));
    const second = Array.from({ length: 64 }, (_, i) => fbm2(i, i * 2, opts));
    expect(second).toEqual(first);
  });

  it('changes with the seed', () => {
    const a = Array.from({ length: 64 }, (_, i) => fbm2(i, 0, opts));
    const b = Array.from({ length: 64 }, (_, i) => fbm2(i, 0, { ...opts, seed: 100 }));
    expect(b).not.toEqual(a);
  });

  it('stays inside [-1, 1] so amplitude means blocks', () => {
    for (let x = -200; x <= 200; x += 3) {
      for (let z = -200; z <= 200; z += 7) {
        const v = fbm2(x, z, opts);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('varies on the scale of the largest wavelength, not per column', () => {
    // Neighbouring columns must be close (no single-column spikes), while points half a
    // wavelength apart must actually differ — that is the difference between terrain and
    // static.
    let maxNeighbour = 0;
    for (let x = 0; x < 200; x++) maxNeighbour = Math.max(maxNeighbour, Math.abs(fbm2(x, 40, opts) - fbm2(x + 1, 40, opts)));
    expect(maxNeighbour).toBeLessThan(0.35);
    let maxFar = 0;
    for (let x = 0; x < 200; x++) maxFar = Math.max(maxFar, Math.abs(fbm2(x, 40, opts) - fbm2(x + 16, 40, opts)));
    expect(maxFar).toBeGreaterThan(0.4);
  });
});
