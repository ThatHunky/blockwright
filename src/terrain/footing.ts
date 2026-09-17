/**
 * What a block means to someone walking: can it be stood on, and how high is its top; can it
 * be walked through; or is it in the way.
 *
 * This is the collision view, not the picture view of render/model.ts: a flower has a shape
 * worth drawing but nothing to bump into, a fence is drawn as a thin post but blocks a player
 * at 1.5 blocks, and a single snow layer looks like a sheet but is stood through. The numbers
 * are the game's own collision tops, so a path of dirt_path next to grass (15/16 vs 1) reads
 * as the 1/16 step it is, and a staircase of bottom slabs reads as half steps a player can
 * walk up without jumping.
 */

import type { BlockState } from '../voxel/voxels.js';
import { blockBoxes } from '../render/model.js';
import { PLANTS, PLANT_SUFFIXES } from './columns.js';

export type FootingKind = 'pass' | 'floor' | 'obstacle' | 'water' | 'lava';

export interface Footing {
  kind: FootingKind;
  /** Collision top within the cell (0..1.5); 0 for pass and liquids. */
  top: number;
}

const PASS: Footing = { kind: 'pass', top: 0 };
const WATER: Footing = { kind: 'water', top: 0 };
const LAVA: Footing = { kind: 'lava', top: 0 };
const FULL: Footing = { kind: 'floor', top: 1 };

const floor = (top: number): Footing => ({ kind: 'floor', top });
const obstacle = (top: number): Footing => ({ kind: 'obstacle', top });

const AIRS = new Set(['air', 'cave_air', 'void_air', 'light', 'structure_void', 'moving_piston']);
const WATERS = new Set(['water', 'flowing_water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
const LAVAS = new Set(['lava', 'flowing_lava']);

/** No collision box at all: walked straight through. */
const PASS_NAMES = new Set([
  'redstone_wire', 'tripwire', 'tripwire_hook', 'lever', 'ladder', 'rail', 'nether_portal', 'end_portal',
  'powder_snow', 'hanging_moss', 'pale_hanging_moss', 'resin_clump', 'string', 'frogspawn', 'cocoa',
]);
const PASS_SUFFIXES = ['torch', '_sign', '_banner', '_button', '_pressure_plate', '_rail', '_coral_fan', '_coral_wall_fan'];

/** Things with collision that a path should never have in it, even where they could be climbed. */
const OBSTACLE_NAMES = new Set([
  'cactus', 'bamboo', 'sweet_berry_bush', 'cobweb', 'fire', 'soul_fire', 'iron_bars', 'chain', 'iron_chain',
  'end_rod', 'lightning_rod', 'pointed_dripstone',
]);

/** Collision tops that differ from the silhouette model.ts draws (or that it does not know). */
const FLOOR_TOPS = new Map<string, number>([
  ['soul_sand', 14 / 16], ['mud', 14 / 16], ['honey_block', 15 / 16], ['end_portal_frame', 13 / 16],
  ['lily_pad', 1.5 / 16], ['big_dripleaf', 15 / 16], ['sea_pickle', 6 / 16],
  ['azalea', 1], ['flowering_azalea', 1], ['mangrove_roots', 1], ['muddy_mangrove_roots', 1],
  ['scaffolding', 1], ['lectern', 14 / 16], ['chest', 14 / 16], ['trapped_chest', 14 / 16], ['ender_chest', 14 / 16],
]);

function isPlant(n: string): boolean {
  if (PLANTS.has(n)) return true;
  for (const s of PLANT_SUFFIXES) if (n.endsWith(s)) return true;
  return false;
}

export function footing(state: BlockState): Footing {
  const n = state.shortName;
  const p = state.props;
  if (AIRS.has(n)) return PASS;
  if (WATERS.has(n)) return WATER;
  if (LAVAS.has(n)) return LAVA;

  if (n === 'snow') {
    // The game's collision box for a snow layer is one layer lower than its picture: a
    // single layer is stood straight through, eight layers are 14/16 high.
    const layers = Math.max(1, Math.min(8, Number(p.layers ?? '1')));
    return layers === 1 ? PASS : floor((layers - 1) / 8);
  }
  if (OBSTACLE_NAMES.has(n) || n.endsWith('_leaves') || n.endsWith('_pane')) return obstacle(1);
  if (n.endsWith('_fence') || n.endsWith('_wall')) return obstacle(1.5);
  if (n.endsWith('_fence_gate')) return p.open === 'true' ? PASS : obstacle(1.5);
  if (n.endsWith('_door')) return p.open === 'true' ? PASS : obstacle(1);
  if (n.endsWith('_trapdoor')) {
    if (p.open === 'true') return PASS;
    return p.half === 'top' ? FULL : floor(3 / 16);
  }
  if (n.endsWith('_carpet')) return floor(1 / 16);
  if ((n.endsWith('_head') && n !== 'piston_head') || n.endsWith('_skull')) return floor(0.5);
  if (n === 'barrier') return FULL;
  const known = FLOOR_TOPS.get(n);
  if (known !== undefined) return floor(known);

  if (PASS_NAMES.has(n) || isPlant(n)) return p.waterlogged === 'true' ? WATER : PASS;
  for (const s of PASS_SUFFIXES) if (n.endsWith(s)) return p.waterlogged === 'true' ? WATER : PASS;

  if (n.endsWith('_slab')) return (p.type ?? 'bottom') === 'bottom' ? floor(0.5) : FULL;
  if (n.endsWith('_stairs')) return FULL;

  let top = 0;
  for (const bx of blockBoxes(state)) if (bx.y1 > top) top = bx.y1;
  return top > 0 ? floor(top) : PASS;
}

/** Leaves, logs and man-made barriers read as "obstacle" when they are what blocks the way;
 * anything else overhead (a stone ceiling, a buried path) reads as missing headroom. */
export function blocksAsObstacle(state: BlockState): boolean {
  const n = state.shortName;
  return footing(state).kind === 'obstacle' || n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem') || n.endsWith('_hyphae');
}

const OPPOSITE: Record<string, [number, number]> = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] };

/**
 * A bottom-half stair can be climbed as two half steps — onto its low half, then up to its
 * top — from every side except the one its tall back faces. Returns true when a move of
 * (dx, dz) onto `state` gets that easier climb.
 */
export function stairHalfStep(state: BlockState, dx: number, dz: number): boolean {
  if (!state.shortName.endsWith('_stairs') || state.props.half === 'top') return false;
  const back = OPPOSITE[state.props.facing ?? 'north'];
  return !(back && back[0] === dx && back[1] === dz);
}
