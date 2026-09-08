import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, call } from '../helpers/mcp.js';
import { FakeBridge } from '../helpers/fake-bridge.js';
import { testConfig } from '../helpers/config.js';
import { isDenied, validateReplaceFilter } from '../../src/tools/server-tools.js';

let bridge: FakeBridge;
let client: Client;
beforeEach(async () => {
  bridge = new FakeBridge();
  client = await connect({ config: testConfig(), bridge });
});

describe('tool listing and info', () => {
  it('lists the server tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['server_info', 'get_players', 'run_command', 'fill']) expect(names).toContain(n);
  });
  it('server_info returns JSON with tier and masked config', async () => {
    const r = await call(client, 'server_info');
    const info = JSON.parse(r.text);
    expect(info.tier).toBe(1);
    expect(info.players).toEqual(['Steve']);
    expect(info.config.rcon.password).toBe('***');
  });
  it('get_players returns positions', async () => {
    const r = await call(client, 'get_players');
    expect(JSON.parse(r.text)[0]).toMatchObject({ name: 'Steve', pos: [0, 64, 0] });
  });
});

describe('run_command', () => {
  it('denies admin commands', () => {
    for (const c of ['stop', '/op steve', 'minecraft:ban x', 'execute as @a run kick @s', 'whitelist off', 'reload']) expect(isDenied(c), c).toBe(true);
    for (const c of ['time set day', 'say hi', 'fill 0 0 0 1 1 1 stone', 'execute as @a run tp @s 0 64 0']) expect(isDenied(c), c).toBe(false);
  });

  it('denies the doubled-leading-slash bypass (defect 1)', () => {
    for (const c of ['//stop', '///op steve', '/ /stop']) expect(isDenied(c), c).toBe(true);
  });

  it('denies admin names reached via execute ... run (defect 2)', () => {
    for (const c of ['execute as @a run rl', 'execute as @a run bukkit:reload', 'execute as @a run paper:reload confirm', 'execute as @a run banlist']) {
      expect(isDenied(c), c).toBe(true);
    }
  });

  it('denies nested execute ... run chains', () => {
    expect(isDenied('execute as @a run execute as @b run stop')).toBe(true);
  });

  it('denies commands with a newline, carriage return, or null byte anywhere in the string', () => {
    for (const c of ['time set day\nstop', 'time set day\rstop', 'time\0stop', 'stop\n']) expect(isDenied(c), JSON.stringify(c)).toBe(true);
  });

  it('still allows legitimate commands after normalisation', () => {
    for (const c of ['time set day', 'say hi', 'tp @s 0 64 0', 'fill 0 0 0 1 1 1 stone', 'execute as @a run tp @s 0 64 0']) {
      expect(isDenied(c), c).toBe(false);
    }
  });

  it('passes safe commands to the bridge and refuses others', async () => {
    const ok = await call(client, 'run_command', { command: 'time set day' });
    expect(ok.isError).toBe(false);
    expect(ok.text).toBe('ok: time set day');
    const bad = await call(client, 'run_command', { command: 'stop' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/refused/);
    expect(bridge.calls.filter((c) => c.method === 'runCommand')).toHaveLength(1);
  });

  it('refuses a command containing a newline before it ever reaches the bridge', async () => {
    const r = await call(client, 'run_command', { command: 'time set day\nstop' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/refused/);
    expect(bridge.calls.filter((c) => c.method === 'runCommand')).toHaveLength(0);
  });

  it('self-bypass attempts against isDenied all still get caught', () => {
    const bypassAttempts = [
      '//stop',
      '///op steve',
      '/ /stop',
      '\t/stop',
      '/\t/stop',
      'STOP',
      'Op steve',
      'minecraft:minecraft:stop',
      'minecraft:bukkit:paper:reload',
      'execute as @a run execute as @b run execute as @c run op steve',
      'op\tsteve',
      'op steve',
      '  stop',
      'stop  ',
    ];
    for (const c of bypassAttempts) expect(isDenied(c), JSON.stringify(c)).toBe(true);
  });
});

describe('validateReplaceFilter', () => {
  it('rejects extra tokens smuggled through replace_filter (defect 3)', () => {
    expect(validateReplaceFilter('dirt extra_token')).toMatch(/invalid replace_filter/);
  });
  it('rejects other whitespace and empty values', () => {
    expect(validateReplaceFilter('dirt\tstop')).toMatch(/invalid replace_filter/);
    expect(validateReplaceFilter('')).toMatch(/invalid replace_filter/);
    expect(validateReplaceFilter('#')).toMatch(/invalid replace_filter/);
  });
  it('accepts a plain block name, a namespaced name, a state, and a block tag', () => {
    expect(validateReplaceFilter('dirt')).toBeUndefined();
    expect(validateReplaceFilter('minecraft:dirt')).toBeUndefined();
    expect(validateReplaceFilter('oak_log[axis=y]')).toBeUndefined();
    expect(validateReplaceFilter('#minecraft:logs')).toBeUndefined();
  });
});

describe('fill', () => {
  it('replace mode sends a raw fill command', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [3, 64, 3], block: 'stone', mode: 'replace', replace_filter: 'dirt' });
    expect(r.isError).toBe(false);
    const c = bridge.calls.find((c) => c.method === 'applyCommands')!;
    expect(c.args[0]).toEqual(['fill 0 64 0 3 64 3 stone replace dirt']);
    expect(r.text).toMatch(/16 blocks/);
  });
  it('hollow mode builds walls with an air interior', async () => {
    await call(client, 'fill', { from: [0, 64, 0], to: [4, 68, 4], block: 'stone_bricks', mode: 'hollow' });
    expect(bridge.world.get(0, 64, 0)?.toCommand()).toBe('stone_bricks');
    expect(bridge.world.get(2, 66, 2)?.isAir).toBe(true);
    expect(bridge.world.size).toBe(125);
  });
  it('outline mode leaves the interior untouched', async () => {
    await call(client, 'fill', { from: [0, 64, 0], to: [4, 68, 4], block: 'stone', mode: 'outline' });
    expect(bridge.world.size).toBe(125 - 27);
  });
  it('dry run touches nothing and says so', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stone', mode: 'hollow', dry_run: true });
    expect(r.text).toMatch(/DRY RUN/);
    expect(bridge.world.size).toBe(0);
  });
  it('rejects unknown blocks with a suggestion', async () => {
    const r = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stoen' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown block "stoen".*stone/);
    const forced = await call(client, 'fill', { from: [0, 64, 0], to: [1, 64, 1], block: 'stoen', allow_unknown_blocks: true });
    expect(forced.isError).toBe(false);
  });
});
