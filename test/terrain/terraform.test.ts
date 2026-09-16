import { describe, it, expect } from 'vitest';
import { BlockState, box, type Box } from '../../src/voxel/voxels.js';
import { CELL_AIR, CELL_CANOPY, CELL_GROUND, CELL_PLANT, CELL_WATER, classifyBlock, columnsFromVoxels } from '../../src/terrain/columns.js';
import { modeDefaults, planColumn, planTerrain, terraformVoxels, type TerraformPlanInput } from '../../src/terrain/terraform.js';
import { terrainVoxels } from '../helpers/terrain.js';

const PALETTE = { top: BlockState.parse('grass_block'), soil: BlockState.parse('dirt'), stone: BlockState.parse('stone') };

/** Column categories for a plain stone-under-dirt-under-grass column at `ground`. */
function plainColumn(ground: number) {
  return (y: number) => (y <= ground ? CELL_GROUND : CELL_AIR);
}

describe('classifyBlock', () => {
  it('separates ground from cover, trees and water', () => {
    expect(classifyBlock(BlockState.parse('air'))).toBe(CELL_AIR);
    expect(classifyBlock(BlockState.parse('water'))).toBe(CELL_WATER);
    expect(classifyBlock(BlockState.parse('short_grass'))).toBe(CELL_PLANT);
    expect(classifyBlock(BlockState.parse('poppy'))).toBe(CELL_PLANT);
    expect(classifyBlock(BlockState.parse('oak_sapling'))).toBe(CELL_PLANT);
    expect(classifyBlock(BlockState.parse('snow[layers=3]'))).toBe(CELL_PLANT);
    expect(classifyBlock(BlockState.parse('oak_log[axis=y]'))).toBe(CELL_CANOPY);
    expect(classifyBlock(BlockState.parse('birch_leaves'))).toBe(CELL_CANOPY);
    expect(classifyBlock(BlockState.parse('grass_block'))).toBe(CELL_GROUND);
    expect(classifyBlock(BlockState.parse('stone'))).toBe(CELL_GROUND);
  });
});

describe('columnsFromVoxels', () => {
  const b: Box = box([0, 50, 0], [7, 90, 7]);

  it('puts the surface under a tree on the ground, not in the canopy', () => {
    const voxels = terrainVoxels(b, {
      height: () => 64,
      decorate: (x, z, g, set) => {
        if (x !== 3 || z !== 3) return;
        for (let y = g + 1; y <= g + 5; y++) set.set(x, y, z, BlockState.parse('oak_log[axis=y]'));
        set.set(x, g + 6, z, BlockState.parse('oak_leaves'));
      },
    });
    const grid = columnsFromVoxels(voxels, b);
    const i = 3 * grid.w + 3;
    expect(grid.ground[i]).toBe(64);
    expect(grid.groundBlock[i]).toBe('grass_block');
    expect(grid.top[i]).toBe(70);
    expect(grid.water[i]).toBe(0);
  });

  it('flags a column with water over its ground', () => {
    const voxels = terrainVoxels(b, { height: (x) => (x < 4 ? 58 : 64), sea: 62 });
    const grid = columnsFromVoxels(voxels, b);
    expect(grid.water[0 * grid.w + 1]).toBe(1);
    expect(grid.ground[0 * grid.w + 1]).toBe(58);
    expect(grid.water[0 * grid.w + 6]).toBe(0);
  });

  it('marks columns the read never covered as unknown', () => {
    const voxels = terrainVoxels(box([2, 50, 2], [5, 90, 5]), { height: () => 64 });
    const grid = columnsFromVoxels(voxels, b);
    expect(grid.known[0]).toBe(0);
    expect(grid.known[3 * grid.w + 3]).toBe(1);
  });
});

