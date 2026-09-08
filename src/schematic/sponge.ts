import { BlockState, VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { T, num, compound, listOf, intList, bytes, omitKeys, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard, BlockEntity } from './clipboard.js';

export function decodeVarints(data: number[], expected: number): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length && out.length < expected) {
    let value = 0;
    let shift = 0;
    for (;;) {
      // Without this check, reading past the end of `data` yields `undefined`, which
      // coerces to 0 and can be mistaken for a valid terminating byte, silently decoding
      // truncated data as (likely-air) palette index 0 instead of failing loudly.
      if (i >= data.length) throw new Error('sponge: truncated varint data');
      const b = data[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('sponge: varint too long');
    }
    out.push(value >>> 0);
  }
  if (out.length !== expected) throw new Error(`sponge: block data has ${out.length} entries, expected ${expected}`);
  return out;
}

export function encodeVarints(values: number[]): number[] {
  const out: number[] = [];
  for (let v of values) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b > 127 ? b - 256 : b);
    } while (v !== 0);
  }
  return out;
}

export function readSponge(root: NbtRoot): Clipboard {
  const rootV = root.value as CompoundValue;
  const sch = compound(rootV, 'Schematic') ?? rootV;
  const version = num(sch, 'Version', 1);
  const W = num(sch, 'Width') & 0xffff;
  const H = num(sch, 'Height') & 0xffff;
  const L = num(sch, 'Length') & 0xffff;
  let offset = intList(sch, 'Offset');
  if (offset.length !== 3) {
    const meta = compound(sch, 'Metadata');
    offset = meta ? [num(meta, 'WEOffsetX', 0), num(meta, 'WEOffsetY', 0), num(meta, 'WEOffsetZ', 0)] : [0, 0, 0];
  }
  let paletteC: CompoundValue | undefined;
  let data: number[];
  let beList: CompoundValue[];
  if (version >= 3) {
    const blocks = compound(sch, 'Blocks');
    if (!blocks) throw new Error('sponge v3: missing Blocks');
    paletteC = compound(blocks, 'Palette');
    data = bytes(blocks, 'Data');
    beList = listOf(blocks, 'BlockEntities') as CompoundValue[];
  } else {
    paletteC = compound(sch, 'Palette');
    data = bytes(sch, 'BlockData');
    beList = listOf(sch, 'BlockEntities') as CompoundValue[];
  }
  if (!paletteC) throw new Error('sponge: missing Palette');
  const states: BlockState[] = [];
  for (const [text, tag] of Object.entries(paletteC)) states[tag.value as number] = BlockState.parse(text);
  const indices = decodeVarints(data, W * H * L);
  const voxels = new VoxelSet();
  for (let i = 0; i < indices.length; i++) {
    const s = states[indices[i]];
    if (!s) throw new Error(`sponge: palette index ${indices[i]} missing`);
    voxels.set(i % W, Math.floor(i / (W * L)), Math.floor(i / W) % L, s);
  }
  const blockEntities: BlockEntity[] = beList.map((be) => {
    const pos = intList(be, 'Pos') as Vec3;
    const id = String(be.Id?.value ?? '');
    const dataC = version >= 3 ? (compound(be, 'Data') ?? {}) : omitKeys(be, ['Pos', 'Id']);
    return { pos, id, data: dataC };
  });
  return {
    voxels,
    size: [W, H, L],
    offset: [offset[0], offset[1], offset[2]],
    dataVersion: num(sch, 'DataVersion', 0),
    blockEntities,
    source: 'sponge',
  };
}

function short(v: number): ReturnType<typeof T.short> {
  return T.short(v > 32767 ? v - 65536 : v);
}

export function writeSponge3(clip: Clipboard): NbtRoot {
  const [W, H, L] = clip.size;
  const air = BlockState.parse('air');
  const paletteIndex = new Map<string, number>();
  const paletteTags: CompoundValue = {};
  const indexOf = (s: BlockState): number => {
    const k = s.toString();
    let i = paletteIndex.get(k);
    if (i === undefined) {
      i = paletteIndex.size;
      paletteIndex.set(k, i);
      paletteTags[k] = T.int(i);
    }
    return i;
  };
  const values = new Array<number>(W * H * L);
  for (let y = 0; y < H; y++)
    for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) values[x + z * W + y * W * L] = indexOf(clip.voxels.get(x, y, z) ?? air);
  const blockEntities = clip.blockEntities.map((be) => ({ Pos: T.intArray(be.pos), Id: T.string(be.id), Data: T.comp(be.data) }));
  const schematic = T.comp({
    Version: T.int(3),
    DataVersion: T.int(clip.dataVersion),
    Width: short(W),
    Height: short(H),
    Length: short(L),
    Offset: T.intArray(clip.offset),
    Blocks: T.comp({ Palette: T.comp(paletteTags), Data: T.byteArray(encodeVarints(values)), BlockEntities: T.list(T.comp(blockEntities)) }),
    Entities: T.list(T.comp([])),
  });
  return T.comp({ Schematic: schematic }, '') as NbtRoot;
}
