import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { RconClient } from '../rcon/client.js';
import { VoxelSet, boxContains, formatVec, type Box } from '../voxel/voxels.js';
import { compile, forceloadRects, prefixDimension } from '../voxel/compile.js';
import { clipboardFromVoxels, tileBox } from '../schematic/clipboard.js';
import { writeStructure } from '../schematic/structure.js';
import { writeNbtGz } from '../nbt/nbt.js';
import { resolveRegionDir, resolveWorld, type WorldRef } from '../world/dimension.js';
import { readVoxels, readHeightmap, surfaceBlock } from '../world/anvil.js';
import { BridgeError, BoundsError, NeedsReadError } from './errors.js';
import type { Bridge, ApplyOptions, ApplyResult, ServerInfo, PlayerInfo, ReadResult, HeightmapResult, SnapshotRecord } from './types.js';

const ERROR_RE =
  /Incorrect argument|Unknown or incomplete command|not loaded|Too many blocks|Too many chunks|No blocks were filled|Could not set the block|out of this world|no template|Expected |Invalid |Unknown block|Unknown item|Unknown request|That position|Failed/i;
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const KEEP_PASTES = 20;
const KEEP_SNAPSHOTS = 50;

export interface RconBridgeDeps {
  rcon: Pick<RconClient, 'send' | 'close'>;
  config: Config;
  now?: () => number;
}

