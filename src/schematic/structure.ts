import { BlockState, VoxelSet, type Vec3 } from '../voxel/voxels.js';
import { T, num, str, compound, listOf, intList, omitKeys, type NbtRoot, type CompoundValue } from '../nbt/nbt.js';
import type { Clipboard, BlockEntity } from './clipboard.js';

function stateFromPalette(entry: CompoundValue): BlockState {
  const props: Record<string, string> = {};
  const p = compound(entry, 'Properties');
  if (p) for (const [k, v] of Object.entries(p)) props[k] = String(v.value);
  return new BlockState(str(entry, 'Name'), props);
}

function paletteEntry(state: BlockState): CompoundValue {
  const entry: CompoundValue = { Name: T.string(state.name) };
  const keys = Object.keys(state.props);
  if (keys.length) {
    const props: CompoundValue = {};
    for (const k of keys) props[k] = T.string(state.props[k]);
    entry.Properties = T.comp(props);
  }
  return entry;
}

export function readStructure(root: NbtRoot): Clipboard {
  const v = root.value as CompoundValue;
  const size = intList(v, 'size');
  if (size.length !== 3) throw new Error('structure: missing size');
  let paletteList = listOf(v, 'palette') as CompoundValue[];
  if (paletteList.length === 0) {
    const palettes = listOf(v, 'palettes') as Array<{ type: string; value: CompoundValue[] } | CompoundValue[]>;
    const first = palettes[0];
    if (first) paletteList = Array.isArray(first) ? first : ((first as { value: CompoundValue[] }).value ?? []);
  }
  const states = paletteList.map(stateFromPalette);
  const voxels = new VoxelSet();
  const blockEntities: BlockEntity[] = [];
  for (const b of listOf(v, 'blocks') as CompoundValue[]) {
    const pos = intList(b, 'pos') as Vec3;
    const state = states[num(b, 'state')];
    if (!state) throw new Error(`structure: block state index ${num(b, 'state')} out of palette range`);
    voxels.set(pos[0], pos[1], pos[2], state);
    const nbtTag = compound(b, 'nbt');
    if (nbtTag) blockEntities.push({ pos, id: str(nbtTag, 'id', state.name), data: omitKeys(nbtTag, ['id', 'x', 'y', 'z']) });
  }
  return { voxels, size: [size[0], size[1], size[2]], offset: [0, 0, 0], dataVersion: num(v, 'DataVersion', 0), blockEntities, source: 'structure' };
}

export function writeStructure(clip: Clipboard): NbtRoot {
  const paletteIndex = new Map<string, number>();
  const palette: CompoundValue[] = [];
  const beByPos = new Map<string, BlockEntity>();
  for (const be of clip.blockEntities) beByPos.set(be.pos.join(','), be);
  const blocks: CompoundValue[] = [];
  for (const [p, s] of clip.voxels.entries()) {
    const k = s.toString();
    let idx = paletteIndex.get(k);
    if (idx === undefined) {
      idx = palette.length;
      paletteIndex.set(k, idx);
      palette.push(paletteEntry(s));
    }
    const entry: CompoundValue = { state: T.int(idx), pos: T.list(T.int([p[0], p[1], p[2]])) };
    const be = beByPos.get(p.join(','));
    if (be) entry.nbt = T.comp({ ...be.data, id: T.string(be.id) });
    blocks.push(entry);
  }
  return T.comp(
    {
      size: T.list(T.int([clip.size[0], clip.size[1], clip.size[2]])),
      palette: T.list(T.comp(palette)),
      blocks: T.list(T.comp(blocks)),
      entities: T.list(T.comp([])),
      DataVersion: T.int(clip.dataVersion),
    },
    '',
  ) as NbtRoot;
}
