import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { terrainVoxels } from '../helpers/terrain.js';
import { BlockState, box } from '../../src/voxel/voxels.js';

const SITE = box([0, 55, 0], [30, 85, 30]);

/** A bridge with no region access, which answers the `execute if block … air` probe the way
 * vanilla does — the fallback path terraform takes when it cannot read the world. */
class ProbeBridge extends FakeBridge {
  constructor() {
    super();
    this.readable = false;
  }
  async runCommand(command: string): Promise<string> {
    const m = /if block (-?\d+) (-?\d+) (-?\d+) (\w+)/.exec(command);
    if (!m) return 'ok';
    const state = this.world.get(Number(m[1]), Number(m[2]), Number(m[3]));
    const name = state ? state.shortName : 'air';
    return name === m[4] ? 'Test passed, count: 1' : 'Test failed';
  }
}

let bridge: FakeBridge;
let client: Client;

function flatSite(b = SITE, height: (x: number, z: number) => number = () => 64, sea?: number): void {
  bridge.world.merge(terrainVoxels(b, { height, sea }));
}

beforeEach(async () => {
  bridge = new FakeBridge();
  client = await connect({ config: testConfig(), bridge });
});

describe('terraform', () => {
  const blend = { from: [0, 55, 0], to: [30, 85, 30], keep_from: [11, 11], keep_to: [19, 19], keep_y: 72 };

  it('dry run reports the plan and changes nothing', async () => {
    flatSite();
    const r = await call(client, 'terraform', { ...blend, dry_run: true });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/terraform blend: \d+ column\(s\) reshaped/);
    expect(r.text).toMatch(/Target ground height/);
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.get(5, 65, 5)?.toCommand()).toBe('air');
  });

  it('ramps the ground from the pad out to untouched terrain', async () => {
    flatSite();
    const r = await call(client, 'terraform', blend);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Snapshot snap1/);

    const surface = (x: number, z: number): number => {
      for (let y = 85; y >= 55; y--) {
        const s = bridge.world.get(x, y, z);
        if (s && !s.isAir) return y;
      }
      return -1;
    };
    // The border is still the real terrain, the pad is still the pad, and the way out from
    // the pad only ever descends and never steps more than a block.
    expect(surface(0, 15)).toBe(64);
    expect(surface(30, 15)).toBe(64);
    expect(surface(15, 15)).toBe(72); // keep_y levelled the pad
    let previous = 72;
    for (let x = 20; x <= 30; x++) {
      const here = surface(x, 15);
      expect(here).toBeLessThanOrEqual(previous);
      expect(previous - here).toBeLessThanOrEqual(1);
      previous = here;
    }
    expect(surface(21, 15)).toBeGreaterThan(64);
    expect(bridge.world.get(21, surface(21, 15), 15)?.toCommand()).toBe('grass_block');
    expect(bridge.world.get(21, surface(21, 15) - 1, 15)?.toCommand()).toBe('dirt');
    expect(bridge.world.get(21, surface(21, 15) - 4, 15)?.toCommand()).toBe('stone');
  });

  it('accepts a custom palette', async () => {
    flatSite();
    await call(client, 'terraform', { ...blend, top_block: 'podzol', soil_block: 'coarse_dirt', stone_block: 'andesite', soil_depth: 1 });
    let found = false;
    for (const [, s] of bridge.world.entries()) if (s.toCommand() === 'podzol') found = true;
    expect(found).toBe(true);
  });

  it('leaves protected columns alone', async () => {
    flatSite();
    await call(client, 'terraform', { ...blend, protect: [{ from: [24, 15], radius: 1 }] });
    for (let x = 23; x <= 25; x++) {
      for (let z = 14; z <= 16; z++) {
        expect(bridge.world.get(x, 64, z)?.toCommand()).toBe('grass_block');
        expect(bridge.world.get(x, 65, z)?.toCommand()).toBe('air');
      }
    }
  });

  it('keeps the pad exactly as it is when no keep_y is given', async () => {
    flatSite();
    const r = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], keep_from: [11, 11], keep_to: [19, 19], amplitude: 4 });
    expect(r.text).toMatch(/left exactly as they are/);
    for (let x = 11; x <= 19; x++) for (let z = 11; z <= 19; z++) expect(bridge.world.get(x, 65, z)?.toCommand()).toBe('air');
  });

  it('smooth and hill run on their own', async () => {
    flatSite(SITE, (x, z) => 64 + ((x * 7 + z * 13) % 5));
    const smooth = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], mode: 'smooth' });
    expect(smooth.isError).toBe(false);
    expect(smooth.text).toMatch(/terraform smooth/);

    bridge = new FakeBridge();
    client = await connect({ config: testConfig(), bridge });
    flatSite();
    const hill = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], mode: 'hill', max_step: 2 });
    expect(hill.isError).toBe(false);
    expect(hill.text).toMatch(/terraform hill/);
    let highest = 0;
    for (const [p, s] of bridge.world.entries()) if (!s.isAir && p[1] > highest) highest = p[1];
    expect(highest).toBeGreaterThan(64);
  });

  it('says so plainly when the ground already matches', async () => {
    flatSite();
    const r = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], mode: 'blend', amplitude: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/nothing to change/);
  });

  it('skips water unless asked', async () => {
    flatSite(SITE, (x) => (x < 10 ? 58 : 64), 62);
    const r = await call(client, 'terraform', { ...blend, keep_y: 70 });
    expect(r.text).toMatch(/water at the surface and were skipped/);
    expect(bridge.world.get(2, 62, 2)?.toCommand()).toBe('water');
  });

  it('refuses a box with no interior, a half-specified keep area, and a keep area outside the box', async () => {
    flatSite();
    const thin = await call(client, 'terraform', { from: [0, 55, 0], to: [1, 85, 30] });
    expect(thin.isError).toBe(true);
    expect(thin.text).toMatch(/at least 3 columns across/);

    const half = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], keep_from: [5, 5] });
    expect(half.isError).toBe(true);
    expect(half.text).toMatch(/both keep_from and keep_to/);

    const outside = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], keep_from: [200, 200], keep_to: [210, 210] });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/does not overlap the box/);

    const lonely = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], keep_y: 70 });
    expect(lonely.isError).toBe(true);
    expect(lonely.text).toMatch(/needs that pad/);

    const tooHigh = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30], keep_from: [11, 11], keep_to: [19, 19], keep_y: 120 });
    expect(tooHigh.isError).toBe(true);
    expect(tooHigh.text).toMatch(/outside the working y range/);
  });

  it('refuses a box bigger than the read limit', async () => {
    const before = process.env.BLOCKWRIGHT_MAX_VOXELS;
    process.env.BLOCKWRIGHT_MAX_VOXELS = '100';
    try {
      const r = await call(client, 'terraform', { from: [0, 55, 0], to: [30, 85, 30] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/exceeds the 20 block read limit/);
    } finally {
      if (before === undefined) delete process.env.BLOCKWRIGHT_MAX_VOXELS;
      else process.env.BLOCKWRIGHT_MAX_VOXELS = before;
    }
  });

  it('falls back to a console probe when the world cannot be read', async () => {
    bridge = new ProbeBridge();
    client = await connect({ config: testConfig(), bridge });
    const small = box([0, 60, 0], [14, 74, 14]);
    bridge.world.merge(terrainVoxels(small, { height: () => 64 }));
    const r = await call(client, 'terraform', { from: [0, 60, 0], to: [14, 74, 14], keep_from: [6, 6], keep_to: [8, 8], keep_y: 69, snapshot: false });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/command probe/);
    expect(r.text).toMatch(/undo will not work/);
    expect(bridge.world.get(7, 69, 7)?.toCommand()).toBe('grass_block');
  });
});

