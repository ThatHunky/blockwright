import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RconClient } from '../../src/rcon/client.js';
import { RconBridge } from '../../src/bridge/rcon-bridge.js';
import { BoundsError, NeedsReadError } from '../../src/bridge/errors.js';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { resolveWorld } from '../../src/world/dimension.js';
import { FakeRcon } from '../helpers/fake-rcon.js';
import { testConfig } from '../helpers/config.js';
import { fakeServerDir, flatChunk } from '../helpers/server-dir.js';

const st = (s: string) => BlockState.parse(s);
const UUID = '11111111-2222-3333-4444-555555555555';

function vanillaHandler(cmd: string): string {
  if (cmd === 'list') return 'There are 1 of a max of 20 players online: Steve';
  if (cmd === 'list uuids') return `There are 1 of a max of 20 players online: Steve (${UUID})`;
  if (cmd.endsWith('Pos')) return 'Steve has the following entity data: [10.5d, 64.0d, -3.2d]';
  if (cmd.endsWith('Rotation')) return 'Steve has the following entity data: [90.0f, 10.0f]';
  if (cmd.endsWith('Dimension')) return 'Steve has the following entity data: "minecraft:the_nether"';
  if (cmd.endsWith('playerGameType')) return 'Steve has the following entity data: 1';
  if (cmd === 'save-all flush') return 'Saving the game (this may take a moment!)Saved the game';
  if (cmd.startsWith('forceload')) return 'Marked chunk [0, 0] in minecraft:overworld to be force loaded';
  if (cmd.includes('obsidian')) return 'No blocks were filled';
  if (cmd.startsWith('fill') || cmd.startsWith('execute')) return 'Successfully filled 8 blocks';
  if (cmd.startsWith('setblock')) return 'Changed the block at 0, 0, 0';
  if (cmd.startsWith('place template')) return `Loaded template "${cmd.split(' ')[2]}" at 0, 0, 0`;
  return '';
}

let fake: FakeRcon;
let rcon: RconClient;
let clock = 1_000_000;
const now = () => clock;

beforeEach(async () => {
  fake = new FakeRcon();
  fake.handler = vanillaHandler;
  await fake.start();
  rcon = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
});
afterEach(async () => {
  await rcon.close();
  await fake.stop();
});

const overworld = resolveWorld('overworld', 'world');

function cube(block: string): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) v.set(x, y + 64, z, st(block));
  return v;
}

describe('info and players', () => {
  it('parses list and entity data', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const info = await bridge.info();
    expect(info).toMatchObject({ tier: 1, playersOnline: 1, maxPlayers: 20, players: ['Steve'], canRead: false });
    expect(info.notes[0]).toMatch(/BLOCKWRIGHT_SERVER_DIR/);
    const players = await bridge.players();
    expect(players).toEqual([{ name: 'Steve', uuid: UUID, world: 'minecraft:the_nether', pos: [10, 64, -4], yaw: 90, pitch: 10, gamemode: 'creative' }]);
  });
});

describe('apply over commands', () => {
  it('forceloads, runs commands in order, and captures errors', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const set = cube('stone');
    set.set(5, 64, 5, st('obsidian'));
    const r = await bridge.apply(set, { world: overworld, snapshot: false });
    expect(fake.commands[0]).toBe('forceload add 0 0 15 15');
    expect(fake.commands[1]).toBe('fill 0 64 0 1 65 1 stone');
    expect(fake.commands[2]).toBe('setblock 5 64 5 obsidian');
    expect(fake.commands[3]).toBe('forceload remove 0 0 15 15');
    expect(r).toMatchObject({ method: 'commands', blocks: 9, commands: 2, failed: 1, dryRun: false });
    expect(r.errors[0]).toMatch(/obsidian → No blocks were filled/);
  });
  it('prefixes the dimension and sends nothing on dry run', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const dry = await bridge.apply(cube('stone'), { world: resolveWorld('nether', 'world'), dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.sample[0]).toBe('execute in minecraft:the_nether run fill 0 64 0 1 65 1 stone');
    expect(fake.commands).toEqual([]);
  });
  it('refuses writes outside bounds', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig({ bounds: { min: [100, 0, 100], max: [200, 100, 200] } }), now });
    await expect(bridge.apply(cube('stone'), { world: overworld })).rejects.toBeInstanceOf(BoundsError);
    expect(fake.commands).toEqual([]);
  });
  it('runs raw commands through applyCommands', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const r = await bridge.applyCommands(['fill 0 64 0 3 64 3 dirt keep'], { min: [0, 64, 0], max: [3, 64, 3] }, 16, { world: overworld, snapshot: false });
    expect(r.failed).toBe(0);
    expect(fake.commands[1]).toBe('fill 0 64 0 3 64 3 dirt keep');
  });
  it('releases the forceload even when a command throws', async () => {
    const throwing = {
      send: (cmd: string) => (cmd.startsWith('fill') ? Promise.reject(new Error('boom')) : rcon.send(cmd)),
      close: () => rcon.close(),
    };
    const bridge = new RconBridge({ rcon: throwing, config: testConfig(), now });
    await expect(bridge.apply(cube('stone'), { world: overworld, snapshot: false })).rejects.toThrow(/boom/);
    expect(fake.commands[0]).toBe('forceload add 0 0 15 15');
    expect(fake.commands[fake.commands.length - 1]).toBe('forceload remove 0 0 15 15');
  });
});