describe('planColumn', () => {
  it('lays grass, then soil, then stone down to the old ground when raising', () => {
    const edits = planColumn({ target: 70, ground: 64, top: 64, yMin: 50, yMax: 90, category: plainColumn(64), soilDepth: 3 });
    expect(edits).toEqual([
      { y: 70, kind: 'top' },
      { y: 69, kind: 'soil' },
      { y: 68, kind: 'soil' },
      { y: 67, kind: 'soil' },
      { y: 66, kind: 'stone' },
      { y: 65, kind: 'stone' },
    ]);
  });

  it('carves everything above the new surface when lowering, and never digs into existing stone', () => {
    const category = (y: number): 0 | 2 | 3 | 4 => (y <= 70 ? CELL_GROUND : y === 71 ? CELL_PLANT : y === 72 ? CELL_CANOPY : CELL_AIR);
    const edits = planColumn({ target: 64, ground: 70, top: 72, yMin: 50, yMax: 90, category, soilDepth: 3 });
    const air = edits.filter((e) => e.kind === 'air').map((e) => e.y);
    expect(air).toEqual([72, 71, 70, 69, 68, 67, 66, 65]);
    expect(edits.filter((e) => e.kind !== 'air')).toEqual([
      { y: 64, kind: 'top' },
      { y: 63, kind: 'soil' },
      { y: 62, kind: 'soil' },
      { y: 61, kind: 'soil' },
    ]);
    expect(edits.some((e) => e.kind === 'stone')).toBe(false);
  });

  it('leaves a column that is already at its target completely alone', () => {
    expect(planColumn({ target: 64, ground: 64, top: 68, yMin: 50, yMax: 90, category: plainColumn(64), soilDepth: 3 })).toEqual([]);
  });

  it('stops pouring stone at the first solid block, so caves survive', () => {
    // Air pocket at 60-62 under ground at 63; raising to 68 fills the gap above 63 and stops
    // there, so the cave underneath is still a cave afterwards.
    const category = (y: number): 0 | 4 => (y >= 60 && y <= 62 ? CELL_AIR : y <= 63 ? CELL_GROUND : CELL_AIR);
    const edits = planColumn({ target: 68, ground: 63, top: 63, yMin: 50, yMax: 90, category, soilDepth: 2 });
    expect(edits.filter((e) => e.kind === 'stone').map((e) => e.y)).toEqual([65, 64]);
    expect(edits.every((e) => e.y > 63)).toBe(true);
  });

  it('bounds how far it will pour stone into a void', () => {
    const edits = planColumn({ target: 70, ground: 40, top: 40, yMin: 0, yMax: 90, category: () => CELL_AIR, soilDepth: 3, maxUnderfill: 4 });
    const stone = edits.filter((e) => e.kind === 'stone').map((e) => e.y);
    expect(stone[0]).toBe(66);
    expect(stone[stone.length - 1]).toBe(36);
  });

  it('honours soil_depth 0', () => {
    const edits = planColumn({ target: 66, ground: 64, top: 64, yMin: 50, yMax: 90, category: plainColumn(64), soilDepth: 0 });
    expect(edits).toEqual([
      { y: 66, kind: 'top' },
      { y: 65, kind: 'stone' },
    ]);
  });
});

function baseInput(grid: ReturnType<typeof columnsFromVoxels>, overrides: Partial<TerraformPlanInput> = {}): TerraformPlanInput {
  const d = modeDefaults('blend', grid.w, grid.h);
  return {
    grid,
    mode: 'blend',
    keep: new Uint8Array(grid.w * grid.h),
    protect: new Uint8Array(grid.w * grid.h),
    seed: 7,
    amplitude: d.amplitude,
    wavelength: 32,
    octaves: 4,
    noiseFade: d.noiseFade,
    blur: d.blur,
    maxStep: 1,
    smoothPasses: 24,
    ...overrides,
  };
}

/** A flat 41x41 site at y=60 with a 11x11 pad in the middle. */
function padSite(keepY?: number) {
  const b = box([0, 50, 0], [40, 90, 40]);
  const grid = columnsFromVoxels(terrainVoxels(b, { height: () => 60 }), b);
  const keep = new Uint8Array(grid.w * grid.h);
  for (let z = 15; z <= 25; z++) for (let x = 15; x <= 25; x++) keep[z * grid.w + x] = 1;
  return { b, grid, keep, keepY };
}

