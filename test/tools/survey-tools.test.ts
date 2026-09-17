import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { terrainVoxels } from '../helpers/terrain.js';
import { BlockState, box } from '../../src/voxel/voxels.js';

let bridge: FakeBridge;
let client: Client;

beforeEach(async () => {
  bridge = new FakeBridge();
  client = await connect({ config: testConfig(), bridge });
  // Grass at y=64, with a 1-block rise from x=10 and a slab halfway up at x=5.
  bridge.world.merge(terrainVoxels(box([0, 58, 0], [31, 72, 31]), { height: (x) => (x < 10 ? 64 : 65) }));
  bridge.world.set(5, 65, 8, BlockState.parse('oak_slab[type=bottom]'));
});

describe('survey tools', () => {
  it('are listed', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['walk', 'profile', 'slope']) expect(names).toContain(n);
  });

  it('walk reports each step with coordinates', async () => {
    const r = await call(client, 'walk', { path: [[0, 65, 4], [14, 66, 4]] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^walk overworld: 15 cells from \(0, 4\) to \(14, 4\) through 2 point\(s\); max_step 0.6, headroom 2\./);
    expect(r.text).toMatch(/step_up +\(10, 4\) +65 → 66: \+1 \(a jump; max_step 0.6\)/);

    const smooth = await call(client, 'walk', { path: [[0, 8], [9, 8]], max_step: 1 });
    expect(smooth.text).toMatch(/Problems: none/);
    expect(smooth.text).toMatch(/65.5 +oak_slab +\+0.5/);
  });

  it('profile takes a path or a from/to line, and not both', async () => {
    const r = await call(client, 'profile', { from: [0, 4], to: [14, 4], width: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/total rise \+1, total fall -0/);
    expect(r.text).toMatch(/across \(left → right\)/);
    const both = await call(client, 'profile', { path: [[0, 0], [3, 0]], from: [0, 0], to: [3, 0] });
    expect(both.isError).toBe(true);
    const neither = await call(client, 'profile', {});
    expect(neither.isError).toBe(true);
    expect(neither.text).toMatch(/needs a path, or both from and to/);
  });

  it('slope draws the step grid and refuses an oversized box', async () => {
    const r = await call(client, 'slope', { from: [0, 0], to: [15, 15] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/z=     4 \|\.\.\.\.\.\.\.\.\.11\.\.\.\.\./);
    expect(r.text).toMatch(/Cliffs \(connected steps of 1.5\+ blocks\): none/);

    const big = await call(client, 'slope', { from: [0, 0], to: [1000, 1000] });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/column limit/);
  });

  it('refuse without world reads and cap path length', async () => {
    const long = await call(client, 'walk', { path: [[0, 0], [5000, 0]] });
    expect(long.isError).toBe(true);
    expect(long.text).toMatch(/over the 4,096 cell limit/);
    bridge.readable = false;
    for (const [tool, args] of [['walk', { path: [[0, 0]] }], ['profile', { from: [0, 0], to: [1, 0] }], ['slope', { from: [0, 0], to: [1, 1] }]] as const) {
      const r = await call(client, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/needs world read access/);
    }
  });
});
