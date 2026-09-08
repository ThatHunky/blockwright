import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { VoxelSet, box, boxExpand, boxVolume, type Box } from '../voxel/voxels.js';
import { Vec3Schema, Vec2Schema, RotationSchema, MirrorSchema, WorldSchema } from '../voxel/schemas.js';
import { buildSpecShape, BuildSpecSchema, buildSpecToVoxels } from '../voxel/spec.js';
import { shapeShape, ShapeSpecSchema, shapeToVoxels, DEFAULT_MAX_VOXELS } from '../voxel/shapes.js';
import { stepsFromDegrees } from '../voxel/rotate.js';
import { clipboardFromVoxels, clipboardVoxelsAt } from '../schematic/clipboard.js';
import { loadClipboard, saveClipboard, resolveSchematicPath } from '../schematic/index.js';
import { resolveWorld } from '../world/dimension.js';
import { validateSet } from '../blocks/registry.js';
import { renderAscii } from '../preview/ascii.js';
import { renderHtml } from '../preview/html.js';
import { ok, json, fail, errorMessage } from './result.js';

const KEEP_PREVIEWS = 30;

/**
 * Reads must be bounded before the bridge ever touches disk: unlike the generation-side voxel
 * cap (shapes.ts), which only limits how many voxels get *built*, a world read has no cheap way
 * to know how big the result will be without first scanning every chunk in the requested box.
 * So the cap here has to be applied to the requested box/rectangle itself, before calling the
 * bridge at all.
 *
 * We reuse the same knob generation uses (BLOCKWRIGHT_MAX_VOXELS) rather than inventing a
 * second environment variable — an operator who raises the ceiling for building bigger shapes
 * likely wants reads to scale too. But the two caps are not the same number:
 *  - read_region reads and holds the *entire* volume in memory at once (unlike generation,
 *    which streams into a VoxelSet incrementally and can bail out mid-way), and each voxel can
 *    carry along block-entity NBT data that a plain generated voxel never has. So its cap is a
 *    fraction of the generation cap: 20%, i.e. 1,000,000 blocks by default.
 *  - get_heightmap only samples one y and one surface block id per column, with no block-entity
 *    data and no full-volume scan, so it can safely use the full generation-level budget as its
 *    column-count cap: 5,000,000 columns by default (a ~2236x2236 rectangle).
 */
export const MAX_VOXELS_ENV_VAR = 'BLOCKWRIGHT_MAX_VOXELS';
const READ_VOLUME_FRACTION = 0.2;

function resolvedMaxVoxels(): number {
  const raw = process.env[MAX_VOXELS_ENV_VAR];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_VOXELS;
}

export function maxReadVolume(): number {
  return Math.max(1, Math.floor(resolvedMaxVoxels() * READ_VOLUME_FRACTION));
}

export function maxHeightmapArea(): number {
  return resolvedMaxVoxels();
}

export const DEFAULT_MAX_READ_VOLUME = Math.floor(DEFAULT_MAX_VOXELS * READ_VOLUME_FRACTION);
export const DEFAULT_MAX_HEIGHTMAP_AREA = DEFAULT_MAX_VOXELS;

async function writePreview(ctx: AppContext, html: string): Promise<string> {
  await fs.mkdir(ctx.config.previewDir, { recursive: true });
  const file = path.join(ctx.config.previewDir, `preview-${Date.now().toString(36)}.html`);
  await fs.writeFile(file, html);
  await prunePreviews(ctx);
  return file;
}

/** Prune old previews by an explicit, reliable ordering key (file modification time) rather
 * than sorting filenames as strings, which breaks if the naming scheme ever changes shape. */
async function prunePreviews(ctx: AppContext): Promise<void> {
  const dir = ctx.config.previewDir;
  const names = (await fs.readdir(dir)).filter((f) => f.startsWith('preview-') && f.endsWith('.html'));
  const withMtime = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      const mtimeMs = (await fs.stat(full)).mtimeMs;
      return { full, mtimeMs };
    }),
  );
  withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = withMtime.slice(0, Math.max(0, withMtime.length - KEEP_PREVIEWS));
  for (const { full } of excess) await fs.rm(full, { force: true });
}

