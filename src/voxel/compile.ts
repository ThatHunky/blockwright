import { BlockState, VoxelSet, key, formatVec, boxVolume, boxSize, type Box, type Vec3 } from './voxels.js';

export interface Command {
  text: string;
  blocks: number;
  kind: 'fill' | 'setblock';
  box: Box;
  state: BlockState;
}

export interface CompileOptions {
  /** Max blocks per fill (vanilla gamerule commandModificationBlockLimit, default 32768). */
  fillLimit?: number;
  /** minecraft:overworld | minecraft:the_nether | minecraft:the_end */
  dimension?: string;
}

export const DEFAULT_FILL_LIMIT = 32768;

export function prefixDimension(text: string, dimension?: string): string {
  return dimension && dimension !== 'minecraft:overworld' ? `execute in ${dimension} run ${text}` : text;
}

/** Blocks that need a neighbour to exist first (or pop off / drop when placed early). */
const ATTACHABLE = new RegExp(
  '^minecraft:(' +
    [
      'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
      'lantern', 'soul_lantern', 'ladder', 'vine', 'glow_lichen', 'rail', '.*_rail',
      '.*_door', '.*_trapdoor', '.*_button', 'lever', '.*_pressure_plate', '.*_sign', '.*_banner',
      '.*_carpet', 'moss_carpet', 'snow', 'redstone_wire', 'repeater', 'comparator', 'tripwire', 'tripwire_hook',
      '.*_bed', '.*_sapling', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', '.*_tulip', 'oxeye_daisy',
      'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'pitcher_plant', 'sunflower', 'lilac',
      'rose_bush', 'peony', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass',
      'tall_seagrass', 'kelp', 'kelp_plant', 'lily_pad', '.*_coral_fan', '.*_coral_wall_fan', '.*_coral', 'candle', '.*_candle', '.*_candle_cake',
      'chain', 'bell', 'flower_pot', 'potted_.*', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem',
      'pumpkin_stem', 'attached_.*', 'sugar_cane', 'bamboo', 'bamboo_sapling', 'cactus', 'nether_wart', 'cocoa',
      'sweet_berry_bush', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant',
      'twisting_vines', 'twisting_vines_plant', 'hanging_roots', 'spore_blossom', '.*_fungus', 'crimson_roots',
      'warped_roots', 'nether_sprouts', 'scaffolding', 'iron_bars', '.*_pane', 'lightning_rod', 'end_rod',
      '.*_head', '.*_skull', 'amethyst_cluster', '.*_amethyst_bud', 'pointed_dripstone', 'small_dripleaf',
      'big_dripleaf', 'big_dripleaf_stem', 'frogspawn', 'sculk_vein', '.*_wall_.*', 'pink_petals', 'wildflowers',
      'leaf_litter', 'bush', 'firefly_bush', 'cactus_flower', 'closed_eyeblossom', 'open_eyeblossom',
    ].join('|') +
    ')$',
);

export function isAttachable(state: BlockState): boolean {
  return ATTACHABLE.test(state.name);
}

/** Greedy merge of positions into axis-aligned boxes: extend along x, then z, then y. */
export function mergeBoxes(positions: Vec3[]): Box[] {
  const cells = new Set(positions.map((p) => key(p[0], p[1], p[2])));
  const visited = new Set<string>();
  const free = (x: number, y: number, z: number): boolean => {
    const k = key(x, y, z);
    return cells.has(k) && !visited.has(k);
  };
  const sorted = [...positions].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  const boxes: Box[] = [];
  for (const p of sorted) {
    if (!free(p[0], p[1], p[2])) continue;
    let x2 = p[0];
    while (free(x2 + 1, p[1], p[2])) x2++;
    let z2 = p[2];
    outerZ: for (;;) {
      for (let x = p[0]; x <= x2; x++) if (!free(x, p[1], z2 + 1)) break outerZ;
      z2++;
    }
    let y2 = p[1];
    outerY: for (;;) {
      for (let z = p[2]; z <= z2; z++) for (let x = p[0]; x <= x2; x++) if (!free(x, y2 + 1, z)) break outerY;
      y2++;
    }
    for (let y = p[1]; y <= y2; y++) for (let z = p[2]; z <= z2; z++) for (let x = p[0]; x <= x2; x++) visited.add(key(x, y, z));
    boxes.push({ min: [p[0], p[1], p[2]], max: [x2, y2, z2] });
  }
  return boxes;
}

/** Split a box until every piece has at most `limit` blocks, halving the longest axis. */
export function splitBox(b: Box, limit: number): Box[] {
  if (boxVolume(b) <= limit) return [b];
  const size = boxSize(b);
  const axis = size.indexOf(Math.max(...size)) as 0 | 1 | 2;
  const half = Math.floor(size[axis] / 2);
  const aMax: Vec3 = [b.max[0], b.max[1], b.max[2]];
  aMax[axis] = b.min[axis] + half - 1;
  const bMin: Vec3 = [b.min[0], b.min[1], b.min[2]];
  bMin[axis] = b.min[axis] + half;
  return [...splitBox({ min: b.min, max: aMax }, limit), ...splitBox({ min: bMin, max: b.max }, limit)];
}

function toCommand(b: Box, state: BlockState, dimension?: string): Command {
  const blocks = boxVolume(b);
  const text =
    blocks === 1 ? `setblock ${formatVec(b.min)} ${state.toCommand()}` : `fill ${formatVec(b.min)} ${formatVec(b.max)} ${state.toCommand()}`;
  return { text: prefixDimension(text, dimension), blocks, kind: blocks === 1 ? 'setblock' : 'fill', box: b, state };
}

export function compile(set: VoxelSet, opts: CompileOptions = {}): Command[] {
  const limit = Math.max(1, opts.fillLimit ?? DEFAULT_FILL_LIMIT);
  const byState = new Map<string, { state: BlockState; positions: Vec3[] }>();
  for (const [p, s] of set.entries()) {
    const k = s.toString();
    let g = byState.get(k);
    if (!g) byState.set(k, (g = { state: s, positions: [] }));
    g.positions.push(p);
  }
  const pass1: Command[] = [];
  const pass2: Command[] = [];
  for (const { state, positions } of byState.values()) {
    const target = isAttachable(state) ? pass2 : pass1;
    for (const merged of mergeBoxes(positions)) for (const piece of splitBox(merged, limit)) target.push(toCommand(piece, state, opts.dimension));
  }
  const byY = (a: Command, b: Command) => a.box.min[1] - b.box.min[1] || a.box.min[2] - b.box.min[2] || a.box.min[0] - b.box.min[0];
  pass1.sort(byY);
  pass2.sort(byY);
  return [...pass1, ...pass2];
}

export interface ChunkRect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Block-coordinate rectangles covering the chunks of a box, each at most 16×16 chunks (the forceload limit of 256). */
export function forceloadRects(b: Box, maxChunksPerSide = 16): ChunkRect[] {
  const cx1 = b.min[0] >> 4;
  const cz1 = b.min[2] >> 4;
  const cx2 = b.max[0] >> 4;
  const cz2 = b.max[2] >> 4;
  const rects: ChunkRect[] = [];
  for (let cx = cx1; cx <= cx2; cx += maxChunksPerSide) {
    for (let cz = cz1; cz <= cz2; cz += maxChunksPerSide) {
      const ex = Math.min(cx + maxChunksPerSide - 1, cx2);
      const ez = Math.min(cz + maxChunksPerSide - 1, cz2);
      rects.push({ minX: cx * 16, minZ: cz * 16, maxX: ex * 16 + 15, maxZ: ez * 16 + 15 });
    }
  }
  return rects;
}
