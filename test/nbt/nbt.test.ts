import { describe, it, expect } from 'vitest';
import {
  T,
  parseNbt,
  writeNbtGz,
  writeNbtRaw,
  num,
  str,
  compound,
  listOf,
  intList,
  bytes,
  longPairToBigInt,
  bigIntToLongPair,
} from '../../src/nbt/nbt.js';

describe('nbt helpers', () => {
  it('round-trips through gzip and raw', async () => {
    const root = T.comp({ a: T.int(7), s: T.string('hi'), l: T.list(T.int([1, 2, 3])), ia: T.intArray([4, 5]), la: T.longArray([[0, 9]]) }, '');
    for (const buf of [writeNbtGz(root), writeNbtRaw(root)]) {
      const back = await parseNbt(buf);
      expect(num(back.value, 'a')).toBe(7);
      expect(str(back.value, 's')).toBe('hi');
      expect(intList(back.value, 'l')).toEqual([1, 2, 3]);
      expect(intList(back.value, 'ia')).toEqual([4, 5]);
      expect(longPairToBigInt((back.value.la as { value: [number, number][] }).value[0])).toBe(9n);
    }
  });
  it('accessors return defaults and nested compounds', () => {
    const root = T.comp({ inner: T.comp({ x: T.short(3) }), arr: T.byteArray([-1, 2]) }, '');
    expect(num(root.value, 'missing', 42)).toBe(42);
    expect(str(root.value, 'missing', 'd')).toBe('d');
    expect(num(compound(root.value, 'inner')!, 'x')).toBe(3);
    expect(bytes(root.value, 'arr')).toEqual([-1, 2]);
    expect(listOf(root.value, 'nope')).toEqual([]);
  });

  it('round-trips longs through bigIntToLongPair/longPairToBigInt, including negatives', () => {
    const cases = [
      -1n,
      -123456789012345n,
      12345678901234n,
      2n ** 53n + 1n, // above Number.MAX_SAFE_INTEGER
      0n,
      -(2n ** 63n), // most negative signed 64-bit long
      2n ** 63n - 1n, // most positive signed 64-bit long
    ];
    for (const v of cases) {
      expect(longPairToBigInt(bigIntToLongPair(v))).toBe(v);
    }
  });

  it('produces identical bit patterns for signed and unsigned interpretations', () => {
    // longPairToBigInt is also used by unpackLongs (src/world/anvil.ts) to shift-and-mask out
    // packed bit fields, which only care about the bit pattern, not the sign. Confirm that
    // shifting/masking a long whose top bit is set gives the same bits either way.
    const pair: [number, number] = bigIntToLongPair(-1n); // all 64 bits set
    const signed = longPairToBigInt(pair);
    const unsigned = (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0);
    expect(signed).toBe(-1n);
    expect(unsigned).toBe(2n ** 64n - 1n);
    const mask = 0xffn;
    for (let shift = 0n; shift < 64n; shift += 8n) {
      expect((signed >> shift) & mask).toBe((unsigned >> shift) & mask);
    }
  });
});
