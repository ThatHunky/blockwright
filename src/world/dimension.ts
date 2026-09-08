import { existsSync } from 'node:fs';
import path from 'node:path';

export type Dimension = 'minecraft:overworld' | 'minecraft:the_nether' | 'minecraft:the_end';
export type WorldLabel = 'overworld' | 'nether' | 'end';

export interface WorldRef {
  label: WorldLabel;
  dimension: Dimension;
  /** Bukkit world folder/name, e.g. world, world_nether, world_the_end. */
  bukkitName: string;
}

const DIM: Record<WorldLabel, Dimension> = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' };

export function resolveWorld(input: string | undefined, levelName: string): WorldRef {
  const s = (input ?? 'overworld').trim().toLowerCase();
  const aliases: Record<string, WorldLabel> = {
    overworld: 'overworld', world: 'overworld', 'minecraft:overworld': 'overworld', [levelName.toLowerCase()]: 'overworld',
    nether: 'nether', the_nether: 'nether', 'minecraft:the_nether': 'nether', world_nether: 'nether', [`${levelName.toLowerCase()}_nether`]: 'nether',
    end: 'end', the_end: 'end', 'minecraft:the_end': 'end', world_the_end: 'end', [`${levelName.toLowerCase()}_the_end`]: 'end',
  };
  const label = aliases[s];
  if (!label) throw new Error(`Unknown world "${input}". Use overworld, nether or end.`);
  const bukkitName = label === 'overworld' ? levelName : label === 'nether' ? `${levelName}_nether` : `${levelName}_the_end`;
  return { label, dimension: DIM[label], bukkitName };
}

/** [26.x layout, legacy Bukkit layout] */
export function regionDirCandidates(serverDir: string, levelName: string, label: WorldLabel): string[] {
  const dimFolder = label === 'overworld' ? 'overworld' : label === 'nether' ? 'the_nether' : 'the_end';
  const modern = path.join(serverDir, levelName, 'dimensions', 'minecraft', dimFolder, 'region');
  const legacy =
    label === 'overworld'
      ? path.join(serverDir, levelName, 'region')
      : label === 'nether'
        ? path.join(serverDir, `${levelName}_nether`, 'DIM-1', 'region')
        : path.join(serverDir, `${levelName}_the_end`, 'DIM1', 'region');
  return [modern, legacy];
}

export function resolveRegionDir(serverDir: string, levelName: string, label: WorldLabel): string | undefined {
  return regionDirCandidates(serverDir, levelName, label).find((d) => existsSync(d));
}