describe('planTerrain blend', () => {
  it('keeps the border at the real terrain height and the pad at its own', () => {
    const { grid, keep } = padSite();
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70 }));
    for (let xi = 0; xi < grid.w; xi++) {
      expect(plan.target[xi]).toBe(60);
      expect(plan.target[(grid.h - 1) * grid.w + xi]).toBe(60);
    }
    expect(plan.target[20 * grid.w + 20]).toBe(70);
    expect(plan.frozen[20 * grid.w + 20]).toBe(1);
    // keep_y names a pad to level, so the pad columns are built, not skipped.
    expect(plan.skip[20 * grid.w + 20]).toBe(0);
    expect(plan.frozen[0]).toBe(1);

    // Without a keep_y the same area is frozen AND left alone entirely.
    const untouched = planTerrain(baseInput(grid, { keep }));
    expect(untouched.skip[20 * grid.w + 20]).toBe(1);
    expect(untouched.target[20 * grid.w + 20]).toBe(60);
  });

  it('descends monotonically from the pad to the border: no terraces, no rings', () => {
    const { grid, keep } = padSite();
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70, amplitude: 0, blur: 0 }));
    let previous = plan.target[20 * grid.w + 25];
    for (let xi = 26; xi < grid.w; xi++) {
      const here = plan.target[20 * grid.w + xi];
      expect(here).toBeLessThanOrEqual(previous);
      previous = here;
    }
    expect(previous).toBe(60);
  });

  it('is walkable: nothing it shaped steps more than max_step', () => {
    const { grid, keep } = padSite();
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70 }));
    expect(plan.steepFreePairs).toBe(0);
    for (const step of [1, 2]) {
      const p = planTerrain(baseInput(grid, { keep, keepHeight: 70, maxStep: step }));
      expect(p.steepFreePairs).toBe(0);
    }
  });

  it('is deterministic for a seed and different for another', () => {
    const { grid, keep } = padSite();
    const a = planTerrain(baseInput(grid, { keep, keepHeight: 70, seed: 1 }));
    const b = planTerrain(baseInput(grid, { keep, keepHeight: 70, seed: 1 }));
    const c = planTerrain(baseInput(grid, { keep, keepHeight: 70, seed: 2 }));
    expect([...b.target]).toEqual([...a.target]);
    expect([...c.target]).not.toEqual([...a.target]);
  });

  it('adds noise that fades to nothing at the pad edge and the border', () => {
    const { grid, keep } = padSite();
    const flat = planTerrain(baseInput(grid, { keep, keepHeight: 70, amplitude: 0, blur: 0 }));
    const rough = planTerrain(baseInput(grid, { keep, keepHeight: 70, amplitude: 6, blur: 0 }));
    // Immediately outside the pad the two agree; further out in the slope they do not.
    expect(rough.target[20 * grid.w + 26]).toBe(flat.target[20 * grid.w + 26]);
    let differences = 0;
    for (let i = 0; i < grid.w * grid.h; i++) if (rough.target[i] !== flat.target[i]) differences++;
    expect(differences).toBeGreaterThan(50);
  });

  it('freezes protected columns and leaves them out of the work', () => {
    const { grid, keep } = padSite();
    const protect = new Uint8Array(grid.w * grid.h);
    protect[30 * grid.w + 30] = 1;
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70, protect }));
    expect(plan.skip[30 * grid.w + 30]).toBe(1);
    expect(plan.target[30 * grid.w + 30]).toBe(60);
  });
});

describe('planTerrain smooth and hill', () => {
  it('smooth softens roughness while keeping the overall shape', () => {
    const b = box([0, 50, 0], [30, 90, 30]);
    const height = (x: number, z: number) => 64 + Math.round(6 * Math.sin(x / 5)) + (((x * 7 + z * 13) % 5) - 2);
    const grid = columnsFromVoxels(terrainVoxels(b, { height }), b);
    const plan = planTerrain(baseInput(grid, { mode: 'smooth', amplitude: 0, smoothPasses: 40 }));
    let before = 0;
    let after = 0;
    for (let zi = 1; zi < grid.h - 1; zi++) {
      for (let xi = 1; xi < grid.w - 2; xi++) {
        const i = zi * grid.w + xi;
        before += Math.abs(grid.ground[i] - grid.ground[i + 1]);
        after += Math.abs(plan.target[i] - plan.target[i + 1]);
      }
    }
    expect(after).toBeLessThan(before * 0.6);
    // The big sine is still there: the middle is not flattened to one level.
    const row = Array.from({ length: grid.w }, (_, xi) => plan.target[15 * grid.w + xi]);
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(6);
  });

  it('hill raises ground in the middle and leaves the border alone', () => {
    const b = box([0, 50, 0], [40, 90, 40]);
    const grid = columnsFromVoxels(terrainVoxels(b, { height: () => 64 }), b);
    const d = modeDefaults('hill', grid.w, grid.h);
    const plan = planTerrain(baseInput(grid, { mode: 'hill', amplitude: d.amplitude, noiseFade: d.noiseFade, maxStep: 2 }));
    expect(plan.target[20 * grid.w + 20]).toBeGreaterThan(66);
    expect(plan.target[0]).toBe(64);
    for (let i = 0; i < grid.w * grid.h; i++) expect(plan.target[i]).toBeGreaterThanOrEqual(64);
    expect(plan.lowered).toBe(0);
  });
});

