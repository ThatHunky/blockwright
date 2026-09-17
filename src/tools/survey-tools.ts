import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server.js';
import { Vec2Schema, Vec3Schema, WorldSchema } from '../voxel/schemas.js';
import { resolveWorld, type WorldRef } from '../world/dimension.js';
import { ChunkCache, type WorldReader } from '../terrain/sampler.js';
import { pathCells, pointsFromTuples, type PathPoint } from '../terrain/path.js';
import { analyzeWalk, formatWalk } from '../terrain/walk.js';
import { analyzeProfile, formatProfile } from '../terrain/profile.js';
import { buildSlopeGrid, formatSlope } from '../terrain/slope.js';
import { ok, fail, errorMessage } from './result.js';
import { maxHeightmapArea, MAX_VOXELS_ENV_VAR } from './read-tools.js';

/** A path is read a chunk at a time, so its length is bounded by output size, not memory. */
const MAX_PATH_CELLS = 4096;
/** Profile cross-sections multiply the columns read; keep the total in the same ballpark. */
const MAX_PROFILE_COLUMNS = 65_536;
/** Slope reads real ground (not the heightmap) for every column, so it is capped like terraform. */
const MAX_SLOPE_COLUMNS = 262_144;
/** Printed slope grids stay readable; sample down to roughly this many characters across. */
const SLOPE_CHARS = 96;

const PathSchema = z
  .array(z.union([Vec3Schema, Vec2Schema]))
  .min(1)
  .max(512)
  .describe('Polyline of [x, z] or [x, y, z] points; the cells between consecutive points are filled in as a 4-connected grid line');

function worldReader(ctx: AppContext, world: WorldRef): WorldReader {
  return {
    read: (b) => ctx.bridge.read(b, world),
    heightmap: (minX, minZ, maxX, maxZ) => ctx.bridge.heightmap(minX, minZ, maxX, maxZ, world),
  };
}

function describePoints(points: PathPoint[]): string {
  const a = points[0];
  const b = points[points.length - 1];
  return `(${a.x}, ${a.z}) to (${b.x}, ${b.z}) through ${points.length} point(s)`;
}

