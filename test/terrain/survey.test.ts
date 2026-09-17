import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet, box } from '../../src/voxel/voxels.js';
import { footing, stairHalfStep } from '../../src/terrain/footing.js';
import { gridLine, pathCells, pointsFromTuples } from '../../src/terrain/path.js';
import { ChunkCache, groundAt, type WorldReader } from '../../src/terrain/sampler.js';
import { analyzeWalk, formatWalk, type WalkOptions } from '../../src/terrain/walk.js';
import { analyzeProfile, formatProfile } from '../../src/terrain/profile.js';
import { buildSlopeGrid, findCliffs, formatSlope } from '../../src/terrain/slope.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { terrainVoxels } from '../helpers/terrain.js';

const S = (text: string): BlockState => BlockState.parse(text);
const OPTS: WalkOptions = { maxStep: 0.6, headroom: 2 };

/** A reader over an in-memory world, optionally with chunks that "are not generated". */
function readerFor(world: VoxelSet, missing: Set<string> = new Set()): WorldReader & { reads: number } {
  const bridge = new FakeBridge();
  bridge.world = world;
  const isMissing = (x: number, z: number): boolean => missing.has(`${x >> 4},${z >> 4}`);
  return {
    reads: 0,
    async read(b) {
      this.reads++;
      if (isMissing(b.min[0], b.min[2])) return { voxels: new VoxelSet(), missingChunks: 1 };
      return bridge.read(b);
    },
    async heightmap(minX, minZ, maxX, maxZ) {
      if (isMissing(minX, minZ)) return { heights: [[null]] };
      return bridge.heightmap(minX, minZ, maxX, maxZ);
    },
  };
}

/** Flat grass at y=64 (stand height 65) over x/z 0..47, stone below. */
function flat(height: (x: number, z: number) => number = () => 64, sea?: number): VoxelSet {
  return terrainVoxels(box([0, 58, 0], [47, 72, 47]), { height, sea });
}

async function walk(world: VoxelSet, tuples: number[][], opts: WalkOptions = OPTS) {
  const cache = new ChunkCache(readerFor(world));
  return analyzeWalk(cache, pathCells(pointsFromTuples(tuples)), opts);
}

describe('footing', () => {
  it('uses the collision top of each block', () => {
    expect(footing(S('grass_block'))).toEqual({ kind: 'floor', top: 1 });
    expect(footing(S('dirt_path')).top).toBe(15 / 16);
    expect(footing(S('farmland')).top).toBe(15 / 16);
    expect(footing(S('oak_slab[type=bottom]')).top).toBe(0.5);
    expect(footing(S('oak_slab[type=top]')).top).toBe(1);
    expect(footing(S('oak_slab[type=double]')).top).toBe(1);
    expect(footing(S('oak_stairs[facing=north,half=bottom]')).top).toBe(1);
    expect(footing(S('white_carpet')).top).toBe(1 / 16);
    expect(footing(S('snow[layers=4]')).top).toBe(3 / 8);
  });

  it('walks through plants and wall fixtures, and treats leaves, fences and walls as obstacles', () => {
    for (const b of ['air', 'short_grass', 'poppy', 'torch', 'wall_torch[facing=north]', 'leaf_litter', 'pink_petals', 'oak_sign', 'snow[layers=1]', 'stone_button']) {
      expect(footing(S(b)).kind, b).toBe('pass');
    }
    expect(footing(S('oak_leaves'))).toEqual({ kind: 'obstacle', top: 1 });
    expect(footing(S('oak_fence'))).toEqual({ kind: 'obstacle', top: 1.5 });
    expect(footing(S('cobblestone_wall')).kind).toBe('obstacle');
    expect(footing(S('oak_fence_gate[open=true]')).kind).toBe('pass');
    expect(footing(S('water')).kind).toBe('water');
    expect(footing(S('seagrass')).kind).toBe('water');
  });

  it('gives a stair its half step from every side but its back', () => {
    const stair = S('oak_stairs[facing=north,half=bottom]');
    expect(stairHalfStep(stair, 0, -1)).toBe(true); // walking north, up the stair
    expect(stairHalfStep(stair, 1, 0)).toBe(true);
    expect(stairHalfStep(stair, 0, 1)).toBe(false); // walking south into its tall back
    expect(stairHalfStep(S('oak_stairs[facing=north,half=top]'), 0, -1)).toBe(false);
  });
});

