import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RconClient } from '../../src/rcon/client.js';
import { RconBridge } from '../../src/bridge/rcon-bridge.js';
import { BoundsError, NeedsReadError } from '../../src/bridge/errors.js';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { resolveWorld } from '../../src/world/dimension.js';
import { FakeRcon } from '../helpers/fake-rcon.js';
import { testConfig } from '../helpers/config.js';
import { fakeServerDir, flatChunk } from '../helpers/server-dir.js';
import { formatApplyResult } from '../../src/tools/result.js';
import type { BlockEntity } from '../../src/schematic/clipboard.js';
import { readStructure } from '../../src/schematic/structure.js';
import { parseNbt, T } from '../../src/nbt/nbt.js';

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
  // Real vanilla no-op: fill/setblock asked to place a block that is already there. Not a
  // failure — see NOOP_RE in rcon-bridge.ts.
  if (cmd.includes('obsidian')) return 'No blocks were filled';
  // Real vanilla genuine failure, for tests that need one that is unambiguously an error.
  if (cmd.includes('bad_block')) return "Unknown block type 'minecraft:bad_block'";
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

function cubeAt(block: string, x0: number, y0: number, z0: number): VoxelSet {
  const v = new VoxelSet();
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) v.set(x0 + x, y0 + y + 64, z0 + z, st(block));
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
  it('forceloads, runs commands in order, and captures a genuine failure', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const set = cube('stone');
    set.set(5, 64, 5, st('bad_block'));
    const r = await bridge.apply(set, { world: overworld, snapshot: false });
    expect(fake.commands[0]).toBe('forceload add 0 0 15 15');
    expect(fake.commands[1]).toBe('fill 0 64 0 1 65 1 stone');
    expect(fake.commands[2]).toBe('setblock 5 64 5 bad_block');
    expect(fake.commands[3]).toBe('forceload remove 0 0 15 15');
    expect(r).toMatchObject({ method: 'commands', blocks: 9, commands: 2, failed: 1, noop: 0, dryRun: false });
    expect(r.errors[0]).toMatch(/bad_block → Unknown block type/);
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

// Regression tests for the defect: RconBridge classified "No blocks were filled" /
// "Could not set the block" as failures via ERROR_RE, but vanilla returns both whenever a
// fill/setblock is asked to place a block that is already there — a routine outcome (air
// interiors, rebuilding over existing terrain, levelling already-level ground), not an
// error. An AI reading a false "1 command(s) failed" may try to "fix" a build that isn't
// broken.
describe('zero-change commands are no-ops, not failures', () => {
  function hollowCube(shellBlock: string, min: [number, number, number], max: [number, number, number]): VoxelSet {
    const v = new VoxelSet();
    for (let x = min[0]; x <= max[0]; x++)
      for (let y = min[1]; y <= max[1]; y++)
        for (let z = min[2]; z <= max[2]; z++) {
          const onShell = x === min[0] || x === max[0] || y === min[1] || y === max[1] || z === min[2] || z === max[2];
          v.set(x, y, z, st(onShell ? shellBlock : 'air'));
        }
    return v;
  }

  it('a fill returning "No blocks were filled" is not counted as a failure', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const r = await bridge.applyCommands(
      ['fill 0 64 0 1 64 1 obsidian'],
      { min: [0, 64, 0], max: [1, 64, 1] },
      2,
      { world: overworld, snapshot: false },
    );
    expect(r.failed).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.noop).toBe(1);
    expect(r.noopNote).toMatch(/changed nothing/);
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).not.toMatch(/failed/i);
    expect(formatted).toMatch(/changed nothing/);
  });

  it('a build where every command is a no-op surfaces that fact', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const r = await bridge.applyCommands(
      ['fill 0 64 0 1 64 1 obsidian', 'setblock 5 65 5 obsidian'],
      { min: [0, 64, 0], max: [5, 65, 5] },
      3,
      { world: overworld, snapshot: false },
    );
    expect(r.failed).toBe(0);
    expect(r.noop).toBe(2);
    expect(r.noopNote).toMatch(/All 2 command\(s\) changed nothing/);
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).not.toMatch(/failed/i);
    expect(formatted).toMatch(/All 2 command\(s\) changed nothing/);
  });

  it('a genuinely failed command is still counted and reported', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    const r = await bridge.applyCommands(
      ['setblock 0 64 0 bad_block'],
      { min: [0, 64, 0], max: [0, 64, 0] },
      1,
      { world: overworld, snapshot: false },
    );
    expect(r.failed).toBe(1);
    expect(r.noop).toBe(0);
    expect(r.errors[0]).toMatch(/bad_block → Unknown block type/);
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).toMatch(/1 command\(s\) failed/);
  });

  it('the exact real-world scenario: a hollow cube whose interior is already air reports no failures', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now });
    // Mirrors the field report: a hollow 5x5x5 cube, box (-147,64,181) to (-143,68,185), with
    // the 3x3x3 air interior already air on the live server before the build ran.
    const set = hollowCube('stone_bricks', [-147, 64, 181], [-143, 68, 185]);
    const base = fake.handler;
    fake.handler = (cmd) => (cmd.includes(' air') ? 'No blocks were filled' : base(cmd));
    const r = await bridge.apply(set, { world: overworld, snapshot: false });
    expect(r.method).toBe('commands');
    expect(r.blocks).toBe(125);
    expect(fake.commands).toContain('fill -146 65 182 -144 67 184 air');
    expect(r.failed).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.noop).toBe(1);
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).not.toMatch(/failed/i);
    expect(formatted).toMatch(/1 of \d+ command changed nothing/);
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

