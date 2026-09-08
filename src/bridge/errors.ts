import type { Box } from '../voxel/voxels.js';

export class BridgeError extends Error {}

export class BoundsError extends BridgeError {
  constructor(
    readonly box: Box,
    readonly bounds: Box,
  ) {
    super(`Refusing to write outside BLOCKWRIGHT_BOUNDS: target (${box.min.join(', ')}) to (${box.max.join(', ')}) is not within (${bounds.min.join(', ')}) to (${bounds.max.join(', ')})`);
  }
}

export class NeedsReadError extends BridgeError {
  constructor(what: string) {
    super(`${what} needs world access: set BLOCKWRIGHT_SERVER_DIR to the server folder (blockwright must run on the server host or a shared filesystem), or install the blockwright plugin.`);
  }
}
