/**
 * Command-based surface probe: the fallback for servers where blockwright cannot read the
 * region files (no BLOCKWRIGHT_SERVER_DIR, or the world folder lives on another machine).
 *
 * It binary-searches each column for the highest non-air block with `execute if block … air`,
 * which vanilla answers with "Test passed" / "Test failed". That is roughly log2(height) + 1
 * RCON round trips per column, so it is far slower than reading the Anvil files and is
 * deliberately capped: terraforming a large box this way would mean tens of thousands of
 * commands. It also cannot see caves or overhangs (the search assumes solid ground under
 * air), and it cannot snapshot, so undo will not be available for the write that follows.
 */

import type { Box } from '../voxel/voxels.js';
import { CELL_AIR, CELL_GROUND, CELL_WATER, type ColumnGrid } from './columns.js';

export const DEFAULT_PROBE_COLUMN_LIMIT = 2048;

export interface ProbeOptions {
  /** Passed through prefixDimension by the caller; already-prefixed commands are fine. */
  prefix?: (text: string) => string;
  columnLimit?: number;
}

export interface ProbeResult {
  grid: ColumnGrid;
  commands: number;
  /** Columns where the search found nothing but air in the box's y range. */
  emptyColumns: number;
}

const PASSED = /Test passed/i;

export function probeColumnCost(box: Box): { columns: number; commands: number } {
  const w = box.max[0] - box.min[0] + 1;
  const h = box.max[2] - box.min[2] + 1;
  const range = box.max[1] - box.min[1] + 1;
  const perColumn = Math.ceil(Math.log2(Math.max(2, range))) + 2;
  return { columns: w * h, commands: w * h * perColumn };
}

export async function probeColumnGrid(run: (command: string) => Promise<string>, box: Box, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const limit = opts.columnLimit ?? DEFAULT_PROBE_COLUMN_LIMIT;
  const { columns } = probeColumnCost(box);
  if (columns > limit) {
    throw new Error(
      `terraform cannot read the world directly, and probing ${columns.toLocaleString()} columns with console commands exceeds the ${limit.toLocaleString()} column probe limit. ` +
        `Set BLOCKWRIGHT_SERVER_DIR so the region files can be read, or use a smaller box.`,
    );
  }
  const prefix = opts.prefix ?? ((t: string) => t);
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
  let commands = 0;
  let emptyColumns = 0;
  const isBlock = async (x: number, y: number, z: number, block: string): Promise<boolean> => {
    commands++;
    return PASSED.test(await run(prefix(`execute if block ${x} ${y} ${z} ${block}`)));
  };

  for (let zi = 0; zi < h; zi++) {
    for (let xi = 0; xi < w; xi++) {
      const x = minX + xi;
      const z = minZ + zi;
      let lo = yMin;
      let hi = yMax;
      let found = yMin - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (await isBlock(x, mid, z, 'air')) hi = mid - 1;
        else {
          found = mid;
          lo = mid + 1;
        }
      }
      const col = zi * w + xi;
      grid.known[col] = 1;
      if (found < yMin) {
        emptyColumns++;
        continue;
      }
      const water = await isBlock(x, found, z, 'water');
      grid.ground[col] = water ? found - 1 : found;
      grid.top[col] = found;
      grid.water[col] = water ? 1 : 0;
      grid.groundBlock[col] = water ? '' : 'unknown';
      const base = col * yCount;
      for (let k = 0; k < yCount; k++) {
        const y = yMin + k;
        grid.cells[base + k] = y > found ? CELL_AIR : y === found && water ? CELL_WATER : CELL_GROUND;
      }
    }
  }
  return { grid, commands, emptyColumns };
}
