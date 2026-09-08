import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RconClient, RconError, encodePacket, decodePackets } from '../../src/rcon/client.js';
import { FakeRcon } from '../helpers/fake-rcon.js';

describe('packet framing', () => {
  it('round-trips packets and leaves partial data in rest', () => {
    const a = encodePacket(7, 2, 'list');
    const b = encodePacket(8, 100, '');
    const joined = Buffer.concat([a, b, Buffer.from([1, 2, 3])]);
    const { packets, rest } = decodePackets(joined);
    expect(packets).toEqual([
      { id: 7, type: 2, body: 'list' },
      { id: 8, type: 100, body: '' },
    ]);
    expect(rest.length).toBe(3);
    expect(a.readInt32LE(0)).toBe(4 + 4 + 4 + 2);
  });
});

describe('RconClient', () => {
  let fake: FakeRcon;
  let client: RconClient;
  beforeEach(async () => {
    fake = new FakeRcon();
    await fake.start();
  });
  afterEach(async () => {
    await client?.close();
    await fake.stop();
  });

  it('authenticates and sends a command', async () => {
    fake.handler = (cmd) => `echo:${cmd}`;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    await client.connect();
    expect(await client.send('list')).toBe('echo:list');
    expect(fake.commands).toEqual(['list']);
  });

  it('rejects a wrong password', async () => {
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'nope' });
    await expect(client.connect()).rejects.toThrow(/authentication/);
  });

  it('reassembles long responses', async () => {
    const long = 'x'.repeat(9000) + 'END';
    fake.handler = () => long;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    expect(await client.send('help')).toBe(long);
  });

  it('serializes overlapping sends in order', async () => {
    fake.handler = (cmd) => cmd.toUpperCase();
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    const results = await Promise.all([client.send('a'), client.send('b'), client.send('c')]);
    expect(results).toEqual(['A', 'B', 'C']);
    expect(fake.commands).toEqual(['a', 'b', 'c']);
  });

  it('reconnects after the server drops the connection', async () => {
    fake.handler = (cmd) => `ok:${cmd}`;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    expect(await client.send('one')).toBe('ok:one');
    fake.dropClients();
    await new Promise((r) => setTimeout(r, 50));
    expect(await client.send('two')).toBe('ok:two');
    expect(fake.commands).toEqual(['one', 'two']);
  });

  it('times out when the server never answers', async () => {
    fake.handler = () => null;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret', timeoutMs: 200 });
    await expect(client.send('slow')).rejects.toThrow(/timeout.*slow/);
    await expect(client.send('slow')).rejects.toBeInstanceOf(RconError);
  });
});