export function registerSurveyTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'walk',
    {
      title: 'Walk a path and report where it is not walkable',
      description:
        'Walk a polyline block by block the way a player would and report, as text, the exact standing height of every cell (a slab is +0.5, dirt_path 15/16, a carpet 1/16; flowers, grass and torches are walked through; leaves, fences and walls are obstacles, never floors). ' +
        'Flags every step up taller than max_step (0.6 is the game\'s step height; a stair climbed from its low side counts as two half steps), every drop over 3 blocks, water, missing floor, missing headroom and obstacles, with coordinates. ' +
        'Give [x, y, z] points to follow a specific level — a bridge deck, a tunnel — (y is the height of the path, feet or floor block: the nearest floor within 8 blocks is used, following on from the previous cell), or [x, z] to use the highest walkable surface. Use it on every path, road, stair and bridge before calling it finished: a render cannot show a 1-block lip, this can. Nothing is changed in the world.',
      inputSchema: {
        path: PathSchema,
        world: WorldSchema.optional(),
        max_step: z.number().min(0).max(16).default(0.6).describe('Tallest rise walked without jumping'),
        headroom: z.number().int().min(1).max(8).default(2).describe('Clear blocks needed above the standing height'),
      },
    },
    async (args) => {
      try {
        if (!ctx.bridge.canRead()) return fail('walk needs world read access (a readable region directory); none is configured.');
        const points = pointsFromTuples(args.path);
        const cells = pathCells(points);
        if (cells.length > MAX_PATH_CELLS) {
          return fail(`walk path covers ${cells.length.toLocaleString()} cells, over the ${MAX_PATH_CELLS.toLocaleString()} cell limit. Split it into shorter pieces.`);
        }
        const world = resolveWorld(args.world, ctx.config.levelName);
        const cache = new ChunkCache(worldReader(ctx, world));
        const opts = { maxStep: args.max_step, headroom: args.headroom };
        const report = await analyzeWalk(cache, cells, opts);
        const title = `walk ${world.label}: ${cells.length} cells from ${describePoints(points)}; max_step ${args.max_step}, headroom ${args.headroom}.`;
        return ok(formatWalk(report, opts, title));
      } catch (e) {
        return fail(`walk failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'profile',
    {
      title: 'Elevation profile along a line',
      description:
        'Ground height along a polyline (or a straight from/to line) as a text table — distance, x, z, ground y, surface block, change from the previous cell — with total rise and fall, the steepest change over 1, 3 and 10 cells, where the line runs under trees or over water, and a small ASCII elevation chart. ' +
        'Ground ignores plants, leaves and logs, so a forest does not read as a wall. width > 0 adds a cross-section of ground heights to each side of every cell (left → right looking along the line), for checking that a road is not sunk in a trench or perched on a ridge. Nothing is changed in the world.',
      inputSchema: {
        path: PathSchema.optional(),
        from: Vec2Schema.optional().describe('[x, z] start of a straight line (instead of path)'),
        to: Vec2Schema.optional().describe('[x, z] end of a straight line'),
        width: z.number().int().min(0).max(16).default(0).describe('Cross-section half-width in blocks; 0 for none'),
        world: WorldSchema.optional(),
      },
    },
    async (args) => {
      try {
        if (!ctx.bridge.canRead()) return fail('profile needs world read access (a readable region directory); none is configured.');
        let tuples: ReadonlyArray<ReadonlyArray<number>>;
        if (args.path) {
          if (args.from || args.to) return fail('profile takes either path or from/to, not both.');
          tuples = args.path;
        } else {
          if (!args.from || !args.to) return fail('profile needs a path, or both from and to.');
          tuples = [args.from, args.to];
        }
        // Heights in the given points are not used: the profile is of the ground itself.
        const points = pointsFromTuples(tuples).map((p) => ({ x: p.x, z: p.z }));
        const cells = pathCells(points);
        const columns = cells.length * (2 * args.width + 1);
        if (cells.length > MAX_PATH_CELLS || columns > MAX_PROFILE_COLUMNS) {
          return fail(`profile covers ${cells.length.toLocaleString()} cells (${columns.toLocaleString()} columns with width ${args.width}), over the ${MAX_PATH_CELLS.toLocaleString()} cell / ${MAX_PROFILE_COLUMNS.toLocaleString()} column limit. Shorten the line or narrow the width.`);
        }
        const world = resolveWorld(args.world, ctx.config.levelName);
        const cache = new ChunkCache(worldReader(ctx, world));
        const report = await analyzeProfile(cache, cells, points, args.width);
        const title = `profile ${world.label}: ${cells.length} cells from ${describePoints(points)}${args.width ? `, cross-section ±${args.width}` : ''}.`;
        return ok(formatProfile(report, args.width, title));
      } catch (e) {
        return fail(`profile failed: ${errorMessage(e)}`);
      }
    },
  );

  server.registerTool(
    'slope',
    {
      title: 'Steepness map of an area',
      description:
        'For an x/z box, the real ground (plants, leaves and logs ignored; water measured at its surface) turned into a character grid of each column\'s largest height step to its four neighbours: \'.\' level, \'1\'..\'9\' blocks, \'#\' 10+, \'~\' water. ' +
        'Also lists the cliffs — connected runs of 2+ block steps — with coordinates, length and height, and the share of columns that can be walked without climbing. Use it after terraforming or before laying out paths, to find the lips, terraces and walls a heightmap of raw numbers hides. Nothing is changed in the world.',
      inputSchema: {
        from: Vec2Schema.describe('[x, z]'),
        to: Vec2Schema.describe('[x, z]'),
        world: WorldSchema.optional(),
        sample: z.number().int().min(1).optional().describe(`Characters cover sample×sample columns (showing the steepest); default keeps the grid within ${SLOPE_CHARS} across`),
      },
    },
    async (args) => {
      try {
        if (!ctx.bridge.canRead()) return fail('slope needs world read access (a readable region directory); none is configured.');
        const minX = Math.min(args.from[0], args.to[0]);
        const maxX = Math.max(args.from[0], args.to[0]);
        const minZ = Math.min(args.from[1], args.to[1]);
        const maxZ = Math.max(args.from[1], args.to[1]);
        const area = (maxX - minX + 1) * (maxZ - minZ + 1);
        const cap = Math.min(MAX_SLOPE_COLUMNS, maxHeightmapArea());
        if (area > cap) {
          return fail(
            `slope requested ${area.toLocaleString()} columns — x ${minX}..${maxX}, z ${minZ}..${maxZ} — which exceeds the ${cap.toLocaleString()} column limit. ` +
              `Reduce the rectangle${cap < MAX_SLOPE_COLUMNS ? `, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable` : ''}.`,
          );
        }
        const world = resolveWorld(args.world, ctx.config.levelName);
        const cache = new ChunkCache(worldReader(ctx, world));
        const grid = await buildSlopeGrid(cache, minX, minZ, maxX, maxZ);
        const sample = args.sample ?? Math.max(1, Math.ceil(Math.max(grid.w, grid.h) / SLOPE_CHARS));
        const title = `slope ${world.label}: x ${minX}..${maxX}, z ${minZ}..${maxZ} (${grid.w}×${grid.h}).`;
        return ok(formatSlope(grid, sample, title));
      } catch (e) {
        return fail(`slope failed: ${errorMessage(e)}`);
      }
    },
  );
}
