import { z } from 'zod';
import { BlockState, VoxelSet } from './voxels.js';
import { Vec3Schema, RotationSchema, MirrorSchema } from './schemas.js';
import { stepsFromDegrees, transformAnchored } from './rotate.js';
import { DEFAULT_MAX_VOXELS, MAX_VOXELS_ENV_VAR, maxVoxels, voxelCapMessage } from './voxel-cap.js';

/** Sanity caps on individual layer fields; the real guard against runaway allocations is the
 * voxel-count check in buildSpecToRelativeVoxels (BLOCKWRIGHT_MAX_VOXELS), since a spec can
 * still combine many layers and long rows to exceed it even while every individual field stays
 * within these bounds (e.g. thousands of layers, each with a near-max-length row). These bounds
 * comfortably exceed any legitimate build: Minecraft's playable world height is well under 512
 * blocks, and even the largest hand-built structures rarely span more than a few hundred blocks
 * in any one dimension. */
const MAX_LAYERS = 4096;
const MAX_ROW_LENGTH = 4096;
const MAX_Y_SPAN = 4096;

const YSchema = z
  .union([z.number().int(), z.tuple([z.number().int(), z.number().int()])])
  .superRefine((val, ctx) => {
    if (!Array.isArray(val)) return;
    const span = Math.abs(val[1] - val[0]);
    if (span > MAX_Y_SPAN) {
      const count = span + 1;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `layer y range [${val[0]}, ${val[1]}] spans ${count.toLocaleString()} blocks, which exceeds the ${MAX_Y_SPAN.toLocaleString()}-block ` +
          `maximum for a single layer's range. That maximum exists so a range can't be materialized before it's even known whether the request ` +
          `would fit under the ${DEFAULT_MAX_VOXELS.toLocaleString()}-voxel limit (set via ${MAX_VOXELS_ENV_VAR}). Reduce the range, or split the ` +
          `build across multiple layers or calls.`,
      });
    }
  })
  .describe('Height above origin, or an inclusive [from, to] range that repeats the rows');

export const buildSpecShape = {
  origin: Vec3Schema.describe("World position that the spec's (0,0,0) maps to: the min corner of the build"),
  palette: z
    .record(z.string().length(1), z.string())
    .default({})
    .describe('Single character → block state, e.g. {"#":"stone_bricks","g":"glass_pane","." : "air"}. Space always means "leave the world alone".'),
  layers: z
    .array(
      z.object({
        y: YSchema,
        rows: z
          .array(z.string().max(MAX_ROW_LENGTH, `row length must not exceed ${MAX_ROW_LENGTH.toLocaleString()} characters`))
          .min(1)
          .describe(
            'Rows run north→south (z), characters run west→east (x). All rows within a layer must have the same length — ' +
              'pad shorter rows with trailing spaces (a space always means "leave the world alone", so padding is safe).',
          ),
      }),
    )
    .max(MAX_LAYERS, `a build may not have more than ${MAX_LAYERS.toLocaleString()} layers`)
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

/** Validates a layer's rows are all the same length and returns that length. Shared between the
 * pre-loop size estimate and the generation loop so the two can never disagree about it. */
function checkRaggedRows(layer: BuildSpec['layers'][number], li: number): number {
  const expectedLen = layer.rows[0].length;
  layer.rows.forEach((row, z) => {
    if (row.length !== expectedLen) {
      throw new BuildSpecError(`layer ${li}: rows must have equal length (expected ${expectedLen}, row ${z} has length ${row.length})`);
    }
  });
  return expectedLen;
}

function ySpanCount(y: BuildSpec['layers'][number]['y']): number {
  return Array.isArray(y) ? Math.abs(y[1] - y[0]) + 1 : 1;
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

  // Check each layer's declared size against the cap before allocating or even materializing its
  // y range (range() below would otherwise build an array with one entry per y value), so a
  // caller that bypasses schema validation still can't force an expensive allocation purely from
  // a spec's declared dimensions. spec.blocks isn't included here — it's already a plain array,
  // nothing needs to be materialized to know its size — and is instead covered by the running
  // check below, alongside layers, as a second line of defense.
  const cap = maxVoxels();
  let estimate = 0;
  spec.layers.forEach((layer, li) => {
    const expectedLen = checkRaggedRows(layer, li);
    estimate += ySpanCount(layer.y) * layer.rows.length * expectedLen;
  });
  if (estimate > cap) {
    throw new BuildSpecError(voxelCapMessage('build', estimate, cap));
  }

  const rel = new VoxelSet();
  let count = 0;
  const put = (x: number, y: number, z: number, state: BlockState) => {
    count++;
    if (count > cap) {
      throw new BuildSpecError(voxelCapMessage('build', 'running', cap));
    }
    rel.set(x, y, z, state);
  };
  spec.layers.forEach((layer, li) => {
    const ys = Array.isArray(layer.y) ? range(layer.y[0], layer.y[1]) : [layer.y];
    layer.rows.forEach((row, z) => {
      [...row].forEach((ch, x) => {
        if (ch === ' ') return;
        const state = palette.get(ch);
        if (!state) throw new BuildSpecError(`layer ${li} row ${z} col ${x}: character "${ch}" is not in the palette`);
        for (const y of ys) put(x, y, z, state);
      });
    });
  });
  spec.blocks.forEach((b, i) => {
    let state: BlockState;
    try {
      state = BlockState.parse(b.block);
    } catch (e) {
      throw new BuildSpecError(`blocks[${i}]: ${(e as Error).message}`);
    }
    put(b.pos[0], b.pos[1], b.pos[2], state);
  });
  if (rel.size === 0) throw new BuildSpecError('spec produced no blocks (only spaces?)');
  return transformAnchored(rel, stepsFromDegrees(spec.rotation), spec.mirror);
}

export function buildSpecToVoxels(spec: BuildSpec): VoxelSet {
  return buildSpecToRelativeVoxels(spec).translate(spec.origin[0], spec.origin[1], spec.origin[2]);
}
