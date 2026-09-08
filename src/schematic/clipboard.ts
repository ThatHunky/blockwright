import { VoxelSet, type Box, type Vec3, boxSize } from '../voxel/voxels.js';
import { transformAnchored, transformSet, rotatePos, mirrorPos, type RotationSteps, type Mirror } from '../voxel/rotate.js';
import type { CompoundValue } from '../nbt/nbt.js';

export interface BlockEntity {
  /** Relative to the clipboard's min corner (or absolute, in world read results). */
  pos: Vec3;
  id: string;
  /** Block entity NBT without id/x/y/z/Id/Pos. */
  data: CompoundValue;
}

export interface Clipboard {
  /** Voxels with min corner at (0,0,0). Air is explicit. */
  voxels: VoxelSet;
  size: Vec3;
  /** Sponge semantics: paste position + offset = min corner. */
  offset: Vec3;
  dataVersion: number;
  blockEntities: BlockEntity[];
  source?: 'sponge' | 'structure';
}

export function clipboardFromVoxels(voxels: VoxelSet, dataVersion: number, blockEntities: BlockEntity[] = [], offset: Vec3 = [0, 0, 0]): Clipboard {
  const b = voxels.bounds();
  if (!b) throw new Error('cannot make a clipboard from an empty voxel set');
  const shifted = voxels.translate(-b.min[0], -b.min[1], -b.min[2]);
  return {
    voxels: shifted,
    size: boxSize(b),
    offset,
    dataVersion,
    blockEntities: blockEntities.map((be) => ({ ...be, pos: [be.pos[0] - b.min[0], be.pos[1] - b.min[1], be.pos[2] - b.min[2]] })),
  };
}

export interface PlaceOptions {
  useOffset?: boolean;
  rotation?: RotationSteps;
  mirror?: Mirror;
  ignoreAir?: boolean;
}

/** World-space voxels for pasting the clipboard at `origin`. */
export function clipboardVoxelsAt(clip: Clipboard, origin: Vec3, opts: PlaceOptions): { voxels: VoxelSet; blockEntities: BlockEntity[] } {
  const steps = opts.rotation ?? 0;
  const mirror = opts.mirror ?? 'none';
  let voxels: VoxelSet;
  let shift: Vec3;
  if (opts.useOffset) {
    voxels = transformSet(clip.voxels.translate(clip.offset[0], clip.offset[1], clip.offset[2]), steps, mirror);
    shift = [0, 0, 0];
  } else {
    voxels = transformAnchored(clip.voxels, steps, mirror);
    const after = transformSet(clip.voxels, steps, mirror).bounds()!;
    shift = [-after.min[0], 0, -after.min[2]];
  }
  const place = (p: Vec3): Vec3 => {
    const base = opts.useOffset ? ([p[0] + clip.offset[0], p[1] + clip.offset[1], p[2] + clip.offset[2]] as Vec3) : p;
    const t = rotatePos(mirrorPos(base, mirror), steps);
    return [t[0] + shift[0] + origin[0], t[1] + shift[1] + origin[1], t[2] + shift[2] + origin[2]];
  };
  voxels = voxels.translate(origin[0], origin[1], origin[2]);
  if (opts.ignoreAir) {
    const filtered = new VoxelSet();
    for (const [p, s] of voxels.entries()) if (!s.isAir) filtered.set(p[0], p[1], p[2], s);
    voxels = filtered;
  }
  return { voxels, blockEntities: clip.blockEntities.map((be) => ({ ...be, pos: place(be.pos) })) };
}

/** Split a box into pieces of at most `max` blocks per axis (structure templates cap at 48). */
export function tileBox(b: Box, max = 48): Box[] {
  const out: Box[] = [];
  for (let x = b.min[0]; x <= b.max[0]; x += max)
    for (let y = b.min[1]; y <= b.max[1]; y += max)
      for (let z = b.min[2]; z <= b.max[2]; z += max)
        out.push({ min: [x, y, z], max: [Math.min(x + max - 1, b.max[0]), Math.min(y + max - 1, b.max[1]), Math.min(z + max - 1, b.max[2])] });
  return out;
}