// Regression tests for the defect: applyCommands ignored opts.blockEntities entirely, so
// pastes with chest contents/sign text/spawner data going through the commands path (the
// common case — below structureThreshold) placed them empty/blank with no warning at all.
describe('block entities are never silently dropped', () => {
  const chestEntity = (pos: [number, number, number]): BlockEntity => ({
    pos,
    id: 'minecraft:chest',
    data: { CustomName: T.string('"Loot Chest"') },
  });

  it('prefers the structure path and preserves block entities even well below the command threshold', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    // structureThreshold defaults to 400 (see testConfig); cube('chest') compiles to a single
    // fill command, nowhere near it. The structure path must still be chosen because block
    // entities are present and a server dir is configured.
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const set = cube('chest');
    const r = await bridge.apply(set, { world: overworld, snapshot: false, blockEntities: [chestEntity([0, 64, 0])] });
    expect(r.method).toBe('structure');
    expect(r.blockEntityNote).toBeUndefined();
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    const files = readdirSync(dir).filter((f) => f.startsWith('paste_'));
    expect(files).toHaveLength(1);
    const clip = readStructure(await parseNbt(await fs.readFile(path.join(dir, files[0]))));
    expect(clip.blockEntities).toHaveLength(1);
    expect(clip.blockEntities[0].id).toBe('minecraft:chest');
    const formatted = formatApplyResult(r, 'paste');
    expect(formatted).not.toMatch(/dropped/);
  });

  it('reports the loss in the result and formatted output when no server dir is configured (structure path unavailable)', async () => {
    const bridge = new RconBridge({ rcon, config: testConfig(), now }); // no serverDir
    const r = await bridge.apply(cube('chest'), { world: overworld, snapshot: false, blockEntities: [chestEntity([0, 64, 0])] });
    expect(r.method).toBe('commands');
    expect(r.blockEntityNote).toBeDefined();
    expect(r.blockEntityNote).toMatch(/1 block entity/);
    expect(r.blockEntityNote).toMatch(/dropped/);
    expect(r.blockEntityNote).toMatch(/BLOCKWRIGHT_SERVER_DIR/);
    const formatted = formatApplyResult(r, 'paste');
    expect(formatted).toMatch(/dropped/);
    expect(formatted).toMatch(/BLOCKWRIGHT_SERVER_DIR/);
  });

  it('leaves an ordinary paste with no block entities exactly as before: no note, and still the commands path below the threshold', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    const r = await bridge.apply(cube('stone'), { world: overworld, snapshot: false });
    expect(r.method).toBe('commands');
    expect(r.blockEntityNote).toBeUndefined();
    const formatted = formatApplyResult(r, 'paste');
    expect(formatted).not.toMatch(/dropped/);
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

// Regression tests for defect 1: a snapshot must never silently capture nothing and then let
// restore() erase the evidence. See the module docstrings on maybeSnapshot/snapshot/restore.
describe('honest snapshots over ungenerated terrain', () => {
  it('does not hand back a snapshotId when the whole box is ungenerated terrain, and keeps no phantom record', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    // chunk 5,5 (x/z 80..95) was never written by flatChunk(): every chunk this box touches is missing.
    const set = cubeAt('stone', 80, 0, 80);
    const r = await bridge.apply(set, { world: overworld, label: 'nowhere' });
    // The write itself still happens — losing undo shouldn't block the build — but nothing
    // must claim undo is available for it.
    expect(fake.commands.some((c) => c.startsWith('fill') || c.startsWith('setblock'))).toBe(true);
    expect(r.snapshotId).toBeUndefined();
    expect(r.snapshotNote).toMatch(/Undo is unavailable/);
    expect(r.snapshotNote).toMatch(/ungenerated chunk column/);
    expect(await bridge.listSnapshots()).toHaveLength(0);
    // The message an AI would relay to the user must say plainly that undo is not possible, and why.
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).toMatch(/Undo is unavailable/);
    expect(formatted).not.toMatch(/Snapshot .* taken/);
  });

  it('captures a partial snapshot when part of the box is ungenerated, reports the gap, and restores what it has', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    // templateMax 16 lines tiles up with the 16-block chunk grid, so the box below splits
    // into one tile fully inside the generated chunk (0,0) and one fully inside the
    // ungenerated chunk (1,0).
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir, templateMax: 16 }), now });
    const set = new VoxelSet();
    for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) set.set(x, 64, z, st('stone'));
    const r = await bridge.apply(set, { world: overworld, label: 'partial' });
    expect(r.snapshotId).toBeDefined();
    expect(r.snapshotNote).toMatch(/only covers part/);
    expect(r.snapshotNote).toMatch(/1 chunk column/);
    const snaps = await bridge.listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].missingChunks).toBe(1);
    expect(snaps[0].pieces).toHaveLength(1); // the tile over chunk (1,0) was dropped, not padded with wrong data
    const formatted = formatApplyResult(r, 'build');
    expect(formatted).toMatch(new RegExp(`Snapshot ${r.snapshotId} taken`));
    expect(formatted).toMatch(/only covers part/);
    // restore() restores what was captured rather than refusing outright.
    const res = await bridge.restore(r.snapshotId!);
    expect(res.restored).toBe(1);
    expect(await bridge.listSnapshots()).toHaveLength(0);
  });

  it('refuses to restore an empty-piece snapshot record and leaves it in the index instead of silently succeeding', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    // Simulate a record that predates this fix (or was hand-edited): zero pieces, still indexed.
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    await fs.mkdir(dir, { recursive: true });
    const badRecord = {
      id: 'empty1',
      world: 'overworld',
      box: { min: [80, 64, 80], max: [81, 65, 81] },
      pieces: [],
      createdAt: new Date(0).toISOString(),
      missingChunks: 1,
    };
    await fs.writeFile(path.join(dir, 'snapshots.json'), JSON.stringify({ snapshots: [badRecord] }, null, 2));
    await expect(bridge.restore('empty1')).rejects.toThrow(/nothing to restore/);
    // restore() must not have deleted the one record that would reveal the problem.
    const snaps = await bridge.listSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe('empty1');
  });
});

