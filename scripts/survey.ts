/**
 * Dev utility: run walk / profile / slope against a real world's region files without MCP.
 *   npx tsx scripts/survey.ts <regionDir> walk '<path json>' [max_step] [headroom]
 *   npx tsx scripts/survey.ts <regionDir> profile '<path json>' [width]
 *   npx tsx scripts/survey.ts <regionDir> slope x0 z0 x1 z1 [sample]
 * Read-only: it only ever opens the region files.
 */
import { readVoxels, readHeightmap } from '../src/world/anvil.js';
import { ChunkCache, type WorldReader } from '../src/terrain/sampler.js';
import { pathCells, pointsFromTuples } from '../src/terrain/path.js';
import { analyzeWalk, formatWalk } from '../src/terrain/walk.js';
import { analyzeProfile, formatProfile } from '../src/terrain/profile.js';
import { buildSlopeGrid, formatSlope } from '../src/terrain/slope.js';

const [dir, tool, ...rest] = process.argv.slice(2);
if (!dir || !tool) {
  console.error('usage: survey.ts <regionDir> walk|profile|slope ...');
  process.exit(2);
}
const reader: WorldReader = {
  read: (b) => readVoxels(dir, b),
  heightmap: (minX, minZ, maxX, maxZ) => readHeightmap(dir, minX, minZ, maxX, maxZ),
};
const cache = new ChunkCache(reader);
const started = Date.now();
if (tool === 'walk') {
  const points = pointsFromTuples(JSON.parse(rest[0]));
  const opts = { maxStep: rest[1] ? +rest[1] : 0.6, headroom: rest[2] ? +rest[2] : 2 };
  const cells = pathCells(points);
  console.log(formatWalk(await analyzeWalk(cache, cells, opts), opts, `walk: ${cells.length} cells`));
} else if (tool === 'profile') {
  const points = pointsFromTuples(JSON.parse(rest[0])).map((p) => ({ x: p.x, z: p.z }));
  const width = rest[1] ? +rest[1] : 0;
  const cells = pathCells(points);
  console.log(formatProfile(await analyzeProfile(cache, cells, points, width), width, `profile: ${cells.length} cells`));
} else if (tool === 'slope') {
  const [x0, z0, x1, z1, sample] = rest.map(Number);
  const g = await buildSlopeGrid(cache, Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1));
  console.log(formatSlope(g, sample || Math.max(1, Math.ceil(Math.max(g.w, g.h) / 96)), `slope ${g.w}×${g.h}`));
}
console.error(`${cache.reads} reads, ${Date.now() - started} ms, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
