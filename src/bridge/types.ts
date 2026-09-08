import type { Box, Vec3, VoxelSet } from '../voxel/voxels.js';
import type { BlockEntity } from '../schematic/clipboard.js';
import type { WorldRef } from '../world/dimension.js';

export interface ServerInfo {
  tier: 1 | 2;
  mcVersion: string;
  dataVersion: number;
  playersOnline: number;
  maxPlayers: number;
  players: string[];
  canRead: boolean;
  canSnapshot: boolean;
  notes: string[];
}

export interface PlayerInfo {
  name: string;
  uuid?: string;
  world: string;
  pos: Vec3;
  yaw?: number;
  pitch?: number;
  gamemode?: string;
}

export interface ApplyOptions {
  world: WorldRef;
  dryRun?: boolean;
  /** Default true when the bridge can read. */
  snapshot?: boolean;
  label?: string;
  /** Default true. */
  forceload?: boolean;
  /** Absolute positions; placed only by the structure and plugin paths. */
  blockEntities?: BlockEntity[];
}

export interface ApplyResult {
  dryRun: boolean;
  method: 'commands' | 'structure' | 'plugin' | 'none';
  blocks: number;
  commands: number;
  failed: number;
  errors: string[];
  box?: Box;
  elapsedMs: number;
  snapshotId?: string;
  /**
   * Set whenever the snapshot picture isn't the simple "undo will fully revert this" case:
   * either snapshotId is set but the capture was partial (some of the box was ungenerated
   * terrain and is not covered), or snapshotId is absent because capture was attempted but
   * came back empty. Always tell the user what this says — it is the difference between
   * "undo works" and "undo silently does nothing".
   */
  snapshotNote?: string;
  /** First commands (or a description) for dry runs and logs. */
  sample: string[];
}

export interface ReadResult {
  voxels: VoxelSet;
  blockEntities: BlockEntity[];
  missingChunks: number;
}

export interface HeightmapResult {
  /** [z - minZ][x - minX]; null where the chunk does not exist. */
  heights: (number | null)[][];
  surface: (string | null)[][];
  missingChunks: number;
}

export interface SnapshotRecord {
  id: string;
  world: string;
  box: Box;
  pieces: Array<{ name: string; origin: Vec3 }>;
  createdAt: string;
  label?: string;
  /**
   * Chunk columns inside `box` that were not generated at capture time, and so are not
   * covered by any piece in `pieces`. Undefined or 0 means the capture was complete; undo
   * restores the whole box. Greater than 0 means undo will not restore those areas — the
   * pieces that do exist should still be restored, but the gap must be reported honestly.
   */
  missingChunks?: number;
}

export interface Bridge {
  readonly tier: 1 | 2;
  info(): Promise<ServerInfo>;
  players(): Promise<PlayerInfo[]>;
  runCommand(command: string): Promise<string>;
  apply(set: VoxelSet, opts: ApplyOptions): Promise<ApplyResult>;
  applyCommands(commands: string[], box: Box, blocks: number, opts: ApplyOptions): Promise<ApplyResult>;
  canRead(): boolean;
  read(box: Box, world: WorldRef): Promise<ReadResult>;
  heightmap(minX: number, minZ: number, maxX: number, maxZ: number, world: WorldRef): Promise<HeightmapResult>;
  snapshot(box: Box, world: WorldRef, label?: string): Promise<SnapshotRecord>;
  restore(id: string): Promise<{ restored: number; record: SnapshotRecord }>;
  listSnapshots(): Promise<SnapshotRecord[]>;
  close(): Promise<void>;
}
