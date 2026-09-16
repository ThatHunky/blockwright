import type { BlockState } from '../voxel/voxels.js';

/** A sub-box of one block cell, in cell-local units where the cell spans 0..1 on every axis. */
export interface Box3 {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

const FULL: Box3[] = [{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }];
const NONE: Box3[] = [];

function b(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3 {
  return { x0, y0, z0, x1, y1, z1 };
}

/** Half-cell slabs cover most of the "flat thing on the ground" cases. */
function lower(h: number): Box3[] {
  return [b(0, 0, 0, 1, h, 1)];
}

const POST = 0.375;
const THIN = 0.0625;

/** Blocks with no geometry worth drawing: they would only add noise at block-sized pixels. */
const INVISIBLE = new Set([
  'air', 'cave_air', 'void_air', 'barrier', 'structure_void', 'light', 'water', 'lava',
  'moving_piston', 'bubble_column',
]);

/** Cross-shaped plants: a small upright tuft reads better than a full cube of leaf colour. */
const SMALL_PLANT = /(^|_)(grass|fern|sapling|seagrass|kelp|vine|flower|tulip|orchid|bluet|daisy|cornflower|allium|dandelion|poppy|lily_of_the_valley|wither_rose|eyeblossom|torchflower|pitcher_plant|mushroom|fungus|roots|sprouts|bush|petals|wildflowers|leaf_litter|dead_bush|hanging_moss|glow_lichen|nether_wart|crop|carrots|potatoes|beetroots|wheat|sweet_berry_bush|cocoa|dripleaf|azalea|spore_blossom|sapling)$/;
const TALL_PLANT = /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass|pitcher_plant)$/;

/**
 * The shape a block occupies, as axis-aligned sub-boxes.
 *
 * This is deliberately *not* the collision shape from minecraft-data: what matters for a picture
 * is the silhouette a viewer recognises. A fence must read as a thin post, a slab as half a
 * cell, a lantern as a small lamp — drawing every one of them as a full cube is what makes a
 * rendered bridge look like a solid slab and hides exactly the mistakes the render exists to
 * catch. Anything unrecognised falls back to a full cube, which is the safe, honest default.
 */
export function blockBoxes(state: BlockState): Box3[] {
  const n = state.shortName;
  const p = state.props;
  if (INVISIBLE.has(n)) return NONE;

  if (n.endsWith('_slab')) {
    const t = p.type ?? 'bottom';
    if (t === 'double') return FULL;
    return t === 'top' ? [b(0, 0.5, 0, 1, 1, 1)] : lower(0.5);
  }
  if (n.endsWith('_stairs')) {
    const top = p.half === 'top';
    const base = top ? b(0, 0.5, 0, 1, 1, 1) : b(0, 0, 0, 1, 0.5, 1);
    const step = stairStep(p.facing ?? 'north', p.shape ?? 'straight');
    const sy0 = top ? 0 : 0.5;
    const sy1 = top ? 0.5 : 1;
    return [base, ...step.map((s) => b(s.x0, sy0, s.z0, s.x1, sy1, s.z1))];
  }
  if (n.endsWith('_fence') || n === 'fence' || n.endsWith('_wall')) {
    const boxes = [b(POST, 0, POST, 1 - POST, 1, 1 - POST)];
    for (const [side, dx0, dz0, dx1, dz1] of SIDES) {
      if (p[side] && p[side] !== 'none' && p[side] !== 'false') {
        boxes.push(b(dx0, 0.35, dz0, dx1, 0.95, dz1));
      }
    }
    return boxes;
  }
  if (n.endsWith('_fence_gate')) {
    const alongX = p.facing === 'north' || p.facing === 'south';
    return p.open === 'true'
      ? [b(0, 0.3, 0, THIN * 3, 1, THIN * 3), b(1 - THIN * 3, 0.3, 1 - THIN * 3, 1, 1, 1)]
      : alongX
        ? [b(0, 0.3, POST, 1, 1, 1 - POST)]
        : [b(POST, 0.3, 0, 1 - POST, 1, 1)];
  }
  if (n.endsWith('_pane') || n === 'iron_bars') {
    const boxes = [b(0.4375, 0, 0.4375, 0.5625, 1, 0.5625)];
    if (p.north === 'true') boxes.push(b(0.4375, 0, 0, 0.5625, 1, 0.4375));
    if (p.south === 'true') boxes.push(b(0.4375, 0, 0.5625, 0.5625, 1, 1));
    if (p.west === 'true') boxes.push(b(0, 0, 0.4375, 0.4375, 1, 0.5625));
    if (p.east === 'true') boxes.push(b(0.5625, 0, 0.4375, 1, 1, 0.5625));
    return boxes;
  }
  if (n.endsWith('_trapdoor')) {
    if (p.open === 'true') return [faceSlab(p.facing ?? 'north', 0.1875)];
    return p.half === 'top' ? [b(0, 1 - 0.1875, 0, 1, 1, 1)] : lower(0.1875);
  }
  if (n.endsWith('_door')) return [faceSlab(p.facing ?? 'north', 0.1875, p.open === 'true')];
  if (n.endsWith('_carpet') || n === 'moss_carpet' || n === 'pale_moss_carpet') return lower(0.0625);
  if (n === 'snow') return lower(Math.min(8, Number(p.layers ?? '1')) * 0.125);
  if (n === 'farmland' || n === 'dirt_path') return lower(0.9375);
  if (n === 'lantern' || n === 'soul_lantern') {
    const hanging = p.hanging === 'true';
    return [b(0.3125, hanging ? 0.3125 : 0.0625, 0.3125, 0.6875, hanging ? 0.875 : 0.625, 0.6875)];
  }
  if (n.endsWith('torch') || n.endsWith('_candle') || n === 'candle') return [b(0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625)];
  if (n === 'chain') return [b(0.4375, 0, 0.4375, 0.5625, 1, 0.5625)];
  if (n === 'end_rod' || n === 'lightning_rod') return [b(0.4375, 0, 0.4375, 0.5625, 1, 0.5625)];
  if (n.endsWith('_button')) return [faceSlab(p.facing ?? 'north', 0.125)];
  if (n.endsWith('_pressure_plate') || n.endsWith('_plate')) return lower(0.0625);
  if (n === 'ladder' || n.endsWith('_sign') || n.endsWith('_banner') || n === 'painting') {
    return [faceSlab(p.facing ?? 'north', 0.125)];
  }
  if (n === 'lily_pad' || n.endsWith('_rail') || n === 'rail') return lower(0.0625);
  if (n === 'campfire' || n === 'soul_campfire') return lower(0.4375);
  if (n === 'cake') return [b(0.0625, 0, 0.0625, 0.9375, 0.5, 0.9375)];
  if (n === 'hopper') return [b(0, 0.625, 0, 1, 1, 1), b(0.25, 0.25, 0.25, 0.75, 0.625, 0.75)];
  if (n === 'cauldron' || n.endsWith('_cauldron')) return [b(0, 0, 0, 1, 0.3125, 1), b(0, 0.3125, 0, 0.125, 1, 1), b(0.875, 0.3125, 0, 1, 1, 1), b(0.125, 0.3125, 0, 0.875, 1, 0.125), b(0.125, 0.3125, 0.875, 0.875, 1, 1)];
  if (n === 'enchanting_table') return lower(0.75);
  if (n === 'grindstone' || n === 'stonecutter') return lower(0.5625);
  if (n === 'lectern') return [b(0, 0, 0, 1, 0.125, 1), b(0.25, 0.125, 0.25, 0.75, 0.9, 0.75)];
  if (n === 'brewing_stand') return [b(0.4375, 0, 0.4375, 0.5625, 0.875, 0.5625), b(0.125, 0, 0.125, 0.875, 0.125, 0.875)];
  if (n === 'flower_pot' || n.startsWith('potted_')) return [b(0.3125, 0, 0.3125, 0.6875, 0.375, 0.6875)];
  if (n === 'turtle_egg' || n === 'sea_pickle' || n === 'sniffer_egg') return [b(0.3125, 0, 0.3125, 0.6875, 0.4375, 0.6875)];
  if (n === 'bed' || n.endsWith('_bed')) return lower(0.5625);
  if (n === 'chest' || n === 'trapped_chest' || n === 'ender_chest') return [b(0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375)];
  if (n === 'scaffolding') return [b(0, 0.875, 0, 1, 1, 1), b(0, 0, 0, 0.125, 0.875, 0.125), b(0.875, 0, 0, 1, 0.875, 0.125), b(0, 0, 0.875, 0.125, 0.875, 1), b(0.875, 0, 0.875, 1, 0.875, 1)];
  if (n === 'daylight_detector') return lower(0.375);
  if (n.endsWith('_amethyst_bud') || n === 'amethyst_cluster') return [b(0.25, 0, 0.25, 0.75, 0.6, 0.75)];
  if (n === 'pointed_dripstone') return [b(0.25, 0, 0.25, 0.75, 1, 0.75)];
  if (TALL_PLANT.test(n)) return [b(0.2, 0, 0.2, 0.8, 1, 0.8)];
  if (SMALL_PLANT.test(n)) return [b(0.22, 0, 0.22, 0.78, 0.7, 0.78)];
  return FULL;
}

const SIDES: Array<[string, number, number, number, number]> = [
  ['north', POST, 0, 1 - POST, POST],
  ['south', POST, 1 - POST, 1 - POST, 1],
  ['west', 0, POST, POST, 1 - POST],
  ['east', 1 - POST, POST, 1, 1 - POST],
];

function stairStep(facing: string, shape: string): Array<{ x0: number; z0: number; x1: number; z1: number }> {
  const whole = { north: { x0: 0, z0: 0, x1: 1, z1: 0.5 }, south: { x0: 0, z0: 0.5, x1: 1, z1: 1 }, west: { x0: 0, z0: 0, x1: 0.5, z1: 1 }, east: { x0: 0.5, z0: 0, x1: 1, z1: 1 } }[facing] ?? { x0: 0, z0: 0, x1: 1, z1: 0.5 };
  if (shape === 'straight') return [whole];
  // Corner variants only change the footprint by a quarter cell; approximating them with the
  // straight step keeps the silhouette right without modelling all eight cases.
  return [whole];
}

/** A thin slab pressed against one face of the cell — doors, trapdoors, ladders, signs. */
function faceSlab(facing: string, t: number, flip = false): Box3 {
  const f = flip ? { north: 'west', south: 'east', west: 'south', east: 'north' }[facing] ?? facing : facing;
  switch (f) {
    case 'south': return b(0, 0, 1 - t, 1, 1, 1);
    case 'west': return b(0, 0, 0, t, 1, 1);
    case 'east': return b(1 - t, 0, 0, 1, 1, 1);
    default: return b(0, 0, 0, 1, 1, t);
  }
}

/** True when the block fills its cell completely and hides whatever is behind it. */
export function isFullOpaque(state: BlockState): boolean {
  const n = state.shortName;
  if (INVISIBLE.has(n)) return false;
  if (/glass|ice$|_pane|tinted|barrier|slime_block|honey_block/.test(n)) return false;
  const boxes = blockBoxes(state);
  return boxes.length === 1 && boxes[0].x0 === 0 && boxes[0].y0 === 0 && boxes[0].z0 === 0 && boxes[0].x1 === 1 && boxes[0].y1 === 1 && boxes[0].z1 === 1;
}
