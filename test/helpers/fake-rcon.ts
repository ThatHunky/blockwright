import net from 'node:net';
import { encodePacket, decodePackets } from '../../src/rcon/client.js';

/** Minimal Minecraft-compatible RCON server: auth, 4096-byte fragmentation, "Unknown request" for other types. */
export class FakeRcon {
  readonly commands: string[] = [];
  /** Return the response text, or null to never answer (for timeout tests). */
  handler: (cmd: string) => string | null = () => '';
  /** Delay, in ms, before writing a command's response packet(s). 0 (default) writes immediately, same as before this field existed. */
  responseDelayMs = 0;
  password = 'secret';
  port = 0;
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buf: Buffer = Buffer.alloc(0);
      let authed = false;
      // Once a command handler withholds a response (returns null, for
      // timeout tests), the connection is treated as stalled: nothing more
      // is answered on it, including a sentinel that arrives in a later,
      // separate TCP data event (the client's command and sentinel writes
      // are not guaranteed to be coalesced into one event).
      let stalled = false;
      // All writes for this connection go through this chain so that an
      // artificially delayed command response (responseDelayMs) still lands
      // on the wire before a sentinel reply that arrived right behind it in
      // the same 'data' event, preserving the framing order the real
      // protocol (and RconClient) depends on.
      let writeChain: Promise<void> = Promise.resolve();
      const enqueueWrite = (fn: () => void, delayMs = 0): void => {
        writeChain = writeChain.then(
          () =>
            new Promise<void>((resolve) => {
              if (delayMs > 0) {
                setTimeout(() => {
                  fn();
                  resolve();
                }, delayMs);
              } else {
                fn();
                resolve();
              }
            }),
        );
      };
      socket.on('data', (d) => {
        if (stalled) return;
        buf = Buffer.concat([buf, d]);
        const { packets, rest } = decodePackets(buf);
        buf = rest;
        for (const p of packets) {
          if (p.type === 3) {
            authed = p.body === this.password;
            enqueueWrite(() => socket.write(encodePacket(authed ? p.id : -1, 2, '')));
          } else if (p.type === 2) {
            if (!authed) {
              enqueueWrite(() => socket.write(encodePacket(-1, 2, '')));
              continue;
            }
            this.commands.push(p.body);
            const out = this.handler(p.body);
            if (out === null) {
              stalled = true;
              return;
            }
            enqueueWrite(() => {
              let start = 0;
              do {
                socket.write(encodePacket(p.id, 0, out.slice(start, start + 4096)));
                start += 4096;
              } while (start < out.length);
            }, this.responseDelayMs);
          } else {
            enqueueWrite(() => socket.write(encodePacket(p.id, 0, `Unknown request ${p.type.toString(16)}`)));
          }
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
