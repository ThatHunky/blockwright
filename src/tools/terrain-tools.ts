import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { BlockState, box, boxVolume, type Box } from '../voxel/voxels.js';
import { Vec2Schema, Vec3Schema } from '../voxel/schemas.js';
import { prefixDimension } from '../voxel/compile.js';
import { maxVoxels, voxelCapMessage } from '../voxel/voxel-cap.js';
import { resolveWorld } from '../world/dimension.js';
import { columnsFromVoxels, type ColumnGrid } from '../terrain/columns.js';
import { modeDefaults, planTerrain, terraformVoxels, type TerraformMode } from '../terrain/terraform.js';
import { planScatter, scatterVoxelSet, supportIssues, type ScatterEntry } from '../terrain/scatter.js';
import { probeColumnCost, probeColumnGrid } from '../terrain/probe.js';
import { ok, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError } from './common.js';
import { maxReadVolume, MAX_VOXELS_ENV_VAR } from './read-tools.js';

/** A terraform reads one slab of world and holds one byte per cell; 512x512 columns is a
 * generous ceiling for a build site and keeps that allocation sane. */
const MAX_TERRAFORM_COLUMNS = 262_144;
/** Printed height grids stay readable; sample down to roughly this many rows/columns. */
const GRID_SAMPLES = 24;

const protectShape = z.object({
  from: Vec2Schema.describe('[x, z]'),
  to: Vec2Schema.optional().describe('[x, z] of the opposite corner; omit for a single position'),
  radius: z.number().int().min(0).max(64).default(0).describe('Extra columns around the position or box'),
});

function rectMask(grid: ColumnGrid, minX: number, minZ: number, maxX: number, maxZ: number, mask: Uint8Array): number {
  let n = 0;
  const x0 = Math.max(grid.minX, Math.min(minX, maxX));
  const x1 = Math.min(grid.minX + grid.w - 1, Math.max(minX, maxX));
  const z0 = Math.max(grid.minZ, Math.min(minZ, maxZ));
  const z1 = Math.min(grid.minZ + grid.h - 1, Math.max(minZ, maxZ));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const i = (z - grid.minZ) * grid.w + (x - grid.minX);
      if (!mask[i]) n++;
      mask[i] = 1;
    }
  }
  return n;
}

/** A sampled grid of numbers in the same shape get_heightmap prints, so an assistant can
 * read the plan the way it reads the terrain it scouted. */
function printGrid(values: (i: number) => number | null, grid: ColumnGrid, label: string): string[] {
  const step = Math.max(1, Math.ceil(Math.max(grid.w, grid.h) / GRID_SAMPLES));
  const lines = [`${label} (every ${step} block(s); rows z=${grid.minZ}.. downwards, columns x=${grid.minX}.. rightwards):`];
  for (let zi = 0; zi < grid.h; zi += step) {
    const row: string[] = [];
    for (let xi = 0; xi < grid.w; xi += step) {
      const v = values(zi * grid.w + xi);
      row.push(v === null ? '--' : String(v));
    }
    lines.push(`  z=${String(grid.minZ + zi).padStart(6)} | ${row.join(' ')}`);
  }
  return lines;
}

async function sampleColumns(ctx: AppContext, b: Box, world: ReturnType<typeof resolveWorld>): Promise<{ grid: ColumnGrid; source: string; blockAt?: (x: number, y: number, z: number) => BlockState | undefined; notes: string[] }> {
  const notes: string[] = [];
  if (ctx.bridge.canRead()) {
    const r = await ctx.bridge.read(b, world);
    if (r.missingChunks) notes.push(`${r.missingChunks} chunk(s) in this box are not generated; those columns are left untouched.`);
    const grid = columnsFromVoxels(r.voxels, b);
    return { grid, source: 'region files', blockAt: (x, y, z) => r.voxels.get(x, y, z), notes };
  }
  const cost = probeColumnCost(b);
  notes.push(
    `World reads are unavailable (no BLOCKWRIGHT_SERVER_DIR), so the surface was probed with ~${cost.commands.toLocaleString()} console commands. ` +
      'That probe cannot see caves or overhangs, and no snapshot could be taken, so undo will not work for this write.',
  );
  const probe = await probeColumnGrid((cmd) => ctx.bridge.runCommand(cmd), b, { prefix: (t) => prefixDimension(t, world.dimension) });
  if (probe.emptyColumns) notes.push(`${probe.emptyColumns} column(s) held nothing but air in this y range and are left untouched.`);
  return { grid: probe.grid, source: `command probe (${probe.commands} commands)`, notes };
}

