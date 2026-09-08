/** Shared voxel-count cap used by every spec-to-VoxelSet generator (shapes and build specs
 * alike), so an AI model calling the tools sees one coherent limit and one way to raise it,
 * rather than a different convention per generator. Overridable via BLOCKWRIGHT_MAX_VOXELS. */
export const DEFAULT_MAX_VOXELS = 5_000_000;
export const MAX_VOXELS_ENV_VAR = 'BLOCKWRIGHT_MAX_VOXELS';

export function maxVoxels(): number {
  const raw = process.env[MAX_VOXELS_ENV_VAR];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_VOXELS;
}

/**
 * Standard wording for a voxel-cap violation, naming the requested size, the cap and the env
 * var, so an AI model reading the error knows exactly how to retry with something smaller.
 *
 * Pass a number for a pre-generation estimate ("would produce approximately N voxels...").
 * Pass 'running' once a running counter has already crossed the cap mid-generation, where the
 * final size isn't known (and isn't worth computing) because generation stops as soon as the
 * cap is crossed.
 */
export function voxelCapMessage(subject: string, estimate: number | 'running', cap: number): string {
  if (estimate === 'running') {
    return (
      `${subject} would produce more than ${cap.toLocaleString()} voxels, exceeding the ${cap.toLocaleString()} voxel limit. ` +
      `Reduce its size, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`
    );
  }
  return (
    `${subject} would produce approximately ${estimate.toLocaleString()} voxels, which exceeds the ${cap.toLocaleString()} voxel limit. ` +
    `Reduce its size, or raise the limit by setting the ${MAX_VOXELS_ENV_VAR} environment variable.`
  );
}
