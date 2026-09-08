import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, parseProperties, parseBounds, describeConfig, readLevelVersion } from '../src/config.js';
import { T, writeNbtGz } from '../src/nbt/nbt.js';

async function fakeServer(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bw-srv-'));
  await writeFile(path.join(dir, 'server.properties'), '#comment\nrcon.port=25599\nrcon.password=pw123\nlevel-name=matsuri\nenable-rcon=true\n');
  await mkdir(path.join(dir, 'matsuri'), { recursive: true });
  const level = T.comp({ Data: T.comp({ DataVersion: T.int(4903), Version: T.comp({ Name: T.string('26.2'), Id: T.int(4903) }) }) }, '');
  await writeFile(path.join(dir, 'matsuri', 'level.dat'), writeNbtGz(level));
  await mkdir(path.join(dir, 'plugins', 'WorldEdit', 'schematics'), { recursive: true });
  return dir;
}

describe('parsers', () => {
  it('parses properties and bounds', () => {
    expect(parseProperties('a=1\n# c\nb = two\n')).toEqual({ a: '1', b: 'two' });
    expect(parseBounds('10,2,30,1,20,3')).toEqual({ min: [1, 2, 3], max: [10, 20, 30] });
    expect(() => parseBounds('1,2,3')).toThrow(/BLOCKWRIGHT_BOUNDS/);
  });

  it('rejects bounds with an empty field instead of silently treating it as 0', () => {
    // A trailing comma splits into 6 elements with the last one empty; Number('') is 0,
    // which is a valid integer, so this used to silently move an edge of the fence to 0.
    expect(() => parseBounds('1,2,3,4,5,')).toThrow(/BLOCKWRIGHT_BOUNDS/);
    // An internal doubled comma is the same failure mode in the middle of the list.
    expect(() => parseBounds('1,2,,4,5,6')).toThrow(/BLOCKWRIGHT_BOUNDS/);
    // A whitespace-only field trims down to empty too.
    expect(() => parseBounds('1,2, ,4,5,6')).toThrow(/BLOCKWRIGHT_BOUNDS/);
  });
});

describe('loadConfig', () => {
  it('reads the server folder', async () => {
    const dir = await fakeServer();
    const c = await loadConfig({ BLOCKWRIGHT_SERVER_DIR: dir });
    expect(c.rcon).toEqual({ host: '127.0.0.1', port: 25599, password: 'pw123' });
    expect(c.levelName).toBe('matsuri');
    expect(c.dataVersion).toBe(4903);
    expect(c.mcVersion).toBe('26.2');
    expect(c.schematicDir).toBe(path.join(dir, 'plugins', 'WorldEdit', 'schematics'));
    expect(c.fillLimit).toBe(32768);
    expect(c.structureThreshold).toBe(400);
    expect(c.templateMax).toBe(48);
    expect(c.allowAdmin).toBe(false);
    expect(JSON.stringify(describeConfig(c))).not.toContain('pw123');
  });
  it('lets env override files and validates', async () => {
    const dir = await fakeServer();
    const c = await loadConfig({
      BLOCKWRIGHT_SERVER_DIR: dir,
      BLOCKWRIGHT_RCON_PASSWORD: 'override',
      BLOCKWRIGHT_RCON_PORT: '1234',
      BLOCKWRIGHT_BOUNDS: '0,0,0,100,100,100',
      BLOCKWRIGHT_FILL_LIMIT: '1000',
      BLOCKWRIGHT_ALLOW_ADMIN: '1',
      BLOCKWRIGHT_SCHEMATIC_DIR: '/tmp/schems',
    });
    expect(c.rcon.password).toBe('override');
    expect(c.rcon.port).toBe(1234);
    expect(c.bounds).toEqual({ min: [0, 0, 0], max: [100, 100, 100] });
    expect(c.fillLimit).toBe(1000);
    expect(c.allowAdmin).toBe(true);
    expect(c.schematicDir).toBe('/tmp/schems');
  });
  it('works without a server dir and requires a password', async () => {
    const c = await loadConfig({ BLOCKWRIGHT_RCON_PASSWORD: 'x' });
    expect(c.serverDir).toBeUndefined();
    expect(c.levelName).toBe('world');
    expect(c.dataVersion).toBe(4903);
    await expect(loadConfig({})).rejects.toThrow(/RCON password/);
    await expect(loadConfig({ BLOCKWRIGHT_SERVER_DIR: '/nonexistent/dir' })).rejects.toThrow(/BLOCKWRIGHT_SERVER_DIR/);
  });

  it('rejects non-integer values for integer env vars, including fractions', async () => {
    // intEnv used to only check Number.isFinite, so a fractional value like "1.5" passed
    // straight through despite the name promising an integer.
    await expect(loadConfig({ BLOCKWRIGHT_RCON_PASSWORD: 'x', BLOCKWRIGHT_FILL_LIMIT: '1.5' })).rejects.toThrow(
      /BLOCKWRIGHT_FILL_LIMIT must be an integer/,
    );
    await expect(loadConfig({ BLOCKWRIGHT_RCON_PASSWORD: 'x', BLOCKWRIGHT_RCON_PORT: '1234.7' })).rejects.toThrow(
      /BLOCKWRIGHT_RCON_PORT must be an integer/,
    );
    await expect(loadConfig({ BLOCKWRIGHT_RCON_PASSWORD: 'x', BLOCKWRIGHT_TEMPLATE_MAX: 'nope' })).rejects.toThrow(
      /BLOCKWRIGHT_TEMPLATE_MAX must be an integer/,
    );
  });

  it('validates a malformed rcon.port from server.properties instead of yielding NaN', async () => {
    const dir = await fakeServer();
    const propsPath = path.join(dir, 'server.properties');
    await writeFile(propsPath, '#comment\nrcon.port=twenty-five-five-nine-nine\nrcon.password=pw123\nlevel-name=matsuri\n');
    await expect(loadConfig({ BLOCKWRIGHT_SERVER_DIR: dir })).rejects.toThrow(/rcon\.port must be an integer/);
    // The error names the offending file.
    await expect(loadConfig({ BLOCKWRIGHT_SERVER_DIR: dir })).rejects.toThrow(new RegExp(propsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // An env override still takes precedence and bypasses the bad file value.
    const c = await loadConfig({ BLOCKWRIGHT_SERVER_DIR: dir, BLOCKWRIGHT_RCON_PORT: '25599' });
    expect(c.rcon.port).toBe(25599);
  });
});

describe('readLevelVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quietly returns undefined when level.dat is simply absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-lv-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await readLevelVersion(path.join(dir, 'does-not-exist', 'level.dat'));
    expect(result).toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('warns on stderr and falls back when level.dat is present but corrupt', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-lv-'));
    const levelDat = path.join(dir, 'level.dat');
    // Truncated garbage: not valid gzip/NBT at all.
    await writeFile(levelDat, Buffer.from([0x1f, 0x8b, 0x01, 0x02, 0x03]));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await readLevelVersion(levelDat);
    expect(result).toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);
    const [warning] = stderr.mock.calls[0] as [string];
    expect(warning).toContain(levelDat);
  });
});
