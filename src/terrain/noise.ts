/**
 * Deterministic 2D value noise and fBm.
 *
 * This is deliberately NOT a reimplementation of Minecraft's density-function stack — that
 * needs continentalness/erosion/peaks-and-valleys splines, a biome router and an aquifer
 * model, none of which we can reproduce faithfully for an arbitrary server. What we take
 * from vanilla is the *shape* of its surface noise: the octave counts and wavelengths in
 * data/minecraft/worldgen/noise/*.json. surface.json is 3 octaves from firstOctave -6
 * (wavelengths 64/32/16), surface_secondary.json 4 from -6, ridge.json 6 from -7. So 3-4
 * octaves with a largest wavelength in the 24-48 block range, each octave at half the
 * amplitude of the one before, lands in the same visual register as generated terrain:
 * broad rolls with a little fine grain on top, and no single-column spikes.
 *
 * Everything here is a pure function of (x, z, seed): the same arguments always give the
 * same number, on any machine, so a terraform can be previewed with dry_run and then
 * applied for real and produce exactly the same ground.
 */

/** 32-bit integer hash of a lattice point, returned as a float in [0, 1). */
export function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = (h ^ 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Perlin's quintic fade curve: zero first and second derivatives at the lattice points, so
 * neighbouring cells join without a visible crease. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise at a real-valued point, in [-1, 1]. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const u = fade(x - x0);
  const v = fade(z - z0);
  const n00 = hash2(x0, z0, seed);
  const n10 = hash2(x0 + 1, z0, seed);
  const n01 = hash2(x0, z0 + 1, seed);
  const n11 = hash2(x0 + 1, z0 + 1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 2 - 1;
}

export interface FbmOptions {
  /** Number of octaves; 3-4 matches vanilla's surface noises. */
  octaves: number;
  /** Wavelength of the first (largest) octave, in blocks. */
  wavelength: number;
  seed: number;
  /** Amplitude ratio between an octave and the one before it. Default 0.5. */
  gain?: number;
  /** Frequency ratio between an octave and the one before it. Default 2. */
  lacunarity?: number;
}

/**
 * Fractal Brownian motion: octaves of value noise summed at halving amplitude and doubling
 * frequency, normalised back into [-1, 1] so `amplitude` in blocks means what it says.
 */
export function fbm2(x: number, z: number, o: FbmOptions): number {
  const gain = o.gain ?? 0.5;
  const lacunarity = o.lacunarity ?? 2;
  const octaves = Math.max(1, Math.floor(o.octaves));
  const wavelength = Math.max(1e-6, o.wavelength);
  let amp = 1;
  let freq = 1 / wavelength;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    // Offsetting each octave keeps the lattices from lining up at the origin, which would
    // otherwise show as a cross-shaped artefact through (0, 0).
    sum += amp * valueNoise2(x * freq + i * 137.17, z * freq - i * 91.31, (o.seed + i * 1013) | 0);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
