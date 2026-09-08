import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync, gunzipSync } from 'node:zlib';
import { BlockState, VoxelSet, type Box, type Vec3 } from '../voxel/voxels.js';
import { parseNbt, num, str, compound, listOf, longPairs, longPairToBigInt, omitKeys, type CompoundValue } from '../nbt/nbt.js';
import type { BlockEntity } from '../schematic/clipboard.js';

const AIR = BlockState.parse('air');

export interface Section {
  y: number;
  palette: BlockState[];
  /** 4096 palette indices ordered (y<<8)|(z<<4)|x, or undefined when the section is all palette[0]. */
  indices: Uint16Array | undefined;
}

export interface ChunkData {
  cx: number;
  cz: number;
  minY: number;
  sections: Map<number, Section>;
  heightmaps: Map<string, number[]>;
  blockEntities: BlockEntity[];
  dataVersion: number;
}

/** Unpack Minecraft's non-straddling packed longs. */
export function unpackLongs(longs: [number, number][], bits: number, count: number): number[] {
  const per = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const out: number[] = [];
  for (const pair of longs) {
    const v = longPairToBigInt(pair);
    for (let k = 0; k < per && out.length < count; k++) out.push(Number((v >> BigInt(bits * k)) & mask));
    if (out.length >= count) break;
  }
  while (out.length < count) out.push(0);
  return out;
}

export function packLongs(values: number[], bits: number): bigint[] {
  const per = Math.floor(64 / bits);
  const out: bigint[] = [];
  for (let i = 0; i < values.length; i += per) {
    let v = 0n;
    for (let k = 0; k < per && i + k < values.length; k++) v |= BigInt(values[i + k]) << BigInt(bits * k);
    out.push(v);
  }
  return out;
}

function stateFromPalette(entry: CompoundValue): BlockState {
  const props: Record<string, string> = {};
  const p = compound(entry, 'Properties');
  if (p) for (const [k, v] of Object.entries(p)) props[k] = String(v.value);
  return new BlockState(str(entry, 'Name'), props);
}

export function decodeSection(sec: CompoundValue): Section {
  const y = num(sec, 'Y');
  const bs = compound(sec, 'block_states');
  if (!bs) return { y, palette: [AIR], indices: undefined };
  const palette = (listOf(bs, 'palette') as CompoundValue[]).map(stateFromPalette);
  if (palette.length === 0) return { y, palette: [AIR], indices: undefined };
  const data = longPairs(bs, 'data');
  if (palette.length === 1 || data.length === 0) return { y, palette, indices: undefined };
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  return { y, palette, indices: Uint16Array.from(unpackLongs(data, bits, 4096)) };
}

export async function readChunk(regionDir: string, cx: number, cz: number): Promise<ChunkData | undefined> {
  const file = path.join(regionDir, `r.${cx >> 5}.${cz >> 5}.mca`);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const head = Buffer.alloc(4);
    const idx = 4 * ((cx & 31) + (cz & 31) * 32);
    const r = await handle.read(head, 0, 4, idx);
    if (r.bytesRead < 4) return undefined;
    const offset = head.readUIntBE(0, 3) * 4096;
    if (offset === 0 || head[3] === 0) return undefined;
    const lenBuf = Buffer.alloc(5);
    await handle.read(lenBuf, 0, 5, offset);
    const length = lenBuf.readInt32BE(0);
    const compression = lenBuf[4];
    if (compression & 0x80) throw new Error(`chunk ${cx},${cz}: external .mcc chunk files are not supported`);
    const raw = Buffer.alloc(length - 1);
    await handle.read(raw, 0, length - 1, offset + 5);
    const nbtBuf = compression === 2 ? inflateSync(raw) : compression === 1 ? gunzipSync(raw) : compression === 3 ? raw : undefined;
    if (!nbtBuf) throw new Error(`chunk ${cx},${cz}: unknown compression ${compression}`);
    const root = (await parseNbt(nbtBuf)).value as CompoundValue;
    const sections = new Map<number, Section>();
    for (const sec of listOf(root, 'sections') as CompoundValue[]) {
      const s = decodeSection(sec);
      sections.set(s.y, s);
    }
    const heightmaps = new Map<string, number[]>();
    const hm = compound(root, 'Heightmaps');
    if (hm) for (const k of Object.keys(hm)) heightmaps.set(k, unpackLongs(longPairs(hm, k), 9, 256));
    const blockEntities: BlockEntity[] = (listOf(root, 'block_entities') as CompoundValue[]).map((be) => ({
      pos: [num(be, 'x'), num(be, 'y'), num(be, 'z')],
      id: str(be, 'id', 'unknown'),
      data: omitKeys(be, ['id', 'x', 'y', 'z', 'keepPacked']),
    }));
    return { cx, cz, minY: num(root, 'yPos', -4) * 16, sections, heightmaps, blockEntities, dataVersion: num(root, 'DataVersion', 0) };
  } finally {
    await handle.close();
  }
}

