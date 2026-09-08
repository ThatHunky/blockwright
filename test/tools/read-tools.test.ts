import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { BlockState } from '../../src/voxel/voxels.js';
import { MAX_VOXELS_ENV_VAR, DEFAULT_MAX_READ_VOLUME, DEFAULT_MAX_HEIGHTMAP_AREA } from '../../src/tools/read-tools.js';

let bridge: FakeBridge;
let client: Client;
let previewDir: string;
let schematicDir: string;
beforeEach(async () => {
  bridge = new FakeBridge();
  previewDir = await mkdtemp(path.join(tmpdir(), 'bw-prev-'));
  schematicDir = await mkdtemp(path.join(tmpdir(), 'bw-schem-'));
  client = await connect({ config: testConfig({ previewDir, schematicDir }), bridge });
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) bridge.world.set(x, 63, z, BlockState.parse('grass_block'));
});

const hut = { origin: [1, 64, 1], palette: { '#': 'stone_bricks' }, layers: [{ y: [0, 1], rows: ['###', '# #', '###'] }] };

describe('preview', () => {
  it('renders ASCII and writes HTML with context', async () => {
    const r = await call(client, 'preview', { build: hut, context: 1, title: 'Hut' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Layer y=64/);
    const m = /HTML preview written to (\S+)/.exec(r.text)!;
    expect(existsSync(m[1])).toBe(true);
    const html = await readFile(m[1], 'utf8');
    expect(html).toContain('<title>Hut</title>');
    expect(html).toContain('"minecraft:grass_block"');
    expect(html).toMatch(/"context":\[\[/);
  });
  it('previews shapes and schematics and requires exactly one input', async () => {
    const s = await call(client, 'preview', { shape: { shape: 'sphere', center: [0, 70, 0], radius: 1, block: 'glass' } });
    expect(s.text).toMatch(/19 blocks/);
    const none = await call(client, 'preview', {});
    expect(none.isError).toBe(true);
    const two = await call(client, 'preview', { build: hut, shape: { shape: 'sphere', center: [0, 70, 0], radius: 1, block: 'glass' } });
    expect(two.isError).toBe(true);
  });
  it('warns about invalid blocks but still previews', async () => {
    const r = await call(client, 'preview', { build: { ...hut, palette: { '#': 'stone_brick' } } });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Invalid block states/);
  });
  it('keeps the ASCII output when the HTML preview file cannot be written', async () => {
    // Point previewDir at a path that is a plain file, not a directory: fs.mkdir(previewDir,
    // {recursive:true}) then fails with ENOTDIR, giving a realistic, deterministic write
    // failure without mocking any internals.
    const blockedParent = await mkdtemp(path.join(tmpdir(), 'bw-prev-blocked-'));
    const blockedPreviewDir = path.join(blockedParent, 'not-a-directory');
    await writeFile(blockedPreviewDir, 'this occupies the path a directory would need');
    const badBridge = new FakeBridge();
    const badClient = await connect({ config: testConfig({ previewDir: blockedPreviewDir, schematicDir }), bridge: badBridge });
    const r = await call(badClient, 'preview', { build: hut, title: 'Hut' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Layer y=64/);
    expect(r.text).toMatch(/HTML preview could not be written/);
    expect(r.text).not.toMatch(/HTML preview written to/);
  });
});

describe('reading the world', () => {
  it('read_region, get_block and get_heightmap', async () => {
    await call(client, 'build', hut);
    const full = await call(client, 'read_region', { from: [1, 64, 1], to: [3, 65, 3] });
    expect(full.text).toMatch(/stone_bricks \(16\)/);
    expect(full.text).toMatch(/Layer y=64/);
    const big = await call(client, 'read_region', { from: [0, 0, 0], to: [40, 40, 40] });
    expect(big.text).not.toMatch(/Layer y=/);
    expect(big.text).toMatch(/full=true/);
    const one = await call(client, 'get_block', { pos: [1, 64, 1] });
    expect(one.text).toBe('minecraft:stone_bricks');
    const air = await call(client, 'get_block', { pos: [2, 64, 2] });
    expect(air.text).toBe('minecraft:air');
    const hm = await call(client, 'get_heightmap', { from: [0, 0], to: [3, 3] });
    expect(hm.text).toMatch(/surface y from 63 to 65/);
    expect(hm.text).toMatch(/stone_bricks/);
    expect(hm.text).toMatch(/65 65 65/);
  });
  it('still reads a normal-sized box exactly as before (small = full ASCII, larger = summary)', async () => {
    await call(client, 'build', hut);
    const small = await call(client, 'read_region', { from: [1, 64, 1], to: [3, 65, 3] });
    expect(small.isError).toBe(false);
    expect(small.text).toMatch(/Layer y=64/);
    expect(small.text).not.toMatch(/exceeds/);
    const moderate = await call(client, 'read_region', { from: [0, 0, 0], to: [40, 40, 40] });
    expect(moderate.isError).toBe(false);
    expect(moderate.text).not.toMatch(/Layer y=/);
    expect(moderate.text).toMatch(/blocks\. Counts:/);
    expect(moderate.text).not.toMatch(/exceeds/);
  });
  it('rejects an oversized read_region before touching the bridge, naming size, cap and env var', async () => {
    const originalRead = bridge.read.bind(bridge);
    bridge.read = async () => {
      throw new Error('read_region must not call bridge.read for an oversized box');
    };
    try {
      const from: [number, number, number] = [0, 0, 0];
      const to: [number, number, number] = [200, 200, 30];
      const volume = (to[0] - from[0] + 1) * (to[1] - from[1] + 1) * (to[2] - from[2] + 1);
      expect(volume).toBeGreaterThan(DEFAULT_MAX_READ_VOLUME);
      const r = await call(client, 'read_region', { from, to });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(volume.toLocaleString());
      expect(r.text).toContain(DEFAULT_MAX_READ_VOLUME.toLocaleString());
      expect(r.text).toContain(MAX_VOXELS_ENV_VAR);
    } finally {
      bridge.read = originalRead;
    }
  });
  it('rejects an oversized get_heightmap before touching the bridge, naming size, cap and env var', async () => {
    const originalHeightmap = bridge.heightmap.bind(bridge);
    bridge.heightmap = async () => {
      throw new Error('get_heightmap must not call bridge.heightmap for an oversized rectangle');
    };
    try {
      const from: [number, number] = [0, 0];
      const to: [number, number] = [3000, 2000];
      const area = (to[0] - from[0] + 1) * (to[1] - from[1] + 1);
      expect(area).toBeGreaterThan(DEFAULT_MAX_HEIGHTMAP_AREA);
      const r = await call(client, 'get_heightmap', { from, to });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(area.toLocaleString());
      expect(r.text).toContain(DEFAULT_MAX_HEIGHTMAP_AREA.toLocaleString());
      expect(r.text).toContain(MAX_VOXELS_ENV_VAR);
    } finally {
      bridge.heightmap = originalHeightmap;
    }
  });
  it('save_schematic writes the region', async () => {
    await call(client, 'build', hut);
    const r = await call(client, 'save_schematic', { from: [1, 64, 1], to: [3, 65, 3], path: 'saved' });
    expect(r.isError).toBe(false);
    expect(existsSync(path.join(schematicDir, 'saved.schem'))).toBe(true);
    const info = await call(client, 'schematic_info', { path: 'saved' });
    expect(JSON.parse(info.text).palette['minecraft:stone_bricks']).toBe(16);
  });
  it('undo restores snapshots newest first and list_snapshots shows them', async () => {
    await call(client, 'build', { ...hut, label: 'first' });
    await call(client, 'build', { ...hut, origin: [10, 64, 10], label: 'second' });
    const list = await call(client, 'list_snapshots');
    expect(JSON.parse(list.text).map((s: { label: string }) => s.label)).toEqual(['second', 'first']);
    const u = await call(client, 'undo');
    expect(u.text).toMatch(/Restored 1 snapshot/);
    expect(u.text).toMatch(/second/);
    expect(bridge.world.get(10, 64, 10)?.isAir).toBe(true);
    expect(bridge.world.get(1, 64, 1)?.toCommand()).toBe('stone_bricks');
    await call(client, 'undo', { steps: 5 });
    expect(bridge.world.get(1, 64, 1)?.isAir).toBe(true);
    const none = await call(client, 'undo');
    expect(none.isError).toBe(true);
  });
  it('undo reports per-snapshot outcomes when one restore fails partway through', async () => {
    await call(client, 'build', { ...hut, label: 'first' });
    await call(client, 'build', { ...hut, origin: [20, 64, 20], label: 'second' });
    const list = JSON.parse((await call(client, 'list_snapshots')).text) as Array<{ id: string; label: string }>;
    expect(list.map((s) => s.label)).toEqual(['second', 'first']);
    const failingId = list[0].id; // "second" — newest, so it is restored (and fails) first
    const originalRestore = bridge.restore.bind(bridge);
    bridge.restore = async (id: string) => {
      if (id === failingId) throw new Error('simulated restore failure');
      return originalRestore(id);
    };
    try {
      const r = await call(client, 'undo', { steps: 2 });
      // A partial success is not a total failure the model should blindly retry.
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/Restored 1 snapshot/);
      expect(r.text).toMatch(/first/);
      expect(r.text).toMatch(/Failed to restore 1 snapshot/);
      expect(r.text).toContain(failingId);
      expect(r.text).toMatch(/simulated restore failure/);
      // The successful restore ("first") actually happened...
      expect(bridge.world.get(1, 64, 1)?.isAir).toBe(true);
      // ...while the failed one ("second") is untouched and still present.
      expect(bridge.world.get(20, 64, 20)?.toCommand()).toBe('stone_bricks');
    } finally {
      bridge.restore = originalRestore;
    }
  });
});
