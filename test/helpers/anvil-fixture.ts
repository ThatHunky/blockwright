import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { T, writeNbtRaw, bigIntToLongPair, type CompoundValue } from '../../src/nbt/nbt.js';
import { packLongs } from '../../src/world/anvil.js';

export interface FixtureChunk {
  cx: number;
  cz: number;
  /** y → {x,z} → block state text ("minecraft:stone" or with [props]) — everything else is air. */
  blocks: Array<{ x: number; y: number; z: number; state: string }>;
  blockEntities?: CompoundValue[];
}

function paletteEntry(text: string): CompoundValue {
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(text)!;
  const entry: CompoundValue = { Name: T.string(m[1]) };
  if (m[2]) {
    const props: CompoundValue = {};
    for (const pair of m[2].split(',')) {
      const [k, v] = pair.split('=');
      props[k] = T.string(v);
    }
    entry.Properties = T.comp(props);
  }
  return entry;
}

/** Build chunk NBT the way the game does: 24 sections (−4..19), palette+packed data, MOTION_BLOCKING heightmap. */
export function buildChunk(c: FixtureChunk): Buffer {
  const sections: CompoundValue[] = [];
  const heights = new Array<number>(256).fill(0); // value 0 = no blocks
  for (let sy = -4; sy <= 19; sy++) {
    const inSection = c.blocks.filter((b) => b.y >> 4 === sy);
    const palette = ['minecraft:air'];
    const indices = new Array<number>(4096).fill(0);
    for (const b of inSection) {
      let idx = palette.indexOf(b.state);
      if (idx < 0) {
        idx = palette.length;
        palette.push(b.state);
      }
      indices[((b.y & 15) << 8) | ((b.z & 15) << 4) | (b.x & 15)] = idx;
      const col = ((b.z & 15) << 4) | (b.x & 15);
      heights[col] = Math.max(heights[col], b.y - -64 + 1);
    }
    const blockStates: CompoundValue = { palette: T.list(T.comp(palette.map(paletteEntry))) };
    if (palette.length > 1) {
      const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
      blockStates.data = T.longArray(packLongs(indices, bits).map(bigIntToLongPair));
    }
    sections.push({ Y: T.byte(sy), block_states: T.comp(blockStates) });
  }
  const root = T.comp(
    {
      DataVersion: T.int(4903),
      xPos: T.int(c.cx),
      zPos: T.int(c.cz),
      yPos: T.int(-4),
      Status: T.string('minecraft:full'),
      sections: T.list(T.comp(sections)),
      Heightmaps: T.comp({ MOTION_BLOCKING: T.longArray(packLongs(heights, 9).map(bigIntToLongPair)) }),
      block_entities: T.list(T.comp(c.blockEntities ?? [])),
    },
    '',
  );
  return writeNbtRaw(root);
}

/** Write r.<rx>.<rz>.mca files containing the given chunks into regionDir. */
export async function writeRegionFiles(regionDir: string, chunks: FixtureChunk[]): Promise<void> {
  await fs.mkdir(regionDir, { recursive: true });
  const byRegion = new Map<string, FixtureChunk[]>();
  for (const c of chunks) {
    const k = `${c.cx >> 5}.${c.cz >> 5}`;
    byRegion.set(k, [...(byRegion.get(k) ?? []), c]);
  }
  for (const [k, list] of byRegion) {
    const header = Buffer.alloc(8192);
    const parts: Buffer[] = [header];
    let sector = 2;
    for (const c of list) {
      const compressed = deflateSync(buildChunk(c));
      const body = Buffer.alloc(5 + compressed.length);
      body.writeInt32BE(compressed.length + 1, 0);
      body[4] = 2;
      compressed.copy(body, 5);
      const sectors = Math.ceil(body.length / 4096);
      const padded = Buffer.alloc(sectors * 4096);
      body.copy(padded);
      const idx = 4 * ((c.cx & 31) + (c.cz & 31) * 32);
      header.writeUIntBE(sector, idx, 3);
      header[idx + 3] = sectors;
      parts.push(padded);
      sector += sectors;
    }
    await fs.writeFile(path.join(regionDir, `r.${k}.mca`), Buffer.concat(parts));
  }
}