describe('path', () => {
  it('draws 4-connected lines that hug the straight line', () => {
    const line = gridLine(0, 0, 5, -3);
    expect(line).toHaveLength(5 + 3 + 1);
    expect(line[0]).toEqual([0, 0]);
    expect(line[line.length - 1]).toEqual([5, -3]);
    for (let i = 1; i < line.length; i++) {
      expect(Math.abs(line[i][0] - line[i - 1][0]) + Math.abs(line[i][1] - line[i - 1][1])).toBe(1);
      // Never strays more than a block from the ideal line.
      const [x, z] = line[i];
      expect(Math.abs(3 * x + 5 * z) / Math.hypot(3, 5)).toBeLessThan(1);
    }
  });

  it('joins segments without repeating the vertex and interpolates y and distance', () => {
    const cells = pathCells(pointsFromTuples([[0, 70, 0], [4, 74, 0], [4, 74, 3]]));
    expect(cells.map((c) => [c.x, c.z])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3]]);
    expect(cells.map((c) => c.y)).toEqual([70, 71, 72, 73, 74, 74, 74, 74]);
    expect(cells[7].dist).toBe(7);
    expect(pathCells(pointsFromTuples([[3, 9]]))).toEqual([{ x: 3, z: 9, y: undefined, segment: 0, dist: 0 }]);
  });
});

describe('ChunkCache', () => {
  it('reads a chunk at a time and gives the same answers with a one-chunk cache', async () => {
    const world = flat((x) => 64 + Math.floor(x / 8));
    const big = new ChunkCache(readerFor(world));
    const tiny = new ChunkCache(readerFor(world), 1);
    const path = pathCells(pointsFromTuples([[0, 5], [47, 5], [47, 40], [0, 40]]));
    const a = await analyzeWalk(big, path, OPTS);
    const b = await analyzeWalk(tiny, path, OPTS);
    expect(b.cells).toEqual(a.cells);
    expect(a.cells.find((c) => c.x === 40 && c.z === 5)?.stand).toBe(70);
  });

  it('reports ungenerated chunks as unknown', async () => {
    const cache = new ChunkCache(readerFor(flat(), new Set(['1,0'])));
    expect((await groundAt(cache, 3, 3)).ground).toBe(64);
    expect((await groundAt(cache, 20, 3)).known).toBe(false);
    const r = await analyzeWalk(cache, pathCells(pointsFromTuples([[14, 3], [18, 3]])), OPTS);
    expect(r.problems.map((p) => p.kind)).toEqual(['ungenerated', 'ungenerated', 'ungenerated']);
  });
});

