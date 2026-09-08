import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorld, resolveRegionDir, regionDirCandidates } from '../../src/world/dimension.js';

describe('resolveWorld', () => {
  it('maps aliases', () => {
    expect(resolveWorld(undefined, 'world')).toEqual({ label: 'overworld', dimension: 'minecraft:overworld', bukkitName: 'world' });
    expect(resolveWorld('nether', 'world')).toEqual({ label: 'nether', dimension: 'minecraft:the_nether', bukkitName: 'world_nether' });
    expect(resolveWorld('minecraft:the_end', 'matsuri')).toEqual({ label: 'end', dimension: 'minecraft:the_end', bukkitName: 'matsuri_the_end' });
    expect(resolveWorld('matsuri_nether', 'matsuri').label).toBe('nether');
    expect(() => resolveWorld('moon', 'world')).toThrow(/Unknown world "moon"/);
  });
});

describe('region directories', () => {
  it('prefers the 26.x layout and falls back to legacy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    const modern = path.join(dir, 'world', 'dimensions', 'minecraft', 'the_nether', 'region');
    const legacy = path.join(dir, 'world_nether', 'DIM-1', 'region');
    expect(regionDirCandidates(dir, 'world', 'nether')).toEqual([modern, legacy]);
    expect(resolveRegionDir(dir, 'world', 'nether')).toBeUndefined();
    await mkdir(legacy, { recursive: true });
    expect(resolveRegionDir(dir, 'world', 'nether')).toBe(legacy);
    await mkdir(modern, { recursive: true });
    expect(resolveRegionDir(dir, 'world', 'nether')).toBe(modern);
    expect(regionDirCandidates(dir, 'world', 'overworld')[1]).toBe(path.join(dir, 'world', 'region'));
    expect(regionDirCandidates(dir, 'world', 'end')[1]).toBe(path.join(dir, 'world_the_end', 'DIM1', 'region'));
  });
});