describe('scatter', () => {
  const meadow = { from: [0, 55, 0], to: [30, 85, 30], palette: [{ block: 'poppy' }, { block: 'short_grass' }], density: 0.3, seed: 5 };

  it('places plants on the ground and nowhere else', async () => {
    flatSite();
    const r = await call(client, 'scatter', meadow);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/scatter: \d+ placement\(s\)/);
    let placed = 0;
    for (const [p, s] of bridge.world.entries()) {
      if (s.shortName !== 'poppy' && s.shortName !== 'short_grass') continue;
      placed++;
      expect(p[1]).toBe(65);
      expect(bridge.world.get(p[0], p[1] - 1, p[2])?.toCommand()).toBe('grass_block');
    }
    expect(placed).toBeGreaterThan(100);
  });

  it('dry run changes nothing', async () => {
    flatSite();
    const r = await call(client, 'scatter', { ...meadow, dry_run: true });
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.get(5, 65, 5)?.toCommand()).toBe('air');
  });

  it('honours the on-list and reports when nothing qualifies', async () => {
    flatSite();
    const r = await call(client, 'scatter', { ...meadow, on: ['sand'] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/nothing placed/);
    expect(r.text).toMatch(/wrong ground block/);
  });

  it('refuses to guess where the ground is without world reads', async () => {
    bridge.readable = false;
    const r = await call(client, 'scatter', meadow);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs world read access/);
  });

  it('rejects an unknown block before touching the world', async () => {
    flatSite();
    const r = await call(client, 'scatter', { ...meadow, palette: [{ block: 'popy' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/poppy/);
    expect(bridge.world.get(5, 65, 5)?.toCommand()).toBe('air');
  });

  it('places boulders that rest on the slope', async () => {
    flatSite(SITE, (x) => 64 + Math.floor(x / 3));
    const r = await call(client, 'scatter', { from: [0, 55, 0], to: [30, 85, 30], palette: [{ block: 'mossy_cobblestone', radius: 2 }], density: 0.05, spacing: 5, seed: 2 });
    expect(r.isError).toBe(false);
    let rocks = 0;
    for (const [p, s] of bridge.world.entries()) {
      if (s.shortName !== 'mossy_cobblestone') continue;
      rocks++;
      const below = bridge.world.get(p[0], p[1] - 1, p[2]);
      expect(below && !below.isAir).toBe(true);
    }
    expect(rocks).toBeGreaterThan(5);
  });
});

describe('tool registration', () => {
  it('lists terraform and scatter with the other write tools', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('terraform');
    expect(tools).toContain('scatter');
    const terraform = (await client.listTools()).tools.find((t) => t.name === 'terraform')!;
    expect(terraform.description).toMatch(/dry_run=true/);
    expect(Object.keys(terraform.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['from', 'to', 'mode', 'keep_from', 'max_step', 'seed', 'dry_run', 'snapshot']));
  });
});

describe('BlockState sanity for the terrain palette', () => {
  it('parses the defaults the tools use', () => {
    for (const name of ['grass_block', 'dirt', 'stone', 'podzol', 'coarse_dirt']) expect(BlockState.parse(name).shortName).toBe(name);
  });
});
