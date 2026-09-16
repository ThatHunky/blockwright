import { describe, it, expect } from 'vitest';
import { BlockState, box, type Box } from '../../src/voxel/voxels.js';
import { CELL_GROUND, cellAt, columnsFromVoxels, type ColumnGrid } from '../../src/terrain/columns.js';
import { planScatter, scatterVoxelSet, supportIssues, type ScatterEntry } from '../../src/terrain/scatter.js';
import { terrainVoxels } from '../helpers/terrain.js';

const b: Box = box([0, 50, 0], [31, 100, 31]);

function entry(block: string, radius = 0, weight = 1): ScatterEntry {
  return { block: BlockState.parse(block), weight, radius };
}

/** A hillside that climbs 1 block every other column in x, with a cliff on one side. */
function hillside(): ColumnGrid {
  return columnsFromVoxels(terrainVoxels(b, { height: (x) => (x > 24 ? 90 : 64 + Math.floor(x / 2)) }), b);
}

function opts(over: Partial<Parameters<typeof planScatter>[1]> = {}) {
  return { palette: [entry('poppy')], density: 1, seed: 1, spacing: 0, maxCount: 100000, ...over };
}

describe('planScatter', () => {
  it('never emits a block without something under it', () => {
    const grid = hillside();
    const r = planScatter(grid, opts({ palette: [entry('poppy'), entry('short_grass'), entry('tall_grass'), entry('mossy_cobblestone', 2)], density: 1 }));
    expect(r.voxels.length).toBeGreaterThan(500);
    expect(supportIssues(grid, r.voxels)).toEqual([]);
  });

  it('puts single plants exactly one block above the ground', () => {
    const grid = hillside();
    const r = planScatter(grid, opts());
    expect(r.placements).toBeGreaterThan(400);
    for (const v of r.voxels) {
      const xi = v.x - grid.minX;
      const zi = v.z - grid.minZ;
      expect(v.y).toBe(grid.ground[zi * grid.w + xi] + 1);
      expect(cellAt(grid, xi, zi, v.y - 1)).toBe(CELL_GROUND);
    }
  });

  it('places both halves of a double plant, in the right order', () => {
    const grid = hillside();
    const r = planScatter(grid, opts({ palette: [entry('rose_bush')] }));
    expect(r.voxels.length).toBe(r.placements * 2);
    const lower = r.voxels.filter((v) => v.state.props.half === 'lower');
    const upper = r.voxels.filter((v) => v.state.props.half === 'upper');
    expect(lower.length).toBe(upper.length);
    for (const l of lower) expect(upper.some((u) => u.x === l.x && u.z === l.z && u.y === l.y + 1)).toBe(true);
    expect(supportIssues(grid, r.voxels)).toEqual([]);
  });

  it('never plants in water', () => {
    const grid = columnsFromVoxels(terrainVoxels(b, { height: (x) => (x < 12 ? 56 : 64), sea: 62 }), b);
    const r = planScatter(grid, opts());
    expect(r.rejectedWater).toBeGreaterThan(300);
    for (const v of r.voxels) expect(v.x).toBeGreaterThanOrEqual(12);
    expect(supportIssues(grid, r.voxels)).toEqual([]);
  });

  it('never plants under a tree canopy or on top of one', () => {
    const grid = columnsFromVoxels(
      terrainVoxels(b, {
        height: () => 64,
        decorate: (x, z, g, set) => {
          if (x !== 8 || z !== 8) return;
          for (let y = g + 1; y <= g + 4; y++) set.set(x, y, z, BlockState.parse('oak_log[axis=y]'));
        },
      }),
      b,
    );
    const r = planScatter(grid, opts());
    expect(r.voxels.some((v) => v.x === 8 && v.z === 8)).toBe(false);
    expect(supportIssues(grid, r.voxels)).toEqual([]);
  });

  it('respects the on-list and max_slope', () => {
    const grid = hillside();
    const stone = columnsFromVoxels(terrainVoxels(b, { height: () => 64, top: 'stone' }), b);
    expect(planScatter(stone, opts({ on: new Set(['grass_block']) })).voxels).toEqual([]);
    expect(planScatter(stone, opts({ on: new Set(['stone']) })).voxels.length).toBeGreaterThan(400);
    // The cliff at x=25 is a 14-block step; max_slope=1 must refuse both of its sides.
    const gentle = planScatter(grid, opts({ maxSlope: 1 }));
    expect(gentle.rejectedSlope).toBeGreaterThan(0);
    for (const v of gentle.voxels) expect(v.x === 24 || v.x === 25).toBe(false);
  });

  it('is deterministic for a seed and different for another', () => {
    const grid = hillside();
    const key = (s: number) => planScatter(grid, opts({ density: 0.2, seed: s })).voxels.map((v) => `${v.x},${v.y},${v.z},${v.state}`);
    expect(key(3)).toEqual(key(3));
    expect(key(4)).not.toEqual(key(3));
  });

  it('honours density, spacing and max_count', () => {
    const grid = hillside();
    const dense = planScatter(grid, opts({ density: 0.5 }));
    const sparse = planScatter(grid, opts({ density: 0.05 }));
    expect(sparse.placements).toBeLessThan(dense.placements / 4);
    expect(planScatter(grid, opts({ maxCount: 12 })).placements).toBeLessThanOrEqual(12);
    const spaced = planScatter(grid, opts({ density: 1, spacing: 3 }));
    for (const a of spaced.voxels) {
      for (const c of spaced.voxels) {
        if (a === c || (a.x === c.x && a.z === c.z)) continue;
        expect(Math.max(Math.abs(a.x - c.x), Math.abs(a.z - c.z))).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('weights the palette', () => {
    const grid = hillside();
    const r = planScatter(grid, opts({ palette: [entry('poppy', 0, 9), entry('dandelion', 0, 1)] }));
    const set = scatterVoxelSet(r);
    const counts = set.counts();
    const poppies = counts.get('minecraft:poppy') ?? 0;
    const dandelions = counts.get('minecraft:dandelion') ?? 0;
    expect(poppies).toBeGreaterThan(dandelions * 4);
    expect(dandelions).toBeGreaterThan(0);
  });

  it('builds boulders that hug the slope and stay supported', () => {
    const grid = hillside();
    const r = planScatter(grid, opts({ palette: [entry('cobblestone', 2)], density: 0.05, spacing: 6 }));
    expect(r.placements).toBeGreaterThan(0);
    expect(r.voxels.length).toBeGreaterThan(r.placements * 5);
    expect(supportIssues(grid, r.voxels)).toEqual([]);
    // A boulder follows the ground rather than sitting on one flat level.
    const levels = new Set(r.voxels.map((v) => v.y));
    expect(levels.size).toBeGreaterThan(3);
  });

  it('does nothing with an empty palette or zero density', () => {
    const grid = hillside();
    expect(planScatter(grid, opts({ palette: [] })).voxels).toEqual([]);
    expect(planScatter(grid, opts({ density: 0 })).voxels).toEqual([]);
  });
});

describe('supportIssues', () => {
  it('catches a block placed in mid-air', () => {
    const grid = hillside();
    const floating = [{ x: 5, y: 80, z: 5, state: BlockState.parse('poppy') }];
    expect(supportIssues(grid, floating)).toEqual(floating);
  });
});
