import { z } from 'zod';
import { BlockState, VoxelSet } from './voxels.js';
import { Vec3Schema, RotationSchema, MirrorSchema } from './schemas.js';
import { stepsFromDegrees, transformAnchored } from './rotate.js';

export const buildSpecShape = {
  origin: Vec3Schema.describe("World position that the spec's (0,0,0) maps to: the min corner of the build"),
  palette: z
    .record(z.string().length(1), z.string())
    .default({})
    .describe('Single character → block state, e.g. {"#":"stone_bricks","g":"glass_pane","." : "air"}. Space always means "leave the world alone".'),
  layers: z
    .array(
      z.object({
        y: z
          .union([z.number().int(), z.tuple([z.number().int(), z.number().int()])])
          .describe('Height above origin, or an inclusive [from, to] range that repeats the rows'),
        rows: z
          .array(z.string())
          .min(1)
          .describe(
            'Rows run north→south (z), characters run west→east (x). All rows within a layer must have the same length — ' +
              'pad shorter rows with trailing spaces (a space always means "leave the world alone", so padding is safe).',
          ),
      }),
    )
    .default([]),
  blocks: z
    .array(z.object({ pos: Vec3Schema, block: z.string() }))
    .default([])
    .describe('Extra single blocks at positions relative to origin, e.g. {"pos":[2,3,1],"block":"lantern[hanging=true]"}'),
  rotation: RotationSchema.default(0).describe('Clockwise quarter turns seen from above. The min corner stays at origin.'),
  mirror: MirrorSchema.default('none').describe('x flips east↔west, z flips north↔south. Applied before rotation.'),
};

export const BuildSpecSchema = z.object(buildSpecShape);
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

export class BuildSpecError extends Error {}

function range(a: number, b: number): number[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

/** Relative voxels (before origin/rotation) — used by preview and schematic_write as well. */
export function buildSpecToRelativeVoxels(spec: BuildSpec): VoxelSet {
  const palette = new Map<string, BlockState>();
  for (const [ch, text] of Object.entries(spec.palette)) {
    try {
      palette.set(ch, BlockState.parse(text));
    } catch (e) {
      throw new BuildSpecError(`palette "${ch}": ${(e as Error).message}`);
    }
  }
  const rel = new VoxelSet();
  spec.layers.forEach((layer, li) => {
    const expectedLen = layer.rows[0].length;
    layer.rows.forEach((row, z) => {
      if (row.length !== expectedLen) {
        throw new BuildSpecError(`layer ${li}: rows must have equal length (expected ${expectedLen}, row ${z} has length ${row.length})`);
      }
    });
    const ys = Array.isArray(layer.y) ? range(layer.y[0], layer.y[1]) : [layer.y];
    layer.rows.forEach((row, z) => {
      [...row].forEach((ch, x) => {
        if (ch === ' ') return;
        const state = palette.get(ch);
        if (!state) throw new BuildSpecError(`layer ${li} row ${z} col ${x}: character "${ch}" is not in the palette`);
        for (const y of ys) rel.set(x, y, z, state);
      });
    });
  });
  spec.blocks.forEach((b, i) => {
    try {
      rel.set(b.pos[0], b.pos[1], b.pos[2], BlockState.parse(b.block));
    } catch (e) {
      throw new BuildSpecError(`blocks[${i}]: ${(e as Error).message}`);
    }
  });
  if (rel.size === 0) throw new BuildSpecError('spec produced no blocks (only spaces?)');
  return transformAnchored(rel, stepsFromDegrees(spec.rotation), spec.mirror);
}

export function buildSpecToVoxels(spec: BuildSpec): VoxelSet {
  return buildSpecToRelativeVoxels(spec).translate(spec.origin[0], spec.origin[1], spec.origin[2]);
}
