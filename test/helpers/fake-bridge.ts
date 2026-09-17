import { VoxelSet, BlockState, type Box } from '../../src/voxel/voxels.js';
import type { Bridge, ApplyOptions, ApplyResult, ServerInfo, PlayerInfo, ReadResult, HeightmapResult, SnapshotRecord } from '../../src/bridge/types.js';
import type { WorldRef } from '../../src/world/dimension.js';

const AIR = BlockState.parse('air');

/** In-memory world. apply() merges voxels; read() returns the box with air where nothing was set. */
export class FakeBridge implements Bridge {
  readonly tier = 1 as const;
  world = new VoxelSet();
  calls: Array<{ method: string; args: unknown[] }> = [];
  playersList: PlayerInfo[] = [{ name: 'Steve', world: 'minecraft:overworld', pos: [0, 64, 0], gamemode: 'creative' }];
  readable = true;
  snapshots: SnapshotRecord[] = [];
  private saved = new Map<string, VoxelSet>();
  private seq = 0;

  async info(): Promise<ServerInfo> {
    return { tier: 1, mcVersion: '26.2', dataVersion: 4903, playersOnline: this.playersList.length, maxPlayers: 20, players: this.playersList.map((p) => p.name), canRead: this.readable, canSnapshot: this.readable, notes: [] };
  }
  async players(): Promise<PlayerInfo[]> {
    return this.playersList;
  }
  async runCommand(command: string): Promise<string> {
    this.calls.push({ method: 'runCommand', args: [command] });
    return `ok: ${command}`;
  }
  async apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult> {
    this.calls.push({ method: 'apply', args: [set, opts] });
    const box = set.bounds()!;
    if (opts.dryRun) return { dryRun: true, method: 'none', blocks: set.size, commands: 1, failed: 0, errors: [], box, elapsedMs: 0, sample: ['(dry run)'] };
    const snapshotId = opts.snapshot !== false && this.readable ? (await this.snapshot(box, opts.world, opts.label)).id : undefined;
    this.world.merge(set);
    return { dryRun: false, method: 'commands', blocks: set.size, commands: 1, failed: 0, errors: [], box, elapsedMs: 1, snapshotId, sample: [] };
  }
  async applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult> {
    this.calls.push({ method: 'applyCommands', args: [commands, box, blocks, opts] });
    return { dryRun: !!opts.dryRun, method: opts.dryRun ? 'none' : 'commands', blocks, commands: commands.length, failed: 0, errors: [], box, elapsedMs: 1, sample: commands.slice(0, 20) };
  }
  canRead(): boolean {
    return this.readable;
  }
  async read(box: Box): Promise<ReadResult> {
    const voxels = new VoxelSet();
    for (let x = box.min[0]; x <= box.max[0]; x++) for (let y = box.min[1]; y <= box.max[1]; y++) for (let z = box.min[2]; z <= box.max[2]; z++) voxels.set(x, y, z, this.world.get(x, y, z) ?? AIR);
    return { voxels, blockEntities: [], missingChunks: 0 };
  }
  async heightmap(minX: number, minZ: number, maxX: number, maxZ: number): Promise<HeightmapResult> {
    const heights: number[][] = [];
    const surface: (string | null)[][] = [];
    // One pass over the world rather than one per column, so a chunk-sized request stays cheap.
    const tops = new Map<string, { y: number; block: string }>();
    for (const [p, s] of this.world.entries()) {
      if (s.isAir || p[0] < minX || p[0] > maxX || p[2] < minZ || p[2] > maxZ) continue;
      const k = `${p[0]},${p[2]}`;
      const t = tops.get(k);
      if (!t || p[1] > t.y) tops.set(k, { y: p[1], block: s.toCommand() });
    }
    for (let z = minZ; z <= maxZ; z++) {
      const hr: number[] = [];
      const sr: (string | null)[] = [];
      for (let x = minX; x <= maxX; x++) {
        const t = tops.get(`${x},${z}`);
        hr.push(t ? t.y : -65);
        sr.push(t ? t.block : null);
      }
      heights.push(hr);
      surface.push(sr);
    }
    return { heights, surface, missingChunks: 0 };
  }
  async snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord> {
    const id = `snap${++this.seq}`;
    this.saved.set(id, (await this.read(box)).voxels);
    const record: SnapshotRecord = { id, world: world.label, box, pieces: [{ name: id, origin: box.min }], createdAt: new Date(0).toISOString(), label };
    this.snapshots.unshift(record);
    return record;
  }
  async restore(id: string): Promise<{ restored: number; record: SnapshotRecord }> {
    const record = this.snapshots.find((r) => r.id === id);
    if (!record) throw new Error(`no snapshot with id ${id}`);
    this.world.merge(this.saved.get(id)!);
    this.snapshots = this.snapshots.filter((r) => r.id !== id);
    return { restored: 1, record };
  }
  async listSnapshots(): Promise<SnapshotRecord[]> {
    return this.snapshots;
  }
  async close(): Promise<void> {}
}