describe('structure path', () => {
  it('writes template pieces and places them', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir, structureThreshold: 0, templateMax: 48 }), now });
    const r = await bridge.apply(cube('stone'), { world: overworld, snapshot: false });
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    const files = readdirSync(dir).filter((f) => f.startsWith('paste_'));
    expect(files).toHaveLength(1);
    const place = fake.commands.find((c) => c.startsWith('place template'))!;
    expect(place).toMatch(/^place template blockwright:paste_\w+_0 0 64 0$/);
    expect(r).toMatchObject({ method: 'structure', failed: 0, commands: 1, blocks: 8 });
  });
});

describe('read, snapshot, restore', () => {
  it('needs a server dir', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    await expect(bridge.read({ min: [0, 60, 0], max: [1, 61, 1] }, overworld)).rejects.toBeInstanceOf(NeedsReadError);
  });
  it('coalesces save-all and reads blocks and heightmaps', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const r1 = await bridge.read({ min: [4, 62, 6], max: [6, 64, 8] }, overworld);
    expect(r1.voxels.get(5, 63, 7)?.toCommand()).toBe('grass_block[snowy=false]');
    expect(r1.voxels.get(5, 64, 7)?.isAir).toBe(true);
    await bridge.read({ min: [0, 62, 0], max: [1, 62, 1] }, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(1);
    clock += 60_000;
    const hm = await bridge.heightmap(4, 6, 6, 8, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(2);
    expect(hm.heights[1][1]).toBe(63);
    expect(hm.surface[1][1]).toBe('grass_block[snowy=false]');
    expect(hm.heights[0][0]).toBe(62);
    await bridge.apply(cube('stone'), { world: overworld, snapshot: false });
    await bridge.read({ min: [0, 62, 0], max: [1, 62, 1] }, overworld);
    expect(fake.commands.filter((c) => c === 'save-all flush')).toHaveLength(3);
  });
  it('snapshots before a write and restores', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const r = await bridge.apply(cube('stone'), { world: overworld, label: 'test cube' });
    expect(r.snapshotId).toBeDefined();
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    expect(existsSync(path.join(dir, 'snapshots.json'))).toBe(true);
    const snaps = await bridge.listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: r.snapshotId, world: 'overworld', box: { min: [0, 64, 0], max: [1, 65, 1] }, label: 'test cube' });
    expect(existsSync(path.join(dir, `${snaps[0].pieces[0].name}.nbt`))).toBe(true);
    const before = fake.commands.length;
    const res = await bridge.restore(r.snapshotId!);
    expect(res.restored).toBe(1);
    expect(fake.commands.slice(before)).toEqual(['forceload add 0 0 15 15', `place template blockwright:${snaps[0].pieces[0].name} 0 64 0`, 'forceload remove 0 0 15 15']);
    expect(await bridge.listSnapshots()).toHaveLength(0);
    expect(existsSync(path.join(dir, `${snaps[0].pieces[0].name}.nbt`))).toBe(false);
    await expect(bridge.restore('nope')).rejects.toThrow(/no snapshot/);
  });
});