// Regression tests for defect 2: the snapshot index must survive concurrent read-modify-write
// without losing a record, and must never be left half-written.
describe('concurrent snapshots do not lose records', () => {
  it('keeps both records when two apply() calls race on the same bridge instance', async () => {
    // Mirrors the reviewer's repro: run two concurrent apply() calls against the same server
    // directory, repeated, and check that every record survives — not just internals of the
    // write path.
    for (let i = 0; i < 5; i++) {
      fake.commands.length = 0;
      const serverDir = await fakeServerDir([flatChunk()]);
      const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
      const setA = cubeAt('stone', 0, 0, 0);
      const setB = cubeAt('dirt', 4, 0, 4);
      const [rA, rB] = await Promise.all([
        bridge.apply(setA, { world: overworld, label: `A${i}` }),
        bridge.apply(setB, { world: overworld, label: `B${i}` }),
      ]);
      expect(rA.snapshotId, `iteration ${i}: A should have a snapshotId`).toBeDefined();
      expect(rB.snapshotId, `iteration ${i}: B should have a snapshotId`).toBeDefined();
      const snaps = await bridge.listSnapshots();
      const ids = snaps.map((s) => s.id).sort();
      expect(ids, `iteration ${i}: both concurrent snapshots must survive in the index`).toEqual([rA.snapshotId, rB.snapshotId].sort());
    }
  });

  it('leaves snapshots.json well-formed (no torn/partial write) under concurrent writes', async () => {
    const serverDir = await fakeServerDir([flatChunk()]);
    const bridge = new RconBridge({ rcon, config: testConfig({ serverDir }), now });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => bridge.apply(cubeAt('stone', (i % 3) * 2, 0, (i % 3) * 2), { world: overworld, label: `c${i}` })),
    );
    const dir = path.join(serverDir, 'world', 'generated', 'blockwright', 'structure');
    const raw = await fs.readFile(path.join(dir, 'snapshots.json'), 'utf8');
    const parsed = JSON.parse(raw) as { snapshots: unknown[] };
    expect(parsed.snapshots).toHaveLength(6);
    // no leftover temp files from the atomic-rename write
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
