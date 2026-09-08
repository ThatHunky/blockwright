import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { Vec3Schema, RotationSchema, MirrorSchema } from '../voxel/schemas.js';
import { buildSpecShape, BuildSpecSchema, buildSpecToVoxels, buildSpecToRelativeVoxels } from '../voxel/spec.js';
import { shapeShape, ShapeSpecSchema, shapeToVoxels } from '../voxel/shapes.js';
import { stepsFromDegrees } from '../voxel/rotate.js';
import { clipboardFromVoxels, clipboardVoxelsAt } from '../schematic/clipboard.js';
import { loadClipboard, saveClipboard, resolveSchematicPath } from '../schematic/index.js';
import { ok, json, fail, errorMessage, formatApplyResult } from './result.js';
import { writeOptionsShape, applyOptionsFrom, validationError, type WriteArgs } from './common.js';
import type { ApplyOptions } from '../bridge/types.js';

async function applySet(ctx: AppContext, set: VoxelSet, args: WriteArgs, what: string, extra: Partial<ApplyOptions> = {}) {
  const err = validationError(set, args.allow_unknown_blocks);
  if (err) return fail(err);
  const result = await ctx.bridge.apply(set, { ...applyOptionsFrom(args, ctx), ...extra });
  return ok(formatApplyResult(result, what));
}

export function registerBuildTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'build',
    {
      title: 'Build from ASCII layers',
      description:
        'Place a structure described as layers of characters. palette maps one character to a block state; rows run north→south (z), characters west→east (x); y is height above origin. Space leaves the world alone. Extra single blocks go in "blocks". Rotation keeps the min corner at origin. Run with dry_run=true first, and preview before that.',
      inputSchema: { ...buildSpecShape, ...writeOptionsShape },
    },
    async (args) => {
      try {
        const set = buildSpecToVoxels(BuildSpecSchema.parse(args));
        return await applySet(ctx, set, args, 'build');
      } catch (e) {
        return fail(`build failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'place_shape',
    {
      title: 'Place a geometric shape',
      description: 'Sphere, dome, cylinder, cone, pyramid, line or circle, filled or hollow. Radius r gives a diameter of 2r+1.',
      inputSchema: { ...shapeShape, ...writeOptionsShape },
    },
    async (args) => {
      try {
        const set = shapeToVoxels(ShapeSpecSchema.parse(args));
        return await applySet(ctx, set, args, `place_shape ${args.shape}`);
      } catch (e) {
        return fail(`place_shape failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'paste_schematic',
    {
      title: 'Paste a schematic file',
      description:
        'Paste a Sponge .schem or vanilla structure .nbt. By default origin is where the schematic\'s min corner lands; use_offset=true adds the file\'s stored offset like WorldEdit //paste. ignore_air skips air so the surroundings survive.',
      inputSchema: {
        path: z.string().describe('File name in the schematic dir (extension optional) or an absolute path'),
        origin: Vec3Schema,
        rotation: RotationSchema.default(0),
        mirror: MirrorSchema.default('none'),
        use_offset: z.boolean().default(false),
        ignore_air: z.boolean().default(false),
        ...writeOptionsShape,
      },
    },
    async (args) => {
      try {
        const file = resolveSchematicPath(args.path, ctx.config.schematicDir);
        const clip = await loadClipboard(file);
        const { voxels, blockEntities } = clipboardVoxelsAt(clip, args.origin, {
          useOffset: args.use_offset,
          rotation: stepsFromDegrees(args.rotation),
          mirror: args.mirror,
          ignoreAir: args.ignore_air,
        });
        return await applySet(ctx, voxels, args, `paste ${args.path}`, { blockEntities });
      } catch (e) {
        return fail(`paste_schematic failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'schematic_info',
    {
      title: 'Inspect a schematic file',
      description: 'Format, size, offset, DataVersion, block counts and block-entity count of a .schem/.nbt file.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      try {
        const file = resolveSchematicPath(p, ctx.config.schematicDir);
        const clip = await loadClipboard(file);
        const palette: Record<string, number> = {};
        for (const [k, n] of [...clip.voxels.counts().entries()].sort((a, b) => b[1] - a[1])) palette[k] = n;
        return json({
          file,
          format: clip.source,
          size: clip.size,
          offset: clip.offset,
          dataVersion: clip.dataVersion,
          blocks: clip.voxels.size,
          nonAir: clip.voxels.nonAirCount(),
          blockEntities: clip.blockEntities.length,
          palette,
        });
      } catch (e) {
        return fail(`schematic_info failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'schematic_write',
    {
      title: 'Write a schematic file',
      description: 'Save a build spec or a shape as a .schem (Sponge v3) or .nbt (vanilla structure) file without touching any server. Relative paths go to the schematic dir.',
      inputSchema: {
        path: z.string(),
        format: z.enum(['sponge', 'structure']).optional().describe('Defaults from the extension: .nbt → structure, anything else → sponge'),
        build: z.object({ ...buildSpecShape, origin: Vec3Schema.default([0, 0, 0]) }).optional(),
        shape: z.object(shapeShape).optional(),
      },
    },
    async (args) => {
      try {
        if (!args.build && !args.shape) return fail('schematic_write needs either "build" or "shape"');
        const set = args.build ? buildSpecToRelativeVoxels(BuildSpecSchema.parse(args.build)) : shapeToVoxels(ShapeSpecSchema.parse(args.shape));
        const clip = clipboardFromVoxels(set, ctx.config.dataVersion);
        const file = resolveSchematicPath(args.path, ctx.config.schematicDir, true);
        const saved = await saveClipboard(clip, file, args.format);
        return ok(`Wrote ${saved.format} schematic ${saved.path}: size ${clip.size.join('x')}, ${clip.voxels.size} blocks (${clip.voxels.nonAirCount()} non-air).`);
      } catch (e) {
        return fail(`schematic_write failed: ${errorMessage(e)}`);
      }
    },
  );
}

export type { Vec3 };
