import type { Config } from '../../src/config.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rcon: { host: '127.0.0.1', port: 0, password: 'secret' },
    serverDir: undefined,
    levelName: 'world',
    pluginUrl: 'http://127.0.0.1:25580',
    pluginToken: undefined,
    bounds: undefined,
    fillLimit: 32768,
    structureThreshold: 400,
    templateMax: 48,
    schematicDir: '/tmp',
    previewDir: '/tmp',
    dataVersion: 4903,
    mcVersion: '26.2',
    allowAdmin: false,
    bluemapUrl: undefined,
    saveCoalesceMs: 30000,
    ...overrides,
  };
}
