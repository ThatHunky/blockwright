import { describe, it, expect } from 'vitest';
import { T, parseNbt, writeNbtGz, writeNbtRaw, num, str, compound, listOf, intList, bytes, longPairToBigInt } from '../../src/nbt/nbt.js';

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
});
