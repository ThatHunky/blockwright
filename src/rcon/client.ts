import net from 'node:net';

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Per-command timeout. Default 15000. */
  timeoutMs?: number;
}

export class RconError extends Error {}

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;
/** Any unknown type; the server answers "Unknown request" with our id, which marks the end of the previous response. */
const TYPE_SENTINEL = 100;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buf.writeInt32LE(4 + 4 + payload.length + 2, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let off = 0;
  while (buffer.length - off >= 4) {
    const len = buffer.readInt32LE(off);
    if (buffer.length - off - 4 < len) break;
    packets.push({
      id: buffer.readInt32LE(off + 4),
      type: buffer.readInt32LE(off + 8),
      body: buffer.toString('utf8', off + 12, off + 4 + len - 2),
    });
    off += 4 + len;
  }
  return { packets, rest: buffer.subarray(off) };
}

interface Pending {
  id: number;
  sentinelId: number;
  auth: boolean;
  command: string;
  chunks: string[];
  finish: (body: string, id: number) => void;
  fail: (e: Error) => void;
}

export class RconClient {
  private socket: net.Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private authed = false;

  constructor(private readonly opts: RconOptions) {}

  get connected(): boolean {
    return this.authed && this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    await this.close();
    const socket = new net.Socket();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.authed = false;
    socket.on('data', (d: Buffer) => {
      // A stale socket destroyed by a preceding connect()/close() can still
      // deliver an already-buffered 'data' event after this.socket has moved
      // on to a newer socket. Ignore it so it can't corrupt this.buffer or
      // resolve/interfere with the new socket's in-flight exchange.
      if (socket !== this.socket) return;
      this.onData(d);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      // close() calls socket.destroy() without awaiting the actual 'close'
      // event, and connect() immediately swaps in a new socket. The old
      // socket's 'close' can therefore still arrive after this.socket points
      // elsewhere; ignore it so it doesn't fail an exchange belonging to the
      // new socket.
      if (socket !== this.socket) return;
      this.authed = false;
      const p = this.pending;
      this.pending = undefined;
      p?.fail(new RconError(`RCON connection closed while waiting for: ${p.command}`));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(new RconError(`RCON connect to ${this.opts.host}:${this.opts.port} failed: ${e.message}`));
      socket.once('error', onError);
      socket.connect(this.opts.port, this.opts.host, () => {
        socket.off('error', onError);
        resolve();
      });
    });
    const reply = await this.exchange(this.opts.password, true);
    if (reply.id === -1) {
      socket.destroy();
      throw new RconError('RCON authentication failed: wrong password');
    }
    this.authed = true;
  }

  /** Run one command; calls are serialized. Reconnects once if the connection is gone. */
  send(command: string): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.connected) await this.connect();
      try {
        return (await this.exchange(command, false)).body;
      } catch (e) {
        if (e instanceof RconError && /closed|not connected/.test(e.message)) {
          await this.connect();
          return (await this.exchange(command, false)).body;
        }
        throw e;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    const s = this.socket;
    this.socket = undefined;
    this.authed = false;
    if (s && !s.destroyed) s.destroy();
  }

  private exchange(body: string, auth: boolean): Promise<{ id: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.destroyed) return reject(new RconError('RCON not connected'));
      const id = this.nextId++;
      const sentinelId = auth ? -2 : this.nextId++;
      const ms = this.opts.timeoutMs ?? 15000;
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new RconError(`RCON timeout after ${ms}ms waiting for: ${auth ? '<auth>' : body}`));
      }, ms);
      this.pending = {
        id,
        sentinelId,
        auth,
        command: auth ? '<auth>' : body,
        chunks: [],
        finish: (text, replyId) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve({ id: replyId, body: text });
        },
        fail: (e) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(e);
        },
      };
      socket.write(encodePacket(id, auth ? TYPE_AUTH : TYPE_COMMAND, body));
      if (!auth) socket.write(encodePacket(sentinelId, TYPE_SENTINEL, ''));
    });
  }

  private onData(d: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, d]);
    const { packets, rest } = decodePackets(this.buffer);
    this.buffer = rest;
    for (const pkt of packets) this.handlePacket(pkt);
  }

  private handlePacket(pkt: RconPacket): void {
    const p = this.pending;
    if (!p) return;
    if (p.auth) {
      if (pkt.id === p.id || pkt.id === -1) p.finish(pkt.body, pkt.id);
      return;
    }
    if (pkt.id === p.id && pkt.type === TYPE_RESPONSE) p.chunks.push(pkt.body);
    else if (pkt.id === p.sentinelId) p.finish(p.chunks.join(''), p.id);
  }
}
