import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { T, compound } from '../../src/nbt/nbt.js';
import { readChunk, chunkBlock, chunkSurface, readVoxels, readHeightmap, packLongs, unpackLongs } from '../../src/world/anvil.js';
import { writeRegionFiles } from '../helpers/anvil-fixture.js';

let regionDir: string;
beforeAll(async () => {
  regionDir = path.join(await mkdtemp(path.join(tmpdir(), 'bw-')), 'region');
  const blocks = [] as Array<{ x: number; y: number; z: number; state: string }>;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y <= 62; y++) blocks.push({ x, y, z, state: 'minecraft:stone' });
  blocks.push({ x: 5, y: 63, z: 7, state: 'minecraft:grass_block[snowy=false]' });
  blocks.push({ x: 5, y: 64, z: 7, state: 'minecraft:oak_sign[rotation=8]' });
  await writeRegionFiles(regionDir, [
    { cx: 0, cz: 0, blocks, blockEntities: [{ id: T.string('minecraft:sign'), x: T.int(5), y: T.int(64), z: T.int(7), keepPacked: T.byte(0), front_text: T.comp({}) }] },
    { cx: -10, cz: 11, blocks: [{ x: 3, y: 10, z: 3, state: 'minecraft:dirt' }] },
  ]);
});

describe('packing', () => {
  it('packs and unpacks without straddling longs', () => {
    const values = Array.from({ length: 4096 }, (_, i) => i % 17);
    const packed = packLongs(values, 5);
    expect(packed.length).toBe(Math.ceil(4096 / 12));
    expect(unpackLongs(packed.map((v) => [Number(v >> 32n), Number(v & 0xffffffffn)]), 5, 4096)).toEqual(values);
  });

  it('unpacks correctly when a packed long has its top bit set', () => {
    // At 5 bits/value the top bit (63) of a long is never used (12*5=60), so that test above
    // can't catch a sign-extension bug in longPairToBigInt. Use 32-bit values instead so the
    // second value of each long lands exactly on bits 32-63, and give it a value whose own top
    // bit is set so bit 63 of the packed long is 1 - i.e. the long is negative when read signed.
    const values = [0xffffffff, 0x80000001, 0x00000000, 0xdeadbeef];
    const packed = packLongs(values, 32);
    expect(packed).toHaveLength(2);
    expect(packed[0] < 0n).toBe(false); // packLongs itself always produces non-negative bigints
    expect(packed[0] & (1n << 63n)).not.toBe(0n); // but the bit pattern's top bit is set
    const pairs = packed.map((v) => [Number(v >> 32n), Number(v & 0xffffffffn)] as [number, number]);
    expect(unpackLongs(pairs, 32, values.length)).toEqual(values);
  });
});

describe('readChunk', () => {
  it('decodes blocks, heightmap and block entities', async () => {
    const chunk = (await readChunk(regionDir, 0, 0))!;
    expect(chunk.minY).toBe(-64);
    expect(chunkBlock(chunk, 5, 63, 7).toString()).toBe('minecraft:grass_block[snowy=false]');
    expect(chunkBlock(chunk, 0, 48, 0).toCommand()).toBe('stone');
    expect(chunkBlock(chunk, 0, 63, 0).isAir).toBe(true);
    expect(chunkBlock(chunk, 0, 300, 0).isAir).toBe(true);
    expect(chunkSurface(chunk, 5, 7)).toBe(64);
    expect(chunkSurface(chunk, 0, 0)).toBe(62);
    // A nested compound tag loses its (always-empty) `name` field across a real write/parse
    // round-trip, so compare its contents via the `compound()` helper rather than a raw toEqual
    // against a `T.comp()` literal — the same workaround test/schematic/structure.test.ts uses.
    expect(chunk.blockEntities).toHaveLength(1);
    const be = chunk.blockEntities[0];
    expect(be.pos).toEqual([5, 64, 7]);
    expect(be.id).toBe('minecraft:sign');
    expect(compound(be.data, 'front_text')).toEqual({});
  });
  it('returns undefined for a missing chunk and reads negative coordinates', async () => {
    expect(await readChunk(regionDir, 3, 3)).toBeUndefined();
    const far = (await readChunk(regionDir, -10, 11))!;
    expect(chunkBlock(far, -160 + 3, 10, 176 + 3).toCommand()).toBe('dirt');
    expect(chunkSurface(far, -160 + 3, 176 + 3)).toBe(10);
    expect(chunkSurface(far, -160, 176)).toBe(-65);
  });
});

describe('readVoxels / readHeightmap', () => {
  it('reads a box across chunks and counts missing chunks', async () => {
    const r = await readVoxels(regionDir, { min: [4, 62, 6], max: [17, 64, 8] });
    expect(r.voxels.get(5, 63, 7)?.toCommand()).toBe('grass_block[snowy=false]');
    expect(r.voxels.get(4, 62, 6)?.toCommand()).toBe('stone');
    expect(r.voxels.get(17, 62, 6)).toBeUndefined();
    expect(r.missingChunks).toBe(1);
    expect(r.blockEntities).toHaveLength(1);
    const h = await readHeightmap(regionDir, 4, 6, 6, 8);
    expect(h.heights[1][1]).toBe(64);
    expect(h.heights[0][0]).toBe(62);
  });
});
