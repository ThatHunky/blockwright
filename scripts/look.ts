/**
 * Dev utility: render a box of a real world to PNG files without going through MCP.
 *   npx tsx scripts/look.ts <regionDir> <x0> <y0> <z0> <x1> <y1> <z1> <outPrefix> <view...>
 */
import { writeFileSync } from 'node:fs';
import { readVoxels } from '../src/world/anvil.js';
import { renderScene, type View } from '../src/render/scene.js';
import { encodePng } from '../src/render/png.js';

const [dir, x0, y0, z0, x1, y1, z1, out, ...views] = process.argv.slice(2);
if (!dir || views.length === 0) {
  console.error('usage: look.ts <regionDir> x0 y0 z0 x1 y1 z1 outPrefix view...');
  process.exit(2);
}
const box = { min: [+x0, +y0, +z0] as [number, number, number], max: [+x1, +y1, +z1] as [number, number, number] };
const { voxels, missingChunks } = await readVoxels(dir, box);
console.log(`voxels ${voxels.size}, missing chunks ${missingChunks}`);
for (const v of views) {
  const scene = renderScene(voxels, { view: v as View, maxPixels: +(process.env.MAXPX ?? 1100) });
  writeFileSync(`${out}-${v}.png`, encodePng(scene.width, scene.height, scene.pixels));
  console.log(`${v}: ${scene.width}x${scene.height}, ${scene.blocks} blocks, ${scene.scale}px/block`);
}
