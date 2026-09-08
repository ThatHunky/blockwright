import { describe, it, expect } from 'vitest';
import { NAME, VERSION } from '../src/version.js';

describe('version', () => {
  it('exposes the package name and a semver version', () => {
    expect(NAME).toBe('blockwright');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
