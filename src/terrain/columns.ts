/**
 * Turns a read slab of the world into the per-column view terraforming and scattering need:
 * where the ground surface is, what is stacked above it, and which columns are water.
 *
 * "Ground" here means the real, walkable surface — not the MOTION_BLOCKING heightmap, which
 * counts leaves and water and so puts the surface of a meadow with one oak in it 12 blocks
 * too high. Every cell is classified once into air / water / plant / canopy / ground, the
 * surface is the highest `ground` cell, and everything above it is either cover to carve or
 * a tree to leave alone.
 */

import { BlockState, VoxelSet, type Box } from '../voxel/voxels.js';

export const CELL_AIR = 0;
export const CELL_WATER = 1;
/** Ground cover: grass, flowers, a snow layer — replaceable, never the surface. */
export const CELL_PLANT = 2;
/** Trees and mushrooms: solid, but standing on the ground rather than being it. */
export const CELL_CANOPY = 3;
export const CELL_GROUND = 4;

export type Cell = 0 | 1 | 2 | 3 | 4;

const WATER = new Set(['water', 'flowing_water', 'bubble_column']);

export const PLANTS = new Set([
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush', 'firefly_bush', 'leaf_litter',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'sea_pickle', 'lily_pad', 'sugar_cane', 'cactus',
  'cactus_flower', 'bamboo', 'bamboo_sapling', 'vine', 'glow_lichen', 'sculk_vein', 'hanging_roots',
  'snow', 'moss_carpet', 'pale_moss_carpet', 'pink_petals', 'wildflowers', 'spore_blossom',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'wither_rose', 'torchflower', 'pitcher_plant', 'sunflower', 'lilac', 'rose_bush', 'peony',
  'closed_eyeblossom', 'open_eyeblossom', 'red_mushroom', 'brown_mushroom', 'crimson_roots', 'warped_roots',
  'nether_sprouts', 'sweet_berry_bush', 'cave_vines', 'cave_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'weeping_vines', 'weeping_vines_plant', 'big_dripleaf', 'big_dripleaf_stem', 'small_dripleaf', 'cobweb',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem',
  'attached_pumpkin_stem', 'nether_wart', 'cocoa', 'frogspawn', 'fire', 'soul_fire', 'torch', 'redstone_torch',
]);

export const PLANT_SUFFIXES = ['_sapling', '_tulip', '_carpet', '_coral', '_coral_fan', '_coral_wall_fan', '_fungus', '_mushroom', '_roots', '_sprouts'];
const CANOPY_SUFFIXES = ['_log', '_wood', '_leaves', '_stem', '_hyphae', '_mushroom_block'];
const CANOPY = new Set(['mushroom_stem', 'nether_wart_block', 'warped_wart_block', 'shroomlight']);

export function classifyBlock(state: BlockState): Cell {
  if (state.isAir) return CELL_AIR;
  const n = state.shortName;
  if (WATER.has(n)) return CELL_WATER;
  if (CANOPY.has(n)) return CELL_CANOPY;
  for (const s of CANOPY_SUFFIXES) if (n.endsWith(s)) return CELL_CANOPY;
  if (PLANTS.has(n)) return CELL_PLANT;
  for (const s of PLANT_SUFFIXES) if (n.endsWith(s)) return CELL_PLANT;
  return CELL_GROUND;
}

/**
 * Per-column summary of a box of world, plus the classified cells themselves so the
 * terraformer can decide what it is allowed to overwrite without a second read.
 */
export interface ColumnGrid {
  minX: number;
  minZ: number;
  w: number;
  h: number;
  yMin: number;
  yMax: number;
  yCount: number;
  /** Highest CELL_GROUND y per column, or yMin − 1 when the slab holds no ground at all. */
  ground: Int32Array;
  /** Highest non-air y per column, or yMin − 1 for an empty column. */
  top: Int32Array;
  /** 1 when the column was actually read (its chunk exists). */
  known: Uint8Array;
  /** 1 when water stands above the ground surface. */
  water: Uint8Array;
  /** Classified cells, `(zi * w + xi) * yCount + (y − yMin)`. */
  cells: Uint8Array;
  /** Surface block name (short form) at `ground`, '' when there is none. */
  groundBlock: string[];
}

export function cellAt(grid: ColumnGrid, xi: number, zi: number, y: number): Cell {
  if (y < grid.yMin || y > grid.yMax) return CELL_AIR;
  return grid.cells[(zi * grid.w + xi) * grid.yCount + (y - grid.yMin)] as Cell;
}

/**
 * Builds the column grid from a VoxelSet read out of the world. Positions the read did not
 * cover (ungenerated chunks) leave the column marked unknown, which every caller treats as
 * "do not touch".
 */
export function columnsFromVoxels(voxels: VoxelSet, box: Box): ColumnGrid {
  const minX = box.min[0];
  const minZ = box.min[2];
  const yMin = box.min[1];
  const yMax = box.max[1];
  const w = box.max[0] - minX + 1;
  const h = box.max[2] - minZ + 1;
  const yCount = yMax - yMin + 1;
  const grid: ColumnGrid = {
    minX,
    minZ,
    w,
    h,
    yMin,
    yMax,
    yCount,
    ground: new Int32Array(w * h).fill(yMin - 1),
    top: new Int32Array(w * h).fill(yMin - 1),
    known: new Uint8Array(w * h),
    water: new Uint8Array(w * h),
    cells: new Uint8Array(w * h * yCount),
    groundBlock: new Array<string>(w * h).fill(''),
  };
  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const col = zi * w + xi;
      const base = col * yCount;
      let known = false;
      let ground = yMin - 1;
      let top = yMin - 1;
      let groundBlock = '';
      let waterAbove = false;
      for (let k = 0; k < yCount; k++) {
        const y = yMin + k;
        const state = voxels.get(minX + xi, y, minZ + zi);
        if (state === undefined) continue;
        known = true;
        const c = classifyBlock(state);
        grid.cells[base + k] = c;
        if (c !== CELL_AIR) top = y;
        if (c === CELL_GROUND) {
          ground = y;
          groundBlock = state.shortName;
          waterAbove = false;
        } else if (c === CELL_WATER) {
          waterAbove = true;
        }
      }
      grid.known[col] = known ? 1 : 0;
      grid.ground[col] = ground;
      grid.top[col] = top;
      grid.groundBlock[col] = groundBlock;
      grid.water[col] = waterAbove ? 1 : 0;
    }
  }
  return grid;
}

/** Highest 4-neighbour ground difference around a column, used as a slope estimate. */
export function columnSlope(grid: ColumnGrid, xi: number, zi: number): number {
  const i = zi * grid.w + xi;
  const here = grid.ground[i];
  let worst = 0;
  const look = (x: number, z: number): void => {
    if (x < 0 || z < 0 || x >= grid.w || z >= grid.h) return;
    const j = z * grid.w + x;
    if (!grid.known[j] || grid.ground[j] < grid.yMin) return;
    const d = Math.abs(grid.ground[j] - here);
    if (d > worst) worst = d;
  };
  look(xi - 1, zi);
  look(xi + 1, zi);
  look(xi, zi - 1);
  look(xi, zi + 1);
  return worst;
}