describe('terraformVoxels', () => {
  it('lays grass over dirt over stone and leaves deeper stone alone', () => {
    const { b, grid, keep } = padSite();
    const world = terrainVoxels(b, { height: () => 60 });
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70, amplitude: 0, blur: 0 }));
    const r = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: false, blockAt: (x, y, z) => world.get(x, y, z) });
    // A column part-way down the ramp, raised above the old ground.
    const xi = 27;
    const zi = 20;
    const t = plan.target[zi * grid.w + xi];
    expect(t).toBeGreaterThan(60);
    expect(r.set.get(xi, t, zi)?.toCommand()).toBe('grass_block');
    expect(r.set.get(xi, t - 1, zi)?.toCommand()).toBe('dirt');
    expect(r.set.get(xi, t - 3, zi)?.toCommand()).toBe('dirt');
    expect(r.set.get(xi, t - 4, zi)?.toCommand()).toBe('stone');
    // Below the old surface nothing was touched: that stone is already there.
    expect(r.set.get(xi, 56, zi)).toBeUndefined();
    expect(r.set.get(xi, 50, zi)).toBeUndefined();
  });

  it('leaves the border and an unlevelled keep area completely alone', () => {
    const { b, grid, keep } = padSite();
    const world = terrainVoxels(b, { height: () => 60 });
    const plan = planTerrain(baseInput(grid, { keep, amplitude: 4 }));
    const r = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: false, blockAt: (x, y, z) => world.get(x, y, z) });
    for (let y = 50; y <= 90; y++) {
      expect(r.set.get(20, y, 20)).toBeUndefined();
      expect(r.set.get(0, y, 0)).toBeUndefined();
      expect(r.set.get(40, y, 40)).toBeUndefined();
    }
    expect(r.columns).toBeGreaterThan(100);
  });

  it('levels the pad itself when keep_y names a height', () => {
    const { b, grid, keep } = padSite();
    const world = terrainVoxels(b, { height: () => 60 });
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70 }));
    const r = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: false, blockAt: (x, y, z) => world.get(x, y, z) });
    for (let z = 15; z <= 25; z++) {
      for (let x = 15; x <= 25; x++) {
        expect(r.set.get(x, 70, z)?.toCommand()).toBe('grass_block');
        expect(r.set.get(x, 69, z)?.toCommand()).toBe('dirt');
        expect(r.set.get(x, 71, z)).toBeUndefined();
      }
    }
    for (let y = 50; y <= 90; y++) expect(r.set.get(0, y, 0)).toBeUndefined();
  });

  it('skips water columns unless include_water is set', () => {
    const b = box([0, 50, 0], [30, 90, 30]);
    const world = terrainVoxels(b, { height: (x) => (x < 10 ? 56 : 64), sea: 62 });
    const grid = columnsFromVoxels(world, b);
    const keep = new Uint8Array(grid.w * grid.h);
    for (let z = 12; z <= 18; z++) for (let x = 20; x <= 26; x++) keep[z * grid.w + x] = 1;
    const plan = planTerrain(baseInput(grid, { keep, keepHeight: 70 }));
    const dry = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: false, blockAt: (x, y, z) => world.get(x, y, z) });
    const wet = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: true, blockAt: (x, y, z) => world.get(x, y, z) });
    expect(dry.skippedWater).toBeGreaterThan(0);
    expect(wet.skippedWater).toBe(0);
    expect(wet.set.size).toBeGreaterThan(dry.set.size);
    expect(dry.set.get(3, 60, 3)).toBeUndefined();
  });

  it('emits nothing at all when the ground already matches the plan', () => {
    const b = box([0, 50, 0], [20, 90, 20]);
    const world = terrainVoxels(b, { height: () => 64 });
    const grid = columnsFromVoxels(world, b);
    const plan = planTerrain(baseInput(grid, { amplitude: 0, blur: 0 }));
    const r = terraformVoxels(grid, plan, PALETTE, { soilDepth: 3, includeWater: false, blockAt: (x, y, z) => world.get(x, y, z) });
    expect(r.set.size).toBe(0);
  });
});
