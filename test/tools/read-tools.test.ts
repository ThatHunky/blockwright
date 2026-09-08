import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { BlockState } from '../../src/voxel/voxels.js';

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
});