describe('walk', () => {
  it('reads exact standing heights and passes a path of slabs and dirt_path', async () => {
    const world = flat();
    // A path climbing east: dirt_path, then a bottom slab, a full block, another slab, a block.
    world.set(1, 64, 5, S('dirt_path'));
    world.set(2, 65, 5, S('oak_slab[type=bottom]'));
    world.set(3, 65, 5, S('stone'));
    world.set(4, 66, 5, S('oak_slab[type=bottom]'));
    world.set(5, 66, 5, S('stone'));
    world.set(5, 65, 5, S('stone'));
    world.set(4, 65, 5, S('stone'));
    for (let x = 6; x <= 8; x++) for (let y = 65; y <= 66; y++) world.set(x, y, 5, S('stone'));
    world.set(0, 65, 5, S('poppy'));
    const r = await walk(world, [[0, 5], [8, 5]]);
    expect(r.cells.map((c) => c.stand)).toEqual([65, 64.9375, 65.5, 66, 66.5, 67, 67, 67, 67]);
    expect(r.cells[0].surface).toBe('grass_block');
    expect(r.problems).toEqual([]);
    expect(r.maxUp?.dh).toBe(0.5625);
    const text = formatWalk(r, OPTS, 'walk');
    expect(text).toMatch(/Problems: none/);
    expect(text).toMatch(/… 2 more at the same height and surface, through \(7, 5\)/);
  });

  it('flags a full-block step, a fall and the coordinates of each', async () => {
    const world = flat((x) => (x < 5 ? 64 : x < 10 ? 65 : 60));
    const r = await walk(world, [[0, 5], [12, 5]]);
    expect(r.problems.map((p) => [p.kind, p.x, p.z])).toEqual([['step_up', 5, 5], ['fall', 10, 5]]);
    expect(r.problems[0].detail).toMatch(/\+1 \(a jump; max_step 0.6\)/);
    const text = formatWalk(r, OPTS, 'walk');
    expect(text).toMatch(/Problems \(2\): step_up 1, fall 1, no_floor 0, water 0, headroom 0, obstacle 0/);
    expect(text).toMatch(/step_up +\(5, 5\)/);
  });

  it('climbs stairs as half steps from the front but not into their back', async () => {
    const world = flat();
    // Stairs rising east: facing=east means the tall back is on the east side.
    for (let i = 0; i < 4; i++) {
      for (let y = 65; y < 65 + i; y++) world.set(2 + i, y, 5, S('stone'));
      world.set(2 + i, 65 + i, 5, S('oak_stairs[facing=east,half=bottom]'));
    }
    const up = await walk(world, [[0, 5], [5, 5]]);
    expect(up.cells.map((c) => c.stand)).toEqual([65, 65, 66, 67, 68, 69]);
    expect(up.problems).toEqual([]);
    expect(up.cells[3].flags).toContain('stairs');

    const back = flat();
    for (let y = 65; y <= 65; y++) back.set(5, y, 5, S('oak_stairs[facing=west,half=bottom]'));
    const r = await walk(back, [[3, 5], [6, 5]]);
    expect(r.problems.map((p) => p.kind)).toEqual(['step_up']);
  });

  it('reports fences and leaves as obstacles, a low ceiling as headroom, and water', async () => {
    const world = flat(() => 64, undefined);
    world.set(3, 65, 5, S('oak_fence'));
    world.set(6, 66, 5, S('oak_leaves'));
    world.set(9, 66, 5, S('stone'));
    for (let x = 12; x <= 13; x++) {
      world.set(x, 64, 5, S('water'));
      world.set(x, 63, 5, S('sand'));
    }
    const r = await walk(world, [[0, 64, 5], [15, 64, 5]].map(([x, y, z]) => [x, y + 1, z]));
    const kinds = r.problems.map((p) => `${p.kind}@${p.x}`);
    expect(kinds).toContain('obstacle@3');
    expect(kinds).toContain('obstacle@6');
    expect(kinds).toContain('headroom@9');
    expect(kinds).toContain('water@12');
    expect(kinds).toContain('water@13');
  });

  it('follows a given y onto a bridge deck or under it, and reports empty air as no floor', async () => {
    const world = flat();
    for (let x = 2; x <= 8; x++) world.set(x, 70, 5, S('spruce_planks'));
    const deck = await walk(world, [[2, 71, 5], [8, 71, 5]]);
    expect(deck.cells.every((c) => c.stand === 71)).toBe(true);
    const under = await walk(world, [[2, 65, 5], [8, 65, 5]]);
    expect(under.cells.every((c) => c.stand === 65)).toBe(true);
    expect(under.problems).toEqual([]);
    const highest = await walk(world, [[5, 5]]);
    expect(highest.cells[0].stand).toBe(71);

    const empty = await walk(new VoxelSet(), [[100, 64, 100]]);
    expect(empty.problems.map((p) => p.kind)).toEqual(['no_floor']);
  });
});

describe('walk without heights', () => {
  it('stops at the ground under a tree trunk instead of diving into a cave below it', async () => {
    const world = flat();
    for (let y = 65; y <= 70; y++) world.set(4, y, 5, S('oak_log'));
    for (let x = 3; x <= 5; x++) for (let z = 4; z <= 6; z++) world.set(x, 71, z, S('oak_leaves'));
    world.set(3, 70, 5, S('lantern[hanging=true]'));
    for (let y = 59; y <= 61; y++) for (let x = 0; x <= 8; x++) world.set(x, y, 5, S('cave_air'));
    const r = await walk(world, [[1, 5], [7, 5]]);
    expect(r.cells.map((c) => c.stand)).toEqual([65, 65, 65, 65, 65, 65, 65]);
    expect(r.problems.map((p) => `${p.kind}@${p.x}`)).toEqual(['obstacle@4']);
    expect(r.problems[0].detail).toMatch(/oak_log at y=65/);
  });
});

