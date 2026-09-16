import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../server.js';
import { VoxelSet, box, boxVolume, type Box } from '../voxel/voxels.js';
import { Vec3Schema, WorldSchema } from '../voxel/schemas.js';
import { resolveWorld } from '../world/dimension.js';
import { loadClipboard, resolveSchematicPath } from '../schematic/index.js';
import { clipboardVoxelsAt } from '../schematic/clipboard.js';
import { renderScene, VIEWS, type View } from '../render/scene.js';
import { encodePng } from '../render/png.js';
import { maxReadVolume } from './read-tools.js';
import { fail, errorMessage } from './result.js';

const KEEP_RENDERS = 40;
const MAX_VIEWS = 9;
/** Ceiling on a single inlined image. Past roughly this size the picture stops being a cheap
 * glance for the agent and starts crowding out the conversation it is meant to inform. */
const MAX_INLINE_BYTES = 3_000_000;

async function writeRender(ctx: AppContext, name: string, png: Buffer): Promise<string> {
  await fs.mkdir(ctx.config.previewDir, { recursive: true });
  const file = path.join(ctx.config.previewDir, name);
  await fs.writeFile(file, png);
  const names = (await fs.readdir(ctx.config.previewDir)).filter((f) => f.startsWith('render-') && f.endsWith('.png'));
  const stats = await Promise.all(names.map(async (n) => ({ full: path.join(ctx.config.previewDir, n), m: (await fs.stat(path.join(ctx.config.previewDir, n))).mtimeMs })));
  stats.sort((a, b) => a.m - b.m);
  for (const { full } of stats.slice(0, Math.max(0, stats.length - KEEP_RENDERS))) await fs.rm(full, { force: true });
  return file;
}

export function registerRenderTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'render',
    {
      title: 'Look at the world as a picture',
      description:
        'Render a box of the live world (or a saved schematic) as PNG images and return them inline, so the build can actually be looked at. ' +
        'views picks the camera: iso_ne/iso_nw/iso_se/iso_sw are the four isometric corners, top is a map-style plan, and north/south/east/west are straight-on elevations. ' +
        'Blocks are drawn with their real shapes — a fence is a post, a slab is half a cell, a lantern is a lamp — because that is what makes a gappy bridge deck, a railing in the wrong place or a road cut into a trench visible at all. ' +
        'Always look from at least two opposite corners before calling a build finished: a top-down view hides every vertical mistake. Nothing is changed in the world.',
      inputSchema: {
        from: Vec3Schema.optional().describe('Min corner of the box to render'),
        to: Vec3Schema.optional().describe('Max corner of the box to render'),
        schematic: z.string().optional().describe('Render a saved schematic instead of the world'),
        world: WorldSchema.optional(),
        views: z.array(z.enum(VIEWS)).min(1).max(MAX_VIEWS).default(['iso_ne', 'iso_sw', 'iso_nw', 'iso_se']).describe(`Up to ${MAX_VIEWS} cameras (all nine allowed); each returns one image. Default is the four isometric corners — every side of a build gets seen`),
        scale: z.number().int().min(1).max(48).optional().describe('Pixels per block; omit to fit max_pixels'),
        max_pixels: z.number().int().min(64).max(8192).default(2400).describe('Longest side of the image in pixels'),
        hide: z.array(z.string()).optional().describe('Block names drawn as air, e.g. ["oak_leaves","*_leaves"] to see through a forest, or ["water"]'),
        cutaway_y: z.number().int().optional().describe('Ignore everything above this y — lifts the roof off an interior'),
        background: z.string().optional().describe('Background colour as "r,g,b" (default sky blue)'),
        label: z.string().optional().describe('Short label used in the file names'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        let set: VoxelSet;
        let where: string;
        if (args.schematic) {
          const clip = await loadClipboard(resolveSchematicPath(args.schematic, ctx.config.schematicDir));
          set = clipboardVoxelsAt(clip, [0, 0, 0], { useOffset: false }).voxels;
          where = `schematic ${args.schematic}`;
        } else {
          if (!args.from || !args.to) return fail('render needs either from+to (a world box) or schematic.');
          if (!ctx.bridge.canRead()) return fail('render needs world read access (a readable region directory); none is configured.');
          const b: Box = box(args.from, args.to);
          const clamped: Box = { min: [b.min[0], Math.max(b.min[1], -64), b.min[2]], max: [b.max[0], Math.min(b.max[1], 319), b.max[2]] };
          const volume = boxVolume(clamped);
          const cap = maxReadVolume();
          if (volume > cap) {
            return fail(`render box is ${volume} blocks, over the ${cap} limit. Narrow the y range first — a render rarely needs more than the ~20 blocks around the surface.`);
          }
          const world = resolveWorld(args.world, ctx.config.levelName);
          const res = await ctx.bridge.read(clamped, world);
          set = res.voxels;
          where = `${world.label} (${clamped.min.join(', ')}) to (${clamped.max.join(', ')})`;
          if (res.missingChunks > 0) where += `, ${res.missingChunks} ungenerated chunk column(s)`;
        }

        const background = args.background
          ? (args.background.split(',').map((s) => Math.max(0, Math.min(255, Number(s.trim())))) as [number, number, number])
          : undefined;
        if (background && (background.length !== 3 || background.some((n) => !Number.isFinite(n)))) {
          return fail('background must be three numbers, e.g. "150,180,215".');
        }

        const stamp = Date.now().toString(36);
        const tag = (args.label ?? 'view').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 24);
        const content: CallToolResult['content'] = [];
        const lines: string[] = [`Rendered ${where}.`];
        let dropped = 0;
        for (const view of args.views as View[]) {
          const scene = renderScene(set, {
            view,
            scale: args.scale,
            maxPixels: args.max_pixels,
            hide: args.hide,
            cutawayY: args.cutaway_y,
            background,
          });
          const png = encodePng(scene.width, scene.height, scene.pixels);
          const file = await writeRender(ctx, `render-${stamp}-${tag}-${view}.png`, png);
          lines.push(`  ${view}: ${scene.width}x${scene.height}px, ${scene.blocks} visible blocks, ${scene.scale}px per block → ${file}`);
          if (png.length <= MAX_INLINE_BYTES) {
            content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          } else {
            dropped++;
          }
        }
        if (dropped) lines.push(`${dropped} image(s) were too large to inline; read them from the paths above or lower max_pixels.`);
        return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
      } catch (e) {
        return fail(`render failed: ${errorMessage(e)}`);
      }
    },
  );
}
