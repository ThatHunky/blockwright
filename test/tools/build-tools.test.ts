import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';

let bridge: FakeBridge;
let client: Client;
let schematicDir: string;
beforeEach(async () => {
  bridge = new FakeBridge();
  schematicDir = await mkdtemp(path.join(tmpdir(), 'bw-schem-'));
  client = await connect({ config: testConfig({ schematicDir }), bridge });
});

const hut = {
  origin: [100, 64, 200],
  palette: { '#': 'stone_bricks', s: 'oak_stairs[facing=north]' },
  layers: [
    { y: 0, rows: ['###', '###', '###'] },
    { y: 1, rows: ['s  ', '   ', '   '] },
  ],
};

describe('build', () => {
  it('places blocks and reports a snapshot', async () => {
    const r = await call(client, 'build', hut);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/build: 10 blocks/);
    expect(r.text).toMatch(/Snapshot snap1/);
    expect(bridge.world.get(102, 64, 202)?.toCommand()).toBe('stone_bricks');
    expect(bridge.world.get(100, 65, 200)?.props.facing).toBe('north');
  });
  it('rotates about the min corner', async () => {
    await call(client, 'build', { ...hut, rotation: 90 });
    expect(bridge.world.get(102, 65, 200)?.props.facing).toBe('east');
    expect(bridge.world.bounds()!.min).toEqual([100, 64, 200]);
  });
  it('reports spec errors and validation errors', async () => {
    const bad = await call(client, 'build', { origin: [0, 0, 0], palette: { '#': 'stone' }, layers: [{ y: 0, rows: ['#Q'] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/character "Q"/);
    const typo = await call(client, 'build', { origin: [0, 0, 0], palette: { '#': 'stone_brick' }, layers: [{ y: 0, rows: ['#'] }] });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/stone_bricks/);
  });
  it('dry run changes nothing', async () => {
    const r = await call(client, 'build', { ...hut, dry_run: true });
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.size).toBe(0);
  });
});

describe('place_shape', () => {
  it('places a sphere', async () => {
    const r = await call(client, 'place_shape', { shape: 'sphere', center: [0, 70, 0], radius: 2, block: 'glass' });
    expect(r.isError).toBe(false);
    expect(bridge.world.size).toBe(81);
  });
  it('reports missing fields', async () => {
    const r = await call(client, 'place_shape', { shape: 'cylinder', base: [0, 70, 0], radius: 2, block: 'glass' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cylinder needs height/);
  });
});

describe('schematics', () => {
  it('writes, inspects and pastes', async () => {
    const w = await call(client, 'schematic_write', { path: 'hut', build: { ...hut, origin: [0, 0, 0] } });
    expect(w.isError).toBe(false);
    expect(existsSync(path.join(schematicDir, 'hut.schem'))).toBe(true);
    const info = await call(client, 'schematic_info', { path: 'hut' });
    const parsed = JSON.parse(info.text);
    expect(parsed.size).toEqual([3, 2, 3]);
    expect(parsed.format).toBe('sponge');
    expect(parsed.palette['minecraft:stone_bricks']).toBe(9);
    expect(parsed.palette['minecraft:air']).toBe(8);
    const p = await call(client, 'paste_schematic', { path: 'hut', origin: [10, 60, 10], ignore_air: true });
    expect(p.isError).toBe(false);
    expect(bridge.world.size).toBe(10);
    expect(bridge.world.get(10, 61, 10)?.props.facing).toBe('north');
    const withAir = await call(client, 'paste_schematic', { path: 'hut', origin: [50, 60, 50], rotation: 180 });
    expect(withAir.isError).toBe(false);
    expect(bridge.world.get(52, 61, 52)?.props.facing).toBe('south');
    expect(bridge.world.get(50, 61, 50)?.isAir).toBe(true);
  });
  it('reports missing files', async () => {
    const r = await call(client, 'paste_schematic', { path: 'nope', origin: [0, 0, 0] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nope/);
  });
});
