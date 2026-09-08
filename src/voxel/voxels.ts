export type Vec3 = [number, number, number];

/** Inclusive axis-aligned box. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export function box(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0] + 1, b.max[1] - b.min[1] + 1, b.max[2] - b.min[2] + 1];
}

export function boxVolume(b: Box): number {
  const s = boxSize(b);
  return s[0] * s[1] * s[2];
}

export function boxContains(b: Box, p: Vec3): boolean {
  return (
    p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[1] <= b.max[1] &&
    p[2] >= b.min[2] && p[2] <= b.max[2]
  );
}

export function boxExpand(b: Box, n: number): Box {
  return { min: [b.min[0] - n, b.min[1] - n, b.min[2] - n], max: [b.max[0] + n, b.max[1] + n, b.max[2] + n] };
}

export function boxUnion(a: Box, b: Box): Box {
  return box(
    [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  );
}

export function formatVec(v: Vec3): string {
  return `${v[0]} ${v[1]} ${v[2]}`;
}

const NAME_RE = /^[a-z0-9_.\-]+(?::[a-z0-9_.\-/]+)?$/;
const STATE_RE = /^([^\[\]]+)(?:\[(.*)\])?$/;
// Minecraft block state property keys are lowercase snake_case identifiers; values are
// either lowercase snake_case tokens (enum-like: "north", "true") or signed integers.
const PROP_KEY_RE = /^[a-z0-9_]+$/;
const PROP_VALUE_RE = /^(?:[a-z0-9_]+|-?[0-9]+)$/;
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

export class BlockState {
  readonly name: string;
  readonly props: Readonly<Record<string, string>>;
  private text: string | undefined;

  constructor(name: string, props: Record<string, string> = {}) {
    this.name = name.includes(':') ? name : `minecraft:${name}`;
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(props).sort()) sorted[k] = props[k];
    this.props = Object.freeze(sorted);
  }

  static parse(text: string): BlockState {
    const trimmed = text.trim();
    const m = STATE_RE.exec(trimmed);
    if (!m || !NAME_RE.test(m[1])) throw new Error(`Invalid block state: "${text}"`);
    const props: Record<string, string> = {};
    if (m[2] !== undefined && m[2].trim() !== '') {
      for (const pair of m[2].split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0 || eq === pair.length - 1) throw new Error(`Invalid block state property in "${text}": "${pair}"`);
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (!PROP_KEY_RE.test(k) || !PROP_VALUE_RE.test(v)) throw new Error(`Invalid block state property in "${text}": "${pair}"`);
        props[k] = v;
      }
    }
    return new BlockState(m[1], props);
  }

  get isAir(): boolean {
    return AIR.has(this.name);
  }

  /** Name without the minecraft: namespace, for display and commands. */
  get shortName(): string {
    return this.name.startsWith('minecraft:') ? this.name.slice(10) : this.name;
  }

  with(props: Record<string, string>): BlockState {
    return new BlockState(this.name, { ...this.props, ...props });
  }

  private propsText(): string {
    const keys = Object.keys(this.props);
    return keys.length ? `[${keys.map((k) => `${k}=${this.props[k]}`).join(',')}]` : '';
  }

  /** Canonical namespaced form, used as map key and in schematic palettes. */
  toString(): string {
    if (this.text === undefined) this.text = this.name + this.propsText();
    return this.text;
  }

  /** Form accepted by /setblock and /fill. */
  toCommand(): string {
    return this.shortName + this.propsText();
  }

  equals(other: BlockState): boolean {
    return this.toString() === other.toString();
  }
}

export function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function unkey(k: string): Vec3 {
  const parts = k.split(',');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

export class VoxelSet {
  private readonly map = new Map<string, BlockState>();
  private cachedBounds: Box | undefined | null = null; // null = stale

  get size(): number {
    return this.map.size;
  }

  set(x: number, y: number, z: number, state: BlockState): void {
    this.map.set(key(x, y, z), state);
    this.cachedBounds = null;
  }

  get(x: number, y: number, z: number): BlockState | undefined {
    return this.map.get(key(x, y, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.map.has(key(x, y, z));
  }

  delete(x: number, y: number, z: number): boolean {
    const r = this.map.delete(key(x, y, z));
    if (r) this.cachedBounds = null;
    return r;
  }

  *entries(): Generator<[Vec3, BlockState]> {
    for (const [k, s] of this.map) yield [unkey(k), s];
  }

  bounds(): Box | undefined {
    if (this.cachedBounds !== null) return this.cachedBounds;
    if (this.map.size === 0) return (this.cachedBounds = undefined);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const [p] of this.entries()) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    return (this.cachedBounds = { min, max });
  }

  /** Count per canonical state string. */
  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.map.values()) out.set(s.toString(), (out.get(s.toString()) ?? 0) + 1);
    return out;
  }

  nonAirCount(): number {
    let n = 0;
    for (const s of this.map.values()) if (!s.isAir) n++;
    return n;
  }

  translate(dx: number, dy: number, dz: number): VoxelSet {
    const out = new VoxelSet();
    for (const [p, s] of this.entries()) out.set(p[0] + dx, p[1] + dy, p[2] + dz, s);
    return out;
  }

  clone(): VoxelSet {
    const out = new VoxelSet();
    for (const [k, s] of this.map) out.map.set(k, s);
    return out;
  }

  merge(other: VoxelSet): this {
    for (const [k, s] of other.map) this.map.set(k, s);
    this.cachedBounds = null;
    return this;
  }

  /** Sub-set of voxels inside the box. */
  within(b: Box): VoxelSet {
    const out = new VoxelSet();
    for (const [p, s] of this.entries()) if (boxContains(b, p)) out.set(p[0], p[1], p[2], s);
    return out;
  }
}