function clampY(b: Box): Box {
  return { min: [b.min[0], Math.max(b.min[1], -64), b.min[2]], max: [b.max[0], Math.min(b.max[1], 319), b.max[2]] };
}

export function registerReadTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'preview',
    {
      title: 'Preview a build before placing it',
      description:
        'Render a build spec, a shape, or a schematic as ASCII layer slices (returned) and as a self-contained 3D HTML viewer (path returned; send that file to the user). Set context>0 to include the surrounding world blocks so the design is shown in place. Nothing is changed in the world.',
      inputSchema: {
        build: z.object(buildSpecShape).optional(),
        shape: z.object(shapeShape).optional(),
        schematic: z
          .object({ path: z.string(), origin: Vec3Schema, rotation: RotationSchema.default(0), mirror: MirrorSchema.default('none'), use_offset: z.boolean().default(false), ignore_air: z.boolean().default(false) })
          .optional(),
        context: z.number().int().min(0).max(32).default(0).describe('Blocks of surrounding world to include around the build box (needs world read access)'),
        world: WorldSchema.optional(),
        max_layers: z.number().int().min(1).max(64).default(12),
        title: z.string().optional(),
      },
    },
    async (args) => {
      const given = [args.build, args.shape, args.schematic].filter(Boolean).length;
      if (given !== 1) return fail('preview needs exactly one of "build", "shape" or "schematic"');

      // Everything needed to produce the ASCII output — the primary, model-facing result — is
      // built here. A failure at any of these steps is a genuine failure: there is nothing
      // useful to hand back.
      let set: VoxelSet;
      let title = args.title ?? 'Blockwright preview';
      let context: VoxelSet | undefined;
      let ascii: string;
      const lines: string[] = [];
      try {
        if (args.build) set = buildSpecToVoxels(BuildSpecSchema.parse(args.build));
        else if (args.shape) set = shapeToVoxels(ShapeSpecSchema.parse(args.shape));
        else {
          const s = args.schematic!;
          const clip = await loadClipboard(resolveSchematicPath(s.path, ctx.config.schematicDir));
          set = clipboardVoxelsAt(clip, s.origin, { useOffset: s.use_offset, rotation: stepsFromDegrees(s.rotation), mirror: s.mirror, ignoreAir: s.ignore_air }).voxels;
          if (!args.title) title = `Preview of ${s.path}`;
        }
        const issues = validateSet(set);
        if (issues.length) lines.push('Invalid block states (the server would reject these):', ...issues.map((i) => `  ${i.block}: ${i.message}`), '');
        if (args.context > 0) {
          if (ctx.bridge.canRead()) {
            const world = resolveWorld(args.world, ctx.config.levelName);
            const around = clampY(boxExpand(set.bounds()!, args.context));
            context = (await ctx.bridge.read(around, world)).voxels;
          } else lines.push('(context requested but world reads are unavailable; showing the build alone)', '');
        }
        ascii = renderAscii(set, { maxLayers: args.max_layers }).text;
      } catch (e) {
        return fail(`preview failed: ${errorMessage(e)}`);
      }
      lines.push(ascii);

      // The HTML file is a secondary, best-effort artifact. If rendering or writing (or
      // pruning old previews) it fails, the model still needs the ASCII layers above to check
      // its own work — so report the HTML failure as a note, not as a tool error that would
      // throw away everything already produced.
      try {
        const file = await writePreview(ctx, renderHtml(set, { title, context }));
        lines.push('', `HTML preview written to ${file} — send this file to the user (it opens offline; drag to pan, wheel to zoom, slider to peel layers).`);
      } catch (e) {
        lines.push('', `HTML preview could not be written: ${errorMessage(e)}. The ASCII layers above are still accurate; only the 3D viewer file is unavailable.`);
      }
      return ok(lines.join('\n'));
    },
  );

  server.registerTool(
    'read_region',
    {
      title: 'Read blocks from the world',
      description: 'Block counts for a box, plus ASCII layer slices when the box is small (≤4096 blocks) or full=true. Use after building to verify the result.',
      inputSchema: { from: Vec3Schema, to: Vec3Schema, world: WorldSchema.optional(), full: z.boolean().default(false), max_layers: z.number().int().min(1).max(64).default(12) },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const volume = boxVolume(b);
        const cap = maxReadVolume();
        if (volume > cap) {
          return fail(
            `read_region requested ${volume.toLocaleString()} blocks — box (${b.min.join(', ')}) to (${b.max.join(', ')}) — which exceeds the ${cap.toLocaleString()} block read limit. ` +
              `Reduce the box size, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`,
          );
        }
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read(b, world);
        const lines: string[] = [];
        if (r.missingChunks) lines.push(`${r.missingChunks} chunk(s) in this box are not generated yet; their blocks are omitted.`);
        if (r.blockEntities.length) lines.push(`Block entities: ${r.blockEntities.slice(0, 20).map((be) => `${be.id.replace('minecraft:', '')}@(${be.pos.join(',')})`).join(', ')}${r.blockEntities.length > 20 ? ' …' : ''}`);
        if (args.full || boxVolume(b) <= 4096) lines.push(renderAscii(r.voxels, { maxLayers: args.max_layers }).text);
        else {
          const counts = [...r.voxels.counts().entries()].sort((x, y) => y[1] - x[1]);
          lines.push(`Box (${b.min.join(', ')}) to (${b.max.join(', ')}), ${boxVolume(b)} blocks. Counts: ${counts.map(([k, n]) => `${k.replace('minecraft:', '')} (${n})`).join(', ')}`);
          lines.push('Pass full=true for layer slices of a box this large.');
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`read_region failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'get_block',
    { title: 'Read one block', description: 'The block state at a position.', inputSchema: { pos: Vec3Schema, world: WorldSchema.optional() } },
    async (args) => {
      try {
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read({ min: args.pos, max: args.pos }, world);
        const s = r.voxels.get(args.pos[0], args.pos[1], args.pos[2]);
        if (!s) return fail(`chunk at ${args.pos.join(', ')} is not generated`);
        const be = r.blockEntities[0];
        return ok(s.toString() + (be ? ` (block entity ${be.id})` : ''));
      } catch (e) {
        return fail(`get_block failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'get_heightmap',
    {
      title: 'Surface heightmap',
      description: 'Surface y and surface block for an x/z rectangle, as a sampled grid (rows = z north→south, columns = x west→east). The site-scouting tool: find flat ground and the y to build at (surface y + 1).',
      inputSchema: {
        from: Vec2Schema.describe('[x, z]'),
        to: Vec2Schema.describe('[x, z]'),
        world: WorldSchema.optional(),
        sample: z.number().int().min(1).optional().describe('Print every Nth column/row; default keeps the grid within 48×48'),
      },
    },
    async (args) => {
      try {
        const world = resolveWorld(args.world, ctx.config.levelName);
        const minX = Math.min(args.from[0], args.to[0]);
        const maxX = Math.max(args.from[0], args.to[0]);
        const minZ = Math.min(args.from[1], args.to[1]);
        const maxZ = Math.max(args.from[1], args.to[1]);
        const area = (maxX - minX + 1) * (maxZ - minZ + 1);
        const cap = maxHeightmapArea();
        if (area > cap) {
          return fail(
            `get_heightmap requested ${area.toLocaleString()} columns — x ${minX}..${maxX}, z ${minZ}..${maxZ} — which exceeds the ${cap.toLocaleString()} column limit. ` +
              `Reduce the rectangle, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`,
          );
        }
        const r = await ctx.bridge.heightmap(minX, minZ, maxX, maxZ, world);
        const step = args.sample ?? Math.max(1, Math.ceil(Math.max(maxX - minX + 1, maxZ - minZ + 1) / 48));
        const all = r.heights.flat().filter((h): h is number => h !== null);
        if (!all.length) return fail('no generated chunks in that rectangle');
        const lo = Math.min(...all);
        const hi = Math.max(...all);
        const mean = all.reduce((a, b) => a + b, 0) / all.length;
        const hist = new Map<string, number>();
        for (const row of r.surface) for (const s of row) if (s) hist.set(s, (hist.get(s) ?? 0) + 1);
        const lines = [
          `Heightmap x ${minX}..${maxX}, z ${minZ}..${maxZ} (${world.label}): surface y from ${lo} to ${hi}, mean ${mean.toFixed(1)}. Build on top at y=${hi + 1} for level ground, or terraform first.`,
          `Surface blocks: ${[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join(', ')}`,
        ];
        if (r.missingChunks) lines.push(`${r.missingChunks} chunk(s) not generated (shown as --).`);
        lines.push(`Grid every ${step} block(s); rows z=${minZ}.. downwards, columns x=${minX}.. rightwards:`);
        for (let zi = 0; zi < r.heights.length; zi += step) {
          const row: string[] = [];
          for (let xi = 0; xi < r.heights[zi].length; xi += step) {
            const h = r.heights[zi][xi];
            row.push(h === null ? '--' : String(h));
          }
          lines.push(`  z=${String(minZ + zi).padStart(6)} | ${row.join(' ')}`);
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(`get_heightmap failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'save_schematic',
    {
      title: 'Save a world region to a schematic file',
      description: 'Copy a box from the world into a .schem (Sponge v3) or .nbt (structure) file, block entities included.',
      inputSchema: { from: Vec3Schema, to: Vec3Schema, path: z.string(), format: z.enum(['sponge', 'structure']).optional(), world: WorldSchema.optional() },
    },
    async (args) => {
      try {
        const b = box(args.from, args.to);
        const world = resolveWorld(args.world, ctx.config.levelName);
        const r = await ctx.bridge.read(b, world);
        const clip = clipboardFromVoxels(r.voxels, ctx.config.dataVersion, r.blockEntities);
        const saved = await saveClipboard(clip, resolveSchematicPath(args.path, ctx.config.schematicDir, true), args.format);
        return ok(`Saved ${saved.format} schematic ${saved.path}: size ${clip.size.join('x')}, ${clip.voxels.nonAirCount()} non-air blocks, ${clip.blockEntities.length} block entities.`);
      } catch (e) {
        return fail(`save_schematic failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'list_snapshots',
    { title: 'List snapshots', description: 'Snapshots taken before writes, newest first, with ids for undo.', inputSchema: {} },
    async () => {
      try {
        return json(await ctx.bridge.listSnapshots());
      } catch (e) {
        return fail(`list_snapshots failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo recent writes',
      description: 'Restore the newest snapshot(s) taken before writes (or a specific id from list_snapshots). Each restored snapshot is removed from the list.',
      inputSchema: { steps: z.number().int().min(1).max(20).default(1), id: z.string().optional() },
    },
    async (args) => {
      let targets: string[];
      try {
        targets = args.id ? [args.id] : (await ctx.bridge.listSnapshots()).slice(0, args.steps).map((s) => s.id);
      } catch (e) {
        return fail(`undo failed: ${errorMessage(e)}`);
      }
      if (!targets.length) return fail('No snapshots available to undo.');

      // Each restore is independent: if a later one throws after an earlier one already
      // succeeded (and was removed from the snapshot index by the bridge), that success is
      // real and must still be reported — a single try/catch around the whole loop would
      // discard it and misrepresent the world as unchanged.
      const restored: string[] = [];
      const failed: string[] = [];
      for (const id of targets) {
        try {
          const { record } = await ctx.bridge.restore(id);
          const gap = record.missingChunks ? ` (${record.missingChunks} chunk column(s) were not generated at capture time and are not restored)` : '';
          restored.push(`  ${record.id}${record.label ? ` "${record.label}"` : ''}: (${record.box.min.join(', ')}) to (${record.box.max.join(', ')}) in ${record.world}, taken ${record.createdAt}${gap}`);
        } catch (e) {
          failed.push(`  ${id}: ${errorMessage(e)}`);
        }
      }

      const lines: string[] = [];
      if (restored.length) lines.push(`Restored ${restored.length} snapshot(s):`, ...restored);
      if (failed.length) lines.push(`Failed to restore ${failed.length} snapshot(s):`, ...failed);
      const text = lines.join('\n');
      // Only report a total error when nothing at all was restored; a partial success is not
      // an error the model should retry blindly, it's a mixed outcome it needs to read.
      return restored.length ? ok(text) : fail(text);
    },
  );
}
