import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { promises as fs } from 'node:fs';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { terrainVoxels } from '../helpers/terrain.js';
import { BlockState, box } from '../../src/voxel/voxels.js';
import type { Config } from '../../src/config.js';

const SITE = box([0, 55, 0], [24, 80, 24]);
let bridge: FakeBridge;
let client: Client;
let config: Config;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeEach(async () => {
  bridge = new FakeBridge();
  config = testConfig();
  bridge.world.merge(terrainVoxels(SITE, { height: () => 64 }));
  client = await connect({ config, bridge });
});

describe('render', () => {
  it('returns a PNG inline and writes it to disk', async () => {
    const r = await call(client, 'render', { from: [0, 60, 0], to: [20, 70, 20], views: ['iso_se'] });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].mimeType).toBe('image/png');
    expect(r.images[0].bytes.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    const file = /→ (\S+\.png)/.exec(r.text)?.[1];
    expect(file).toBeTruthy();
    const onDisk = await fs.readFile(file as string);
    expect(onDisk.equals(r.images[0].bytes)).toBe(true);
  });

  it('returns one image per requested view', async () => {
    const r = await call(client, 'render', { from: [0, 60, 0], to: [12, 68, 12], views: ['iso_ne', 'iso_sw', 'top'] });
    expect(r.images).toHaveLength(3);
    expect(r.text).toContain('iso_ne');
    expect(r.text).toContain('iso_sw');
    expect(r.text).toContain('top');
  });

  it('refuses more views than it will draw', async () => {
    const r = await call(client, 'render', {
      from: [0, 60, 0], to: [4, 64, 4],
      views: ['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'top'],
    });
    expect(r.isError).toBe(true);
  });

  it('needs somewhere to look', async () => {
    const r = await call(client, 'render', { views: ['top'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/from\+to/);
  });

  it('refuses a box larger than the read cap', async () => {
    const r = await call(client, 'render', { from: [0, -64, 0], to: [900, 319, 900] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/over the .* limit/);
  });

  it('says so when the region has no world access', async () => {
    bridge.readable = false;
    const r = await call(client, 'render', { from: [0, 60, 0], to: [4, 64, 4] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read access/);
  });

  it('reports an empty region instead of writing a blank image', async () => {
    const r = await call(client, 'render', { from: [0, 200, 0], to: [4, 210, 4] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/air or hidden|empty/);
  });

  it('hides blocks on request', async () => {
    bridge.world.set(5, 65, 5, BlockState.parse('oak_leaves'));
    const shown = await call(client, 'render', { from: [0, 60, 0], to: [10, 70, 10], views: ['top'] });
    const hidden = await call(client, 'render', { from: [0, 60, 0], to: [10, 70, 10], views: ['top'], hide: ['*_leaves'] });
    expect(shown.images[0].bytes.equals(hidden.images[0].bytes)).toBe(false);
  });

  it('rejects a malformed background', async () => {
    const r = await call(client, 'render', { from: [0, 60, 0], to: [4, 66, 4], background: 'blue' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/three numbers/);
  });

  it('reports the box it drew', async () => {
    const r = await call(client, 'render', { from: [0, 60, 0], to: [8, 68, 8], views: ['top'] });
    expect(r.text).toContain('overworld');
    expect(r.text).toMatch(/visible blocks/);
  });
});
