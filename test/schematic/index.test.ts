import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { detectFormat, loadClipboard, saveClipboard, resolveSchematicPath } from '../../src/schematic/index.js';
import { writeStructure } from '../../src/schematic/structure.js';
import { writeSponge3 } from '../../src/schematic/sponge.js';
import { T, writeNbtGz } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);
function sample() {
  const v = new VoxelSet();
  v.set(0, 0, 0, st('stone'));
  v.set(1, 0, 0, st('dirt'));
  return clipboardFromVoxels(v, 4903);
}

describe('format detection and IO', () => {
  it('detects formats', () => {
    expect(detectFormat(writeSponge3(sample()))).toBe('sponge');
    expect(detectFormat(writeStructure(sample()))).toBe('structure');
    expect(detectFormat(T.comp({ Version: T.int(2), Palette: T.comp({}) }, 'Schematic'))).toBe('sponge');
    expect(detectFormat(T.comp({ foo: T.int(1) }, ''))).toBeUndefined();
  });
  it('saves and loads both formats by extension', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    for (const name of ['a.schem', 'b.nbt']) {
      const p = path.join(dir, name);
      await saveClipboard(sample(), p);
      const back = await loadClipboard(p);
      expect(back.voxels.get(1, 0, 0)?.toCommand()).toBe('dirt');
      expect(back.source).toBe(name.endsWith('.nbt') ? 'structure' : 'sponge');
    }
    await writeFile(path.join(dir, 'junk.schem'), writeNbtGz(T.comp({ foo: T.int(1) }, '')));
    await expect(loadClipboard(path.join(dir, 'junk.schem'))).rejects.toThrow(/not a Sponge schematic or vanilla structure/);
  });
  it('resolves relative paths and probes extensions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
    await saveClipboard(sample(), path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('house', dir)).toBe(path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('house.schem', dir)).toBe(path.join(dir, 'house.schem'));
    expect(resolveSchematicPath('/abs/x.nbt', dir)).toBe('/abs/x.nbt');
    expect(resolveSchematicPath('new', dir, true)).toBe(path.join(dir, 'new.schem'));
  });

  describe('containment', () => {
    it('rejects a relative read path that escapes the schematic directory', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
      expect(() => resolveSchematicPath('../../../etc/passwd', dir)).toThrow(/escapes schematic directory/);
      expect(() => resolveSchematicPath('..', dir)).toThrow(/escapes schematic directory/);
    });

    it('rejects a relative write path that escapes the schematic directory', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
      expect(() => resolveSchematicPath('../evil', dir, true)).toThrow(/escapes schematic directory/);
    });

    it('is not fooled by a sibling directory that is a string prefix of the schematic dir name', async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'bw-'));
      const dir = path.join(parent, 'schematics');
      const sibling = path.join(parent, 'schematics-other');
      await mkdir(dir, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(sibling, 'secret.schem'), 'nope');
      expect(() => resolveSchematicPath('../schematics-other/secret.schem', dir)).toThrow(/escapes schematic directory/);
    });

    it('allows a legitimate nested relative path, including into a not-yet-created subdirectory', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
      await mkdir(path.join(dir, 'sub'), { recursive: true });
      await saveClipboard(sample(), path.join(dir, 'sub', 'nested.schem'));
      expect(resolveSchematicPath('sub/nested', dir)).toBe(path.join(dir, 'sub', 'nested.schem'));
      expect(resolveSchematicPath('sub/nested.schem', dir)).toBe(path.join(dir, 'sub', 'nested.schem'));
      // "brandnew" subdirectory does not exist yet; the containment check must still work
      // by walking up to the nearest existing ancestor rather than requiring the target exist.
      expect(resolveSchematicPath('brandnew/house', dir, true)).toBe(path.join(dir, 'brandnew', 'house.schem'));
    });

    it('still resolves absolute paths untouched, bypassing the containment check', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
      expect(resolveSchematicPath('/etc/passwd', dir)).toBe('/etc/passwd');
      expect(resolveSchematicPath('/abs/new', dir, true)).toBe('/abs/new.schem');
    });

    it('rejects an escape hidden behind a symlink inside the schematic directory', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'bw-'));
      const outside = await mkdtemp(path.join(tmpdir(), 'bw-outside-'));
      await writeFile(path.join(outside, 'secret.schem'), 'top secret');
      await symlink(outside, path.join(dir, 'link'));
      expect(() => resolveSchematicPath('link/secret', dir)).toThrow(/escapes schematic directory/);
      expect(() => resolveSchematicPath('link/secret.schem', dir, true)).toThrow(/escapes schematic directory/);
    });
  });
});
