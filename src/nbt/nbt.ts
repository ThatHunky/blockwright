import nbt from 'prismarine-nbt';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * A single NBT tag, loosely typed. prismarine-nbt's own TypeScript types are a deep web of
 * conditional/generic types keyed on TagType that collapse or widen unpredictably once tags are
 * composed into plain object literals (as the builders below do) - assembling and consuming a
 * document through them fights the compiler rather than helping it. We deliberately narrow to
 * this single loose shape (matching every tag's actual runtime shape) and do the necessary casts
 * once, here, so the rest of the codebase works with a small, stable, honestly-typed surface
 * instead of `any`. Because `value` is `unknown`, the builders below are intentionally loosely
 * typed: a compound nested under the wrong tag type, or a tag built with the wrong shape for its
 * `type`, will not be caught by the compiler - only by tests or at runtime.
 */
export interface NbtTag {
  type: string;
  value: unknown;
}

/** A parsed/root NBT document: a named compound tag. */
export interface NbtRoot {
  type: 'compound';
  name: string;
  value: CompoundValue;
}

/** A compound's value: tag name → typed tag. */
export type CompoundValue = Record<string, NbtTag>;

type Comp = (val: object | object[], name?: string) => NbtRoot;
type Tag = (val: unknown) => NbtTag;

export const T: {
  comp: Comp;
  int: Tag;
  short: Tag;
  byte: Tag;
  long: Tag;
  float: Tag;
  double: Tag;
  string: Tag;
  list: Tag;
  intArray: Tag;
  byteArray: Tag;
  longArray: Tag;
} = {
  comp: nbt.comp as unknown as Comp,
  int: nbt.int as unknown as Tag,
  short: nbt.short as unknown as Tag,
  byte: nbt.byte as unknown as Tag,
  long: nbt.long as unknown as Tag,
  float: nbt.float as unknown as Tag,
  double: nbt.double as unknown as Tag,
  string: nbt.string as unknown as Tag,
  list: nbt.list as unknown as Tag,
  intArray: nbt.intArray as unknown as Tag,
  byteArray: nbt.byteArray as unknown as Tag,
  longArray: nbt.longArray as unknown as Tag,
};

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Parse big-endian NBT, gzip-compressed or not. */
export async function parseNbt(buf: Buffer): Promise<NbtRoot> {
  const raw = isGzip(buf) ? gunzipSync(buf) : buf;
  return nbt.parseUncompressed(raw, 'big') as unknown as NbtRoot;
}

export function writeNbtRaw(root: NbtRoot): Buffer {
  return nbt.writeUncompressed(root as unknown as nbt.NBT, 'big');
}

export function writeNbtGz(root: NbtRoot): Buffer {
  return gzipSync(writeNbtRaw(root));
}

/**
 * Assemble prismarine-nbt's [high, low] 32-bit halves into the signed 64-bit BigInt they
 * represent. Each half is first read as an unsigned 32-bit word (`>>> 0`), then the combined
 * 64-bit unsigned value is sign-extended with `BigInt.asIntN` so this is an exact inverse of
 * `bigIntToLongPair` for negative values too (NBT longs are signed two's-complement 64-bit).
 *
 * Callers that only care about the raw bit pattern (e.g. `unpackLongs` in `world/anvil.ts`,
 * which shifts and masks to pull out packed palette/heightmap entries) are unaffected by the
 * sign: `(v >> k) & mask` yields the same bits whether `v` is negative or its unsigned
 * 2**64 complement, since BigInt shifts and masks operate on two's-complement semantics.
 */
export function longPairToBigInt(pair: [number, number]): bigint {
  return BigInt.asIntN(64, (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0));
}

export function bigIntToLongPair(v: bigint): [number, number] {
  const hi = Number((v >> 32n) & 0xffffffffn) | 0;
  const lo = Number(v & 0xffffffffn) | 0;
  return [hi, lo];
}

/**
 * Longs are read via `longPairToBigInt` then narrowed through `Number`, so any long magnitude
 * beyond ±2^53 (Number.MAX_SAFE_INTEGER) loses precision here. Callers that need the exact 64-bit
 * value (e.g. bit-packed long arrays) must go through `longPairToBigInt`/`longPairs` directly
 * instead of this helper.
 */
export function num(c: CompoundValue, k: string, def?: number): number {
  const t = c[k];
  if (!t) {
    if (def !== undefined) return def;
    throw new Error(`NBT: missing numeric tag "${k}"`);
  }
  if (t.type === 'long') return Number(longPairToBigInt(t.value as [number, number]));
  return t.value as number;
}

export function str(c: CompoundValue, k: string, def?: string): string {
  const t = c[k];
  if (!t) {
    if (def !== undefined) return def;
    throw new Error(`NBT: missing string tag "${k}"`);
  }
  return String(t.value);
}

export function compound(c: CompoundValue, k: string): CompoundValue | undefined {
  const t = c[k];
  return t && t.type === 'compound' ? (t.value as CompoundValue) : undefined;
}

/** Elements of a list tag (compound elements come back as CompoundValue). Empty when missing. */
export function listOf(c: CompoundValue, k: string): unknown[] {
  const t = c[k];
  if (!t || t.type !== 'list') return [];
  const inner = t.value as { type: string; value: unknown[] };
  return inner.value ?? [];
}

/** Ints from either a list of ints or an int array. */
export function intList(c: CompoundValue, k: string): number[] {
  const t = c[k];
  if (!t) return [];
  if (t.type === 'intArray') return [...(t.value as number[])];
  if (t.type === 'list') return [...((t.value as { value: number[] }).value ?? [])];
  throw new Error(`NBT: tag "${k}" is ${t.type}, expected int list`);
}

export function bytes(c: CompoundValue, k: string): number[] {
  const t = c[k];
  if (!t) return [];
  if (t.type !== 'byteArray') throw new Error(`NBT: tag "${k}" is ${t.type}, expected byteArray`);
  return [...(t.value as number[])];
}

export function longPairs(c: CompoundValue, k: string): [number, number][] {
  const t = c[k];
  if (!t) return [];
  if (t.type !== 'longArray') throw new Error(`NBT: tag "${k}" is ${t.type}, expected longArray`);
  return t.value as [number, number][];
}

/** Copy of a compound value without the given keys. */
export function omitKeys(c: CompoundValue, keys: string[]): CompoundValue {
  const out: CompoundValue = {};
  for (const [k, v] of Object.entries(c)) if (!keys.includes(k)) out[k] = v;
  return out;
}