export function registerTerrainTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'terraform',
    {
      title: 'Shape natural ground',
      description:
        'Reshape the ground inside a box into a smooth, walkable, vanilla-looking surface. blend: ramp the terrain from a building pad (keep_from/keep_to, levelled to keep_y) out to the untouched terrain at the box border — use this to sink a build into a hillside instead of leaving it on a cut cube. smooth: soften rough ground while keeping its shape. hill: raise a natural landform. The border always keeps the real terrain height, so there is never a seam. Make the box 12-20 blocks wider than the pad on every side so the slope has room. Anything standing on a column it reshapes (a tree, a fence, a path) is cleared along with the ground under it — list those in protect, or keep them outside the box. Run with dry_run=true first and read the target height grid it prints.',
      inputSchema: {
        from: Vec3Schema.describe('One corner of the box; its y range bounds where terraform may carve and fill'),
        to: Vec3Schema.describe('The opposite corner'),
        mode: z.enum(['blend', 'smooth', 'hill']).default('blend'),
        keep_from: Vec2Schema.optional().describe('[x, z] corner of the building footprint / pad'),
        keep_to: Vec2Schema.optional().describe('[x, z] opposite corner of the pad'),
        keep_y: z.number().int().optional().describe('Level the pad to this ground height and ramp to it. Leave it out to keep whatever is there now, untouched.'),
        protect: z.array(protectShape).optional().describe('Columns to leave untouched (trees, a path, someone else\'s build); the slope flows around them'),
        max_step: z.number().int().min(0).max(16).default(1).describe('Largest height difference allowed between neighbouring columns'),
        amplitude: z.number().min(0).max(64).optional().describe('Blocks of fractal variation; default 2 for blend, 0 for smooth, 10 for hill'),
        wavelength: z.number().min(4).max(256).default(32).describe('Wavelength of the largest noise octave, in blocks'),
        octaves: z.number().int().min(1).max(6).default(4),
        noise_fade: z.number().int().min(0).max(128).optional().describe('Blocks over which the noise fades in from the keep edge and the border'),
        blur: z.number().int().min(0).max(8).optional().describe('Box-blur radius on the finished height field'),
        smooth_passes: z.number().int().min(1).max(400).default(24).describe('mode=smooth: more passes means flatter'),
        seed: z.number().int().default(0).describe('Same seed and box always give the same ground'),
        soil_depth: z.number().int().min(0).max(16).default(3).describe('Blocks of soil under the surface block; stone below that'),
        top_block: z.string().default('grass_block'),
        soil_block: z.string().default('dirt'),
        stone_block: z.string().default('stone'),
        include_water: z.boolean().default(false).describe('Also reshape columns whose surface is water'),
        ...writeOptionsShape,
      },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const w = b.max[0] - b.min[0] + 1;
        const h = b.max[2] - b.min[2] + 1;
        if (w < 3 || h < 3) return fail(`terraform needs a box at least 3 columns across in x and z; got ${w}x${h}. The outer ring is held at the real terrain height, so a thinner box has no interior to shape.`);
        const columns = w * h;
        if (columns > MAX_TERRAFORM_COLUMNS) {
          return fail(`terraform requested ${columns.toLocaleString()} columns — x ${b.min[0]}..${b.max[0]}, z ${b.min[2]}..${b.max[2]} — which exceeds the ${MAX_TERRAFORM_COLUMNS.toLocaleString()} column limit. Use a smaller box.`);
        }
        const volume = boxVolume(b);
        const readCap = maxReadVolume();
        if (volume > readCap) {
          return fail(
            `terraform would have to read ${volume.toLocaleString()} blocks — box (${b.min.join(', ')}) to (${b.max.join(', ')}) — which exceeds the ${readCap.toLocaleString()} block read limit. ` +
              `Narrow the y range (it only has to cover the ground, not the sky), or raise the limit with ${MAX_VOXELS_ENV_VAR}.`,
          );
        }

        const palette = {
          top: BlockState.parse(args.top_block),
          soil: BlockState.parse(args.soil_block),
          stone: BlockState.parse(args.stone_block),
        };
        const world = resolveWorld(args.world, ctx.config.levelName);
        const { grid, source, blockAt, notes } = await sampleColumns(ctx, b, world);

        const keep = new Uint8Array(columns);
        let keepColumns = 0;
        if (args.keep_y !== undefined && !args.keep_from && !args.keep_to) {
          return fail('keep_y names the height of the pad given by keep_from/keep_to, so it needs that pad. Give both corners, or drop keep_y.');
        }
        if (args.keep_y !== undefined && (args.keep_y < b.min[1] + args.soil_depth + 1 || args.keep_y > b.max[1])) {
          return fail(`keep_y=${args.keep_y} is outside the working y range of the box (${b.min[1]}..${b.max[1]}), or too close to its floor to fit ${args.soil_depth} block(s) of soil under the surface. Widen the box's y range.`);
        }
        if (args.keep_from || args.keep_to) {
          if (!args.keep_from || !args.keep_to) return fail('terraform needs both keep_from and keep_to, or neither.');
          keepColumns = rectMask(grid, args.keep_from[0], args.keep_from[1], args.keep_to[0], args.keep_to[1], keep);
          if (keepColumns === 0) return fail(`the keep area x ${args.keep_from[0]}..${args.keep_to[0]}, z ${args.keep_from[1]}..${args.keep_to[1]} does not overlap the box; nothing would be kept.`);
        }
        const protect = new Uint8Array(columns);
        let protectColumns = 0;
        for (const p of args.protect ?? []) {
          const to = p.to ?? p.from;
          protectColumns += rectMask(grid, Math.min(p.from[0], to[0]) - p.radius, Math.min(p.from[1], to[1]) - p.radius, Math.max(p.from[0], to[0]) + p.radius, Math.max(p.from[1], to[1]) + p.radius, protect);
        }

        const defaults = modeDefaults(args.mode as TerraformMode, w, h);
        const plan = planTerrain({
          grid,
          mode: args.mode as TerraformMode,
          keep,
          keepHeight: args.keep_y,
          protect,
          seed: args.seed,
          amplitude: args.amplitude ?? defaults.amplitude,
          wavelength: args.wavelength,
          octaves: args.octaves,
          noiseFade: args.noise_fade ?? defaults.noiseFade,
          blur: args.blur ?? defaults.blur,
          maxStep: args.max_step,
          smoothPasses: args.smooth_passes,
        });

        const result = terraformVoxels(grid, plan, palette, { soilDepth: args.soil_depth, includeWater: args.include_water, blockAt });
        if (result.set.size === 0) {
          return ok(
            [
              `terraform ${args.mode}: nothing to change. Every column in the box already sits at its target height (surface read from ${source}).`,
              ...notes,
            ].join('\n'),
          );
        }
        const cap = maxVoxels();
        if (result.set.size > cap) return fail(voxelCapMessage(`terraform ${args.mode}`, result.set.size, cap));
        const err = validationError(result.set, args.allow_unknown_blocks);
        if (err) return fail(err);

        const lines: string[] = [];
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < columns; i++) {
          if (plan.skip[i]) continue;
          lo = Math.min(lo, plan.target[i]);
          hi = Math.max(hi, plan.target[i]);
        }
        lines.push(
          `terraform ${args.mode}: ${result.columns} column(s) reshaped of ${columns} (${plan.raised} raised, ${plan.lowered} lowered), target ground y ${Number.isFinite(lo) ? lo : '-'}..${Number.isFinite(hi) ? hi : '-'}. Surface read from ${source}.`,
        );
        if (keepColumns) lines.push(args.keep_y !== undefined ? `Pad: ${keepColumns} column(s) levelled to y=${args.keep_y}, and the slope solved against that height.` : `Keep area: ${keepColumns} column(s) left exactly as they are.`);
        if (protectColumns) lines.push(`Protected: ${protectColumns} column(s) left exactly as they are.`);
        if (result.skippedWater) lines.push(`${result.skippedWater} column(s) have water at the surface and were skipped (pass include_water=true to shape them too).`);
        lines.push(`Solve: ${plan.sweeps} relaxation sweep(s), residual ${plan.residual.toFixed(4)} blocks; ${result.cleared} block(s) carved to air, ${result.placed} placed.`);
        if (plan.steepFreePairs > 0) {
          lines.push(
            `Warning: ${plan.steepFreePairs} pair(s) of reshaped columns still climb more than max_step=${args.max_step} (worst ${plan.maxStep}). ` +
              'The keep area and the border are both fixed, so the drop between them does not fit in the margin you gave — widen the box, or lower keep_y, to get a gentler slope.',
          );
        } else if (plan.steepPairs > 0) {
          lines.push(
            `Note: ${plan.steepPairs} place(s) meet the border terrain or the keep edge with a step of up to ${plan.maxStep} blocks. That is how steep the ground already is there, not a cut — the reshaped columns themselves are all within max_step=${args.max_step}.`,
          );
        }
        lines.push(...notes);
        lines.push(...printGrid((i) => (plan.skip[i] && !keep[i] ? null : plan.target[i]), grid, 'Target ground height'));

        const apply = await ctx.bridge.apply(result.set, applyOptionsFrom(args, ctx));
        lines.push('', formatApplyResult(apply, `terraform ${args.mode}`));
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`terraform failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'scatter',
    {
      title: 'Scatter plants and boulders on the ground',
      description:
        'Sprinkle blocks from a palette across a box, on solid ground with air above it and nowhere else — nothing can end up floating, buried, or in water. Use it to dress terraformed ground, a meadow or a garden. radius>0 on a palette entry makes a boulder that hugs the slope instead of a single block; two-block plants (tall_grass, rose_bush…) get both halves. Same seed and box always place the same things, so preview with dry_run=true first.',
      inputSchema: {
        from: Vec3Schema.describe('One corner; the y range must cover the ground you want to plant on'),
        to: Vec3Schema,
        palette: z
          .array(
            z.object({
              block: z.string().describe('Block state, e.g. "poppy" or "mossy_cobblestone"'),
              weight: z.number().min(0).max(1000).default(1).describe('Relative chance against the other entries'),
              radius: z.number().int().min(0).max(3).default(0).describe('0 = one block; 1-3 = a boulder of that radius'),
            }),
          )
          .min(1),
        density: z.number().min(0).max(1).default(0.06).describe('Chance per eligible column'),
        seed: z.number().int().default(0),
        max_slope: z.number().int().min(0).max(16).optional().describe('Skip columns whose ground differs from a neighbour by more than this'),
        on: z.array(z.string()).optional().describe('Only place on these ground blocks, e.g. ["grass_block", "podzol"]'),
        spacing: z.number().int().min(0).max(16).default(0).describe('Minimum distance in columns between two placements'),
        max_count: z.number().int().min(1).max(20000).default(4000),
        ...writeOptionsShape,
      },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const volume = boxVolume(b);
        const readCap = maxReadVolume();
        if (volume > readCap) {
          return fail(
            `scatter would have to read ${volume.toLocaleString()} blocks — box (${b.min.join(', ')}) to (${b.max.join(', ')}) — which exceeds the ${readCap.toLocaleString()} block read limit. ` +
              `Narrow the y range, or raise the limit with ${MAX_VOXELS_ENV_VAR}.`,
          );
        }
        if (!ctx.bridge.canRead()) {
          return fail('scatter needs world read access to know where the ground is — otherwise it cannot guarantee that nothing ends up floating. Set BLOCKWRIGHT_SERVER_DIR to the server folder.');
        }
        const world = resolveWorld(args.world, ctx.config.levelName);
        const read = await ctx.bridge.read(b, world);
        const grid = columnsFromVoxels(read.voxels, b);
        const entries: ScatterEntry[] = args.palette.map((p) => ({ block: BlockState.parse(p.block), weight: p.weight, radius: p.radius }));
        const result = planScatter(grid, {
          palette: entries,
          density: args.density,
          seed: args.seed,
          maxSlope: args.max_slope,
          on: args.on ? new Set(args.on.map((s) => s.replace(/^minecraft:/, ''))) : undefined,
          spacing: args.spacing,
          maxCount: args.max_count,
        });
        const floating = supportIssues(grid, result.voxels);
        if (floating.length) {
          return fail(`scatter refused to place ${floating.length} block(s) with nothing under them (first at ${floating[0].x}, ${floating[0].y}, ${floating[0].z}). This is a bug in blockwright; nothing was changed.`);
        }
        if (!result.voxels.length) {
          const why: string[] = [];
          if (result.rejectedWater) why.push(`${result.rejectedWater} water`);
          if (result.rejectedGround) why.push(`${result.rejectedGround} wrong ground block`);
          if (result.rejectedSlope) why.push(`${result.rejectedSlope} too steep`);
          return ok(`scatter: nothing placed. ${result.eligible} eligible column(s) at density ${args.density}${why.length ? `; rejected ${why.join(', ')}` : ''}. Raise density, widen the box, or relax "on"/max_slope.`);
        }
        const set = scatterVoxelSet(result);
        const cap = maxVoxels();
        if (set.size > cap) return fail(voxelCapMessage('scatter', set.size, cap));
        const err = validationError(set, args.allow_unknown_blocks);
        if (err) return fail(err);

        const counts = [...set.counts().entries()].sort((a, c) => c[1] - a[1]);
        const lines = [
          `scatter: ${result.placements} placement(s) over ${result.eligible} eligible column(s) of ${grid.w * grid.h}, ${set.size} block(s) total, seed ${args.seed}.`,
          `Placed: ${counts.map(([k, n]) => `${k.replace('minecraft:', '')} (${n})`).join(', ')}`,
        ];
        if (read.missingChunks) lines.push(`${read.missingChunks} chunk(s) in this box are not generated and were skipped.`);
        if (result.rejectedWater || result.rejectedGround || result.rejectedSlope) {
          lines.push(`Skipped columns: ${result.rejectedWater} water, ${result.rejectedGround} wrong ground block, ${result.rejectedSlope} too steep.`);
        }
        const apply = await ctx.bridge.apply(set, applyOptionsFrom(args, ctx));
        lines.push('', formatApplyResult(apply, 'scatter'));
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`scatter failed: ${errorMessage(e)}`);
      }
    },
  );
}
