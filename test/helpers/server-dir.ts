import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRegionFiles, type FixtureChunk } from './anvil-fixture.js';

/** A temp server folder with a 26.x overworld region containing the given chunks. */
export async function fakeServerDir(chunks: FixtureChunk[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bw-srv-'));
  await writeRegionFiles(path.join(dir, 'world', 'dimensions', 'minecraft', 'overworld', 'region'), chunks);
  return dir;
}

/** Chunk 0,0: stone from −64 to 62 everywhere, grass at (5,63,7). */
export function flatChunk(): FixtureChunk {
  const blocks: FixtureChunk['blocks'] = [];
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y <= 62; y++) blocks.push({ x, y, z, state: 'minecraft:stone' });
  blocks.push({ x: 5, y: 63, z: 7, state: 'minecraft:grass_block[snowy=false]' });
  return { cx: 0, cz: 0, blocks };
}
