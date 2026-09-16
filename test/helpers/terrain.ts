import { BlockState, VoxelSet, type Box } from '../../src/voxel/voxels.js';

export interface TerrainOptions {
  /** Ground surface y for a column. */
  height: (x: number, z: number) => number;
  /** Water level; columns whose ground is below it get water up to it. */
  sea?: number;
  /** Extra blocks to drop on top, e.g. a tree. */
  decorate?: (x: number, z: number, groundY: number, set: VoxelSet) => void;
  top?: string;
  soil?: string;
  stone?: string;
}

/**
 * Fills a box with vanilla-shaped columns: stone, three blocks of dirt, one of grass, then
 * air (or water up to `sea`). Everything outside the box is left unset, which is what the
 * region reader does for ungenerated chunks.
 */
export function terrainVoxels(box: Box, opts: TerrainOptions): VoxelSet {
  const top = BlockState.parse(opts.top ?? 'grass_block');
  const soil = BlockState.parse(opts.soil ?? 'dirt');
  const stone = BlockState.parse(opts.stone ?? 'stone');
  const water = BlockState.parse('water');
  const air = BlockState.parse('air');
  const set = new VoxelSet();
  for (let x = box.min[0]; x <= box.max[0]; x++) {
    for (let z = box.min[2]; z <= box.max[2]; z++) {
      const g = opts.height(x, z);
      for (let y = box.min[1]; y <= box.max[1]; y++) {
        if (y < g - 3) set.set(x, y, z, stone);
        else if (y < g) set.set(x, y, z, soil);
        else if (y === g) set.set(x, y, z, top);
        else if (opts.sea !== undefined && y <= opts.sea) set.set(x, y, z, water);
        else set.set(x, y, z, air);
      }
      opts.decorate?.(x, z, g, set);
    }
  }
  return set;
}