describe('profile', () => {
  it('reports ground along a ramp, ignoring a tree, with grades and a chart', async () => {
    const world = flat((x) => 64 + Math.floor(x / 2));
    for (let y = 68; y <= 72; y++) world.set(6, y, 5, S('oak_log'));
    world.set(6, 73, 5, S('oak_leaves'));
    world.set(3, 66, 5, S('short_grass'));
    const points = [{ x: 0, z: 5 }, { x: 12, z: 5 }];
    const cache = new ChunkCache(readerFor(world));
    const r = await analyzeProfile(cache, pathCells(points), points, 0);
    expect(r.samples.map((s) => s.ground)).toEqual([64, 64, 65, 65, 66, 66, 67, 67, 68, 68, 69, 69, 70]);
    expect(r.samples[6].canopy).toBe(73);
    expect(r.rise).toBe(6);
    expect(r.fall).toBe(0);
    expect(r.grades.map((g) => [g.cells, g.rise])).toEqual([[1, 1], [3, 2], [10, 5]]);
    const text = formatProfile(r, 0, 'profile');
    expect(text).toMatch(/Trees over the line \(ignored for ground\): \(6, 5\)–\(6, 5\) 1 cell\(s\), canopy up to y=73/);
    expect(text).toMatch(/total rise \+6, total fall -0, net \+6/);
    expect(text).toMatch(/Elevation:/);
    expect(text).toMatch(/70 \|            #/);
  });

  it('shows a trench in the cross-section and water along the line', async () => {
    const world = flat((x, z) => (z === 5 ? 62 : 64), 62);
    for (let x = 0; x <= 47; x++) world.set(x, 62, 5, S('dirt_path'));
    const points = [{ x: 2, z: 5 }, { x: 6, z: 5 }];
    const cache = new ChunkCache(readerFor(world));
    const r = await analyzeProfile(cache, pathCells(points), points, 2);
    expect(r.samples[0].cross).toEqual([65, 65, 62.9375, 65, 65]);
    const text = formatProfile(r, 2, 'profile');
    expect(text).toMatch(/across \(left → right\): \+2.06 \+2.06 \[62.9375\] \+2.06 \+2.06/);

    const wet = flat((x) => (x < 5 ? 60 : 64), 62);
    const w = await analyzeProfile(new ChunkCache(readerFor(wet)), pathCells(points), points, 0);
    expect(w.samples[0].water).toBe(62);
    expect(formatProfile(w, 0, 'p')).toMatch(/Water: \(2, 5\)–\(4, 5\) 3 cell\(s\), surface y=62/);
  });
});

describe('slope', () => {
  it('draws level ground, half steps, cliffs and water', async () => {
    const world = flat((x) => (x < 10 ? 64 : 67), 64);
    for (let z = 0; z <= 47; z++) world.set(4, 65, z, S('stone_slab[type=bottom]'));
    for (let x = 14; x <= 16; x++) for (let z = 14; z <= 16; z++) world.set(x, 67, z, S('water'));
    const cache = new ChunkCache(readerFor(world));
    const g = await buildSlopeGrid(cache, 0, 0, 20, 20);
    const text = formatSlope(g, 1, 'slope');
    const row = text.split('\n').find((l) => l.includes('z=    10 |'))!;
    expect(row).toBe('  z=    10 |...:::...33..........');
    expect(text.split('\n').find((l) => l.includes('z=    15 |'))).toBe('  z=    15 |...:::...33...~~~....');
    const cliffs = findCliffs(g);
    expect(cliffs).toHaveLength(1);
    expect(cliffs[0]).toMatchObject({ minX: 9, maxX: 10, minZ: 0, maxZ: 20, step: 3, height: 3, cells: 42 });
    expect(text).toMatch(/Cliffs \(connected steps of 1.5\+ blocks\): 1/);
    expect(text).toMatch(/length 21, 42 column\(s\), height 3/);
    expect(text).toMatch(/water 2.0%/);
  });

  it('samples down to the steepest column in each block of the grid', async () => {
    const world = flat((x, z) => (x === 7 && z === 7 ? 70 : 64));
    const g = await buildSlopeGrid(new ChunkCache(readerFor(world)), 0, 0, 15, 15);
    const text = formatSlope(g, 4, 'slope');
    expect(text).toMatch(/Each character covers 4×4 columns/);
    expect(text.split('\n').find((l) => l.includes('z=     4 |'))).toBe('  z=     4 |.66.');
    expect(text).toMatch(/cut off on all sides \(every neighbour 1.5\+ away\): 1 column/);
  });
});
