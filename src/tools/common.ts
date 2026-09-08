import { z } from 'zod';
import type { VoxelSet } from '../voxel/voxels.js';
import { WorldSchema } from '../voxel/schemas.js';
import { resolveWorld } from '../world/dimension.js';
import { validateSet } from '../blocks/registry.js';
import type { ApplyOptions } from '../bridge/types.js';
import type { AppContext } from '../server.js';

export const writeOptionsShape = {
  world: WorldSchema.optional(),
  dry_run: z.boolean().default(false).describe('Compile and report without changing the world'),
  snapshot: z.boolean().default(true).describe('Snapshot the affected box first so undo can revert it (needs world read access)'),
  label: z.string().optional().describe('Short label stored with the snapshot, e.g. "cottage walls"'),
  allow_unknown_blocks: z.boolean().default(false).describe('Skip block-name validation (for blocks newer than the bundled registry)'),
};

export interface WriteArgs {
  world?: string;
  dry_run: boolean;
  snapshot: boolean;
  label?: string;
  allow_unknown_blocks: boolean;
}

export function applyOptionsFrom(args: WriteArgs, ctx: AppContext): ApplyOptions {
  return { world: resolveWorld(args.world, ctx.config.levelName), dryRun: args.dry_run, snapshot: args.snapshot, label: args.label };
}

/** Returns an error message listing every invalid state, or undefined. */
export function validationError(set: VoxelSet, allowUnknown: boolean): string | undefined {
  if (allowUnknown) return undefined;
  const issues = validateSet(set);
  if (!issues.length) return undefined;
  return `Invalid block states (pass allow_unknown_blocks=true to override):\n${issues.map((i) => `  ${i.block}: ${i.message}`).join('\n')}`;
}
