import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
});