export function chunkBlock(chunk: ChunkData, x: number, y: number, z: number): BlockState {
  const sec = chunk.sections.get(y >> 4);
  if (!sec) return AIR;
  if (!sec.indices) return sec.palette[0];
  return sec.palette[sec.indices[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]] ?? AIR;
}

/** Highest block y in the column per the given heightmap, or minY−1 when the column is empty. */
export function chunkSurface(chunk: ChunkData, x: number, z: number, type = 'MOTION_BLOCKING'): number {
  const hm = chunk.heightmaps.get(type);
  if (!hm) return chunk.minY - 1;
  const v = hm[((z & 15) << 4) | (x & 15)];
  return v + chunk.minY - 1;
}

async function chunksFor(regionDir: string, minX: number, minZ: number, maxX: number, maxZ: number): Promise<{ chunks: Map<string, ChunkData>; missing: number }> {
  const chunks = new Map<string, ChunkData>();
  let missing = 0;
  for (let cx = minX >> 4; cx <= maxX >> 4; cx++) {
    for (let cz = minZ >> 4; cz <= maxZ >> 4; cz++) {
      const c = await readChunk(regionDir, cx, cz);
      if (c) chunks.set(`${cx},${cz}`, c);
      else missing++;
    }
  }
  return { chunks, missing };
}

export async function readVoxels(regionDir: string, box: Box): Promise<{ voxels: VoxelSet; blockEntities: BlockEntity[]; missingChunks: number }> {
  const { chunks, missing } = await chunksFor(regionDir, box.min[0], box.min[2], box.max[0], box.max[2]);
  const voxels = new VoxelSet();
  const blockEntities: BlockEntity[] = [];
  for (const c of chunks.values()) {
    const x0 = Math.max(box.min[0], c.cx * 16);
    const x1 = Math.min(box.max[0], c.cx * 16 + 15);
    const z0 = Math.max(box.min[2], c.cz * 16);
    const z1 = Math.min(box.max[2], c.cz * 16 + 15);
    for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) voxels.set(x, y, z, chunkBlock(c, x, y, z));
    for (const be of c.blockEntities) {
      const p = be.pos;
      if (p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1] && p[2] >= box.min[2] && p[2] <= box.max[2]) blockEntities.push(be);
    }
  }
  return { voxels, blockEntities, missingChunks: missing };
}

/** heights[z - minZ][x - minX]; null where the chunk is missing. */
export async function readHeightmap(regionDir: string, minX: number, minZ: number, maxX: number, maxZ: number, type = 'MOTION_BLOCKING'): Promise<{ heights: (number | null)[][]; missingChunks: number; chunks: Map<string, ChunkData> }> {
  const { chunks, missing } = await chunksFor(regionDir, minX, minZ, maxX, maxZ);
  const heights: (number | null)[][] = [];
  for (let z = minZ; z <= maxZ; z++) {
    const row: (number | null)[] = [];
    for (let x = minX; x <= maxX; x++) {
      const c = chunks.get(`${x >> 4},${z >> 4}`);
      row.push(c ? chunkSurface(c, x, z, type) : null);
    }
    heights.push(row);
  }
  return { heights, missingChunks: missing, chunks };
}

export function surfaceBlock(chunks: Map<string, ChunkData>, x: number, z: number, y: number): BlockState {
  const c = chunks.get(`${x >> 4},${z >> 4}`);
  return c ? chunkBlock(c, x, y, z) : AIR;
}

export type { Vec3 };
