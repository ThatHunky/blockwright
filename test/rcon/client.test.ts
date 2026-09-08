import net from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RconClient, RconError, encodePacket, decodePackets } from '../../src/rcon/client.js';
import { FakeRcon } from '../helpers/fake-rcon.js';

/**
 * Delays the very next call to net.Socket.prototype.destroy() across the
 * whole process by `delayMs`, then restores the original implementation
 * (both when it fires, and via the returned `restore` as a safety net in
 * case it's never invoked). Used to simulate a discarded socket's 'close'
 * event arriving late, after a new socket has already taken over.
 */
function delayNextSocketDestroy(delayMs: number): { restore: () => void } {
  const original = net.Socket.prototype.destroy;
  net.Socket.prototype.destroy = function (this: net.Socket, ...args: unknown[]): net.Socket {
    net.Socket.prototype.destroy = original;
    setTimeout(() => (original as (...a: unknown[]) => unknown).apply(this, args), delayMs);
    return this;
  } as typeof net.Socket.prototype.destroy;
  return {
    restore: () => {
      net.Socket.prototype.destroy = original;
    },
  };
}

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

  it('ignores a late close event from a socket discarded by reconnect', async () => {
    fake.handler = (cmd) => `ok:${cmd}`;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret' });
    await client.connect();
    expect(await client.send('one')).toBe('ok:one');

    // Arrange for the socket that the upcoming connect() discards to only
    // actually destroy (and thus emit 'close') 50ms from now, i.e. well
    // after the *new* socket has a real exchange pending.
    const { restore } = delayNextSocketDestroy(50);
    try {
      await client.connect(); // internally: close() destroys the old socket (delayed), then a new socket is authed

      // Make sure the server's reply to the next command arrives after the
      // delayed close of the discarded socket has had a chance to fire.
      fake.responseDelayMs = 150;
      const pending = client.send('two');

      // This is the actual race: the discarded socket's delayed 'close'
      // fires while `pending` is in flight on the new socket. A close
      // handler that doesn't check socket identity will incorrectly fail
      // it with a spurious "RCON connection closed" error.
      await expect(pending).resolves.toBe('ok:two');
    } finally {
      restore();
      fake.responseDelayMs = 0;
    }
  });

  it('times out when the server never answers', async () => {
    fake.handler = () => null;
    client = new RconClient({ host: '127.0.0.1', port: fake.port, password: 'secret', timeoutMs: 200 });
    await expect(client.send('slow')).rejects.toThrow(/timeout.*slow/);
    await expect(client.send('slow')).rejects.toBeInstanceOf(RconError);
  });
});