function newId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export class RconBridge implements Bridge {
  readonly tier = 1 as const;
  private lastSaveAt = -Infinity;
  private dirty = true;
  private readonly now: () => number;

  constructor(private readonly deps: RconBridgeDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get config(): Config {
    return this.deps.config;
  }

  private send(cmd: string): Promise<string> {
    return this.deps.rcon.send(cmd);
  }

  canRead(): boolean {
    const d = this.config.serverDir;
    return d !== undefined && resolveRegionDir(d, this.config.levelName, 'overworld') !== undefined;
  }

  private regionDir(world: WorldRef): string {
    const d = this.config.serverDir;
    if (!d) throw new NeedsReadError('Reading the world');
    const r = resolveRegionDir(d, this.config.levelName, world.label);
    if (!r) throw new NeedsReadError(`Reading the ${world.label} (no region folder found under ${d})`);
    return r;
  }

  private generatedDir(): string {
    const d = this.config.serverDir;
    if (!d) throw new NeedsReadError('Structure templates');
    return path.join(d, this.config.levelName, 'generated', 'blockwright', 'structure');
  }

  async runCommand(command: string): Promise<string> {
    return this.send(command.replace(/^\//, '').trim());
  }

  async info(): Promise<ServerInfo> {
    const list = await this.send('list');
    const m = /There are (\d+) of a max of (\d+) players online:?\s*(.*)/.exec(list);
    const players = m && m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const notes: string[] = [];
    if (!m) notes.push(`unexpected "list" response: ${list.slice(0, 120)}`);
    if (!this.canRead())
      notes.push('Read tools (read_region, get_heightmap, get_block, save_schematic, undo, preview context) need BLOCKWRIGHT_SERVER_DIR pointing at the server folder, or the blockwright plugin.');
    return {
      tier: 1,
      mcVersion: this.config.mcVersion,
      dataVersion: this.config.dataVersion,
      playersOnline: m ? Number(m[1]) : players.length,
      maxPlayers: m ? Number(m[2]) : 0,
      players,
      canRead: this.canRead(),
      canSnapshot: this.canRead(),
      notes,
    };
  }

  async players(): Promise<PlayerInfo[]> {
    const list = await this.send('list uuids');
    const out: PlayerInfo[] = [];
    for (const m of list.matchAll(/([^\s,:()]+) \(([0-9a-f-]{36})\)/g)) {
      const [, name, uuid] = m;
      const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await this.send(`data get entity ${uuid} Pos`));
      if (!pos) continue;
      const rot = /\[(-?[\d.]+)f, (-?[\d.]+)f\]/.exec(await this.send(`data get entity ${uuid} Rotation`));
      const dim = /"([^"]+)"/.exec(await this.send(`data get entity ${uuid} Dimension`));
      const gm = /: (\d+)/.exec(await this.send(`data get entity ${uuid} playerGameType`));
      out.push({
        name,
        uuid,
        world: dim?.[1] ?? 'minecraft:overworld',
        pos: [Math.floor(Number(pos[1])), Math.floor(Number(pos[2])), Math.floor(Number(pos[3]))],
        yaw: rot ? Number(rot[1]) : undefined,
        pitch: rot ? Number(rot[2]) : undefined,
        gamemode: gm ? GAMEMODES[Number(gm[1])] : undefined,
      });
    }
    return out;
  }

  private checkBounds(box: Box): void {
    const b = this.config.bounds;
    if (!b) return;
    if (!boxContains(b, box.min) || !boxContains(b, box.max)) throw new BoundsError(box, b);
  }

  private async forceload(box: Box, world: WorldRef, add: boolean, errors: string[]): Promise<void> {
    for (const r of forceloadRects(box)) {
      const cmd = prefixDimension(`forceload ${add ? 'add' : 'remove'} ${r.minX} ${r.minZ} ${r.maxX} ${r.maxZ}`, world.dimension);
      const resp = await this.send(cmd);
      if (ERROR_RE.test(resp)) errors.push(`${cmd} → ${resp}`);
    }
  }

  private async maybeSnapshot(box: Box, opts: ApplyOptions): Promise<string | undefined> {
    if (opts.snapshot === false || !this.canRead()) return undefined;
    return (await this.snapshot(box, opts.world, opts.label)).id;
  }

  async applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult> {
    const start = this.now();
    this.checkBounds(box);
    const base = { blocks, commands: commands.length, box, sample: commands.slice(0, 20) };
    if (opts.dryRun) return { ...base, dryRun: true, method: 'none', failed: 0, errors: [], elapsedMs: 0 };
    const errors: string[] = [];
    const snapshotId = await this.maybeSnapshot(box, opts);
    let failed = 0;
    if (opts.forceload !== false) await this.forceload(box, opts.world, true, errors);
    try {
      for (const cmd of commands) {
        const resp = await this.send(cmd);
        if (ERROR_RE.test(resp)) {
          failed++;
          if (errors.length < 50) errors.push(`${cmd} → ${resp}`);
        }
      }
    } finally {
      this.dirty = true;
      if (opts.forceload !== false) await this.forceload(box, opts.world, false, errors);
    }
    return { ...base, dryRun: false, method: 'commands', failed, errors, elapsedMs: this.now() - start, snapshotId };
  }

  async apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult> {
    const box = set.bounds();
    if (!box) throw new BridgeError('nothing to place: the voxel set is empty');
    this.checkBounds(box);
    const commands = compile(set, { fillLimit: this.config.fillLimit, dimension: opts.world.dimension });
    const useStructure = commands.length > this.config.structureThreshold && this.config.serverDir !== undefined;
    if (!useStructure) return this.applyCommands(commands.map((c) => c.text), box, set.size, opts);
    return this.applyStructure(set, box, commands.length, opts);
  }

  private async applyStructure(set: VoxelSet, box: Box, commandCount: number, opts: ApplyOptions): Promise<ApplyResult> {
    const start = this.now();
    const tiles = tileBox(box, this.config.templateMax).filter((t) => set.within(t).size > 0);
    const base = {
      blocks: set.size,
      commands: tiles.length,
      box,
      sample: [`${commandCount} fill/setblock commands exceed BLOCKWRIGHT_STRUCTURE_THRESHOLD; placing ${tiles.length} structure template(s) instead`],
    };
    if (opts.dryRun) return { ...base, dryRun: true, method: 'structure', failed: 0, errors: [], elapsedMs: 0 };
    const errors: string[] = [];
    const snapshotId = await this.maybeSnapshot(box, opts);
    const dir = this.generatedDir();
    await fs.mkdir(dir, { recursive: true });
    const id = newId();
    let failed = 0;
    await this.forceload(box, opts.world, true, errors);
    try {
      for (const [n, tile] of tiles.entries()) {
        const sub = set.within(tile);
        const bes = (opts.blockEntities ?? []).filter((be) => boxContains(tile, be.pos));
        const clip = clipboardFromVoxels(sub, this.config.dataVersion, bes);
        const name = `paste_${id}_${n}`;
        await fs.writeFile(path.join(dir, `${name}.nbt`), writeNbtGz(writeStructure(clip)));
        const cmd = prefixDimension(`place template blockwright:${name} ${formatVec(sub.bounds()!.min)}`, opts.world.dimension);
        const resp = await this.send(cmd);
        if (!/Loaded template/.test(resp)) {
          failed++;
          errors.push(`${cmd} → ${resp}`);
        }
      }
    } finally {
      this.dirty = true;
      await this.forceload(box, opts.world, false, errors);
      await this.prune(dir, /^paste_/, KEEP_PASTES);
    }
    return { ...base, dryRun: false, method: 'structure', failed, errors, elapsedMs: this.now() - start, snapshotId };
  }

  private async prune(dir: string, pattern: RegExp, keep: number): Promise<void> {
    const entries = (await fs.readdir(dir)).filter((f) => pattern.test(f));
    const withTime = await Promise.all(entries.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { f } of withTime.slice(keep)) await fs.rm(path.join(dir, f), { force: true });
  }

  private async ensureSaved(): Promise<void> {
    if (!this.dirty && this.now() - this.lastSaveAt < this.config.saveCoalesceMs) return;
    const resp = await this.send('save-all flush');
    if (!/Saved the game/i.test(resp)) throw new BridgeError(`save-all flush did not confirm: ${resp}`);
    this.lastSaveAt = this.now();
    this.dirty = false;
  }

  async read(box: Box, world: WorldRef): Promise<ReadResult> {
    const dir = this.regionDir(world);
    await this.ensureSaved();
    return readVoxels(dir, box);
  }

  async heightmap(minX: number, minZ: number, maxX: number, maxZ: number, world: WorldRef): Promise<HeightmapResult> {
    const dir = this.regionDir(world);
    await this.ensureSaved();
    const { heights, missingChunks, chunks } = await readHeightmap(dir, minX, minZ, maxX, maxZ);
    const surface = heights.map((row, zi) => row.map((h, xi) => (h === null ? null : surfaceBlock(chunks, minX + xi, minZ + zi, h).toCommand())));
    return { heights, surface, missingChunks };
  }

  private indexPath(): string {
    return path.join(this.generatedDir(), 'snapshots.json');
  }

  async listSnapshots(): Promise<SnapshotRecord[]> {
    try {
      return (JSON.parse(await fs.readFile(this.indexPath(), 'utf8')) as { snapshots: SnapshotRecord[] }).snapshots;
    } catch {
      return [];
    }
  }

  private async writeIndex(records: SnapshotRecord[]): Promise<void> {
    await fs.mkdir(this.generatedDir(), { recursive: true });
    await fs.writeFile(this.indexPath(), JSON.stringify({ snapshots: records }, null, 2));
  }

  async snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord> {
    const { voxels, blockEntities } = await this.read(box, world);
    const dir = this.generatedDir();
    await fs.mkdir(dir, { recursive: true });
    const id = newId();
    const pieces: SnapshotRecord['pieces'] = [];
    for (const [n, tile] of tileBox(box, this.config.templateMax).entries()) {
      const sub = voxels.within(tile);
      if (sub.size === 0) continue; // chunk not generated yet: nothing to restore there
      const clip = clipboardFromVoxels(sub, this.config.dataVersion, blockEntities.filter((be) => boxContains(tile, be.pos)));
      const name = `snap_${id}_${n}`;
      await fs.writeFile(path.join(dir, `${name}.nbt`), writeNbtGz(writeStructure(clip)));
      pieces.push({ name, origin: sub.bounds()!.min });
    }
    const record: SnapshotRecord = { id, world: world.label, box, pieces, createdAt: new Date(this.now()).toISOString(), label };
    const records = [record, ...(await this.listSnapshots())];
    for (const old of records.splice(KEEP_SNAPSHOTS)) for (const p of old.pieces) await fs.rm(path.join(dir, `${p.name}.nbt`), { force: true });
    await this.writeIndex(records);
    return record;
  }

  async restore(id: string): Promise<{ restored: number; record: SnapshotRecord }> {
    const records = await this.listSnapshots();
    const record = records.find((r) => r.id === id);
    if (!record) throw new BridgeError(`no snapshot with id ${id}`);
    const world = resolveWorld(record.world, this.config.levelName);
    const errors: string[] = [];
    let restored = 0;
    await this.forceload(record.box, world, true, errors);
    try {
      for (const p of record.pieces) {
        const resp = await this.send(prefixDimension(`place template blockwright:${p.name} ${formatVec(p.origin)}`, world.dimension));
        if (/Loaded template/.test(resp)) restored++;
        else errors.push(`${p.name} → ${resp}`);
      }
    } finally {
      this.dirty = true;
      await this.forceload(record.box, world, false, errors);
    }
    if (errors.length) throw new BridgeError(`restore ${id}: ${restored}/${record.pieces.length} pieces placed; ${errors.join('; ')}`);
    const dir = this.generatedDir();
    for (const p of record.pieces) await fs.rm(path.join(dir, `${p.name}.nbt`), { force: true });
    await this.writeIndex(records.filter((r) => r.id !== id));
    return { restored, record };
  }

  async close(): Promise<void> {
    await this.deps.rcon.close();
  }
}
