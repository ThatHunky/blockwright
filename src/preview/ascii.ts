import { VoxelSet, BlockState } from '../voxel/voxels.js';

export interface AsciiOptions {
  maxLayers?: number;
}

export interface AsciiResult {
  text: string;
  /**
   * char → canonical state string, except '?' which, when present, holds a human-readable
   * summary of how many distinct block types beyond the first 62 collapsed onto it.
   */
  legend: Record<string, string>;
}

const CHARS = '#@%&*+=oxO^~$8ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwyz';

export function renderAscii(set: VoxelSet, opts: AsciiOptions = {}): AsciiResult {
  const maxLayers = opts.maxLayers ?? 12;
  const b = set.bounds();
  if (!b) return { text: '(empty)', legend: {} };
  // Count states directly from the actual BlockState objects rather than re-parsing their
  // canonical string form: a state can reach a VoxelSet via a path other than
  // BlockState.parse (e.g. schematic/anvil NBT decoding constructs BlockState directly),
  // so it must never be required to round-trip through parse again here.
  const countsByState = new Map<string, { state: BlockState; n: number }>();
  for (const [, s] of set.entries()) {
    const k = s.toString();
    const e = countsByState.get(k);
    if (e) e.n++; else countsByState.set(k, { state: s, n: 1 });
  }
  const counts = [...countsByState.entries()]
    .map(([state, e]) => [state, e.state, e.n] as [string, BlockState, number])
    .sort((x, y) => y[2] - x[2] || x[0].localeCompare(y[0]));
  const charOf = new Map<string, string>();
  const legend: Record<string, string> = {};
  let next = 0;
  let overflow = 0;
  for (const [state, s] of counts) {
    let ch: string;
    if (s.isAir) ch = '.';
    else if (next < CHARS.length) ch = CHARS[next++];
    else { ch = '?'; overflow++; }
    charOf.set(state, ch);
    if (ch !== '?') legend[ch] = state;
  }
  if (overflow > 0) legend['?'] = `${overflow} further block type${overflow === 1 ? '' : 's'} not individually shown`;
  const [w, h, l] = [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
  const lines: string[] = [];
  lines.push(`Bounds: (${b.min.join(', ')}) to (${b.max.join(', ')}), size ${w}x${h}x${l}, ${set.size} blocks (${set.nonAirCount()} non-air)`);
  lines.push('Legend: ' + counts.map(([state, s, n]) => `${charOf.get(state)} ${s.toCommand()} (${n})`).join(', ') + ', space = untouched');
  lines.push('');
  lines.push(`Top-down (north/−z at top, west/−x at left; highest non-air block per column). Columns x=${b.min[0]}..${b.max[0]}, rows z=${b.min[2]}..${b.max[2]}`);
  for (let z = b.min[2]; z <= b.max[2]; z++) {
    let row = '';
    for (let x = b.min[0]; x <= b.max[0]; x++) {
      let ch = ' ';
      for (let y = b.max[1]; y >= b.min[1]; y--) {
        const s = set.get(x, y, z);
        if (s && !s.isAir) {
          ch = charOf.get(s.toString()) ?? '?';
          break;
        }
      }
      row += ch;
    }
    lines.push(`  ${row}`);
  }
  lines.push('');
  const shown = Math.min(h, maxLayers);
  for (let i = 0; i < shown; i++) {
    const y = b.min[1] + i;
    lines.push(`Layer y=${y} (+${i}):`);
    for (let z = b.min[2]; z <= b.max[2]; z++) {
      let row = '';
      for (let x = b.min[0]; x <= b.max[0]; x++) {
        const s = set.get(x, y, z);
        row += s ? (charOf.get(s.toString()) ?? '?') : ' ';
      }
      lines.push(`  ${row}`);
    }
  }
  if (h > shown) lines.push(`(${h - shown} more layers omitted; raise maxLayers to see them)`);
  return { text: lines.join('\n'), legend };
}
