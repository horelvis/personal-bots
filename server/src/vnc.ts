import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { userFromCookieHeader } from './lib/auth.js';
import { vncAuthResponse } from './lib/des.js';
import { WatchFilter } from './lib/rfb.js';
import { orgo } from './orgo.js';
import { env } from './env.js';
import { dockerBox } from './dockerbox.js';
import { readyScreen, screenFor } from './computer.js';
import { viewerClosed, viewerOpened } from './idle.js';

/**
 * VNC relay: browser <-> our server <-> Orgo websockify, or the local box's VNC server (HQ_BOX=docker).
 * The server performs the RFB handshake upstream with the computer's VNC password
 * (which is root-equivalent and never reaches the browser), then offers the browser
 * an unauthenticated RFB session. In "watch" mode, client input messages
 * (KeyEvent, PointerEvent, ClientCutText) are dropped server-side.
 */

class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void, password: string): Promise<Buffer> {
  await q.read(12); // server ProtocolVersion
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) {
    const len = (await q.read(4)).readUInt32BE();
    throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
  }
  const types = [...(await q.read(n))];
  const choice = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
  if (choice < 0) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([choice]));
  if (choice === 2) {
    const challenge = await q.read(16);
    send(vncAuthResponse(password, challenge));
  }
  const result = (await q.read(4)).readUInt32BE();
  if (result !== 0) {
    let reason = '';
    try { const len = (await q.read(4)).readUInt32BE(); reason = (await q.read(len)).toString(); } catch { /* none */ }
    throw new Error(`VNC auth failed ${reason}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const nameLen = head.readUInt32BE(20);
  const name = await q.read(nameLen);
  return Buffer.concat([head, name]);
}

async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, serverInit: Buffer) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
  send(serverInit);
}

/** The computer's side of the relay: a WebSocket to Orgo, or a plain TCP socket to the local box. */
interface Upstream {
  password: string;
  send(b: Buffer): void;
  close(): void;
  isOpen(): boolean;
  onData(f: (b: Buffer) => void): void;
  /** Called once, when the connection ends or fails. */
  onEnd(f: (reason: string, failed: boolean) => void): void;
  /** Settles when the connection is established (or could not be). */
  opened: Promise<void>;
}

async function connectUpstream(computerId: string, screenId: string): Promise<Upstream> {
  if (env.dockerBox) {
    const { host, port, password } = dockerBox.vnc(screenId);
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const opened = new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
    return {
      password,
      opened,
      send: (b) => { sock.write(b); },
      close: () => { sock.destroy(); },
      isOpen: () => !sock.destroyed && sock.readyState === 'open',
      onData: (f) => { sock.on('data', f); },
      onEnd: (f) => {
        let told = false;
        const once = (reason: string, failed: boolean) => { if (!told) { told = true; f(reason, failed); } };
        sock.on('error', (e) => once(String(e.message), true));
        sock.on('close', () => once('upstream closed', false));
      },
    };
  }
  const { password } = await orgo.vncPassword(computerId);
  const upUrl = `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : ''}`;
  const ws = new WebSocket(upUrl, ['binary']);
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  return {
    password,
    opened,
    send: (b) => { ws.send(b); },
    close: () => { ws.close(); },
    isOpen: () => ws.readyState === WebSocket.OPEN,
    onData: (f) => { ws.on('message', (data: Buffer) => f(Buffer.from(data))); },
    onEnd: (f) => {
      let told = false;
      const once = (reason: string, failed: boolean) => { if (!told) { told = true; f(reason, failed); } };
      ws.on('error', (e) => once(String(e), true));
      ws.on('close', (code, reason) => once(`upstream ${code} ${reason}`, false));
    },
  };
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => relay(client, user.id, bot.id, mode));
  });
}

async function relay(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: Upstream | null = null;
  let piping = false;
  const filter = new WatchFilter();
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    try { upstream?.close(); } catch { /* */ }
  };

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const fwd = mode === 'watch' ? filter.feed(Buffer.from(data)) : Buffer.from(data);
    if (fwd.length && upstream?.isOpen()) upstream.send(fwd);
  });
  client.on('close', () => { viewerClosed(userId); fromClient.close(new Error('client closed')); try { upstream?.close(); } catch { /* */ } });
  viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)

  try {
    const { computerId, screenId } = await screenFor(userId, botId);
    // A screen nobody has used yet is bare; set it up while the person is already watching.
    readyScreen(userId, botId).catch(() => {});
    const up = await connectUpstream(computerId, screenId);
    upstream = up;
    up.onData((data) => {
      if (!piping) return fromUp.push(data);
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    up.onEnd((reason, failed) => { fromUp.close(new Error(reason)); closeAll(failed ? 1011 : 1000, reason); });
    await up.opened;

    const serverInit = await upstreamHandshake(fromUp, (b) => up.send(b), up.password);
    await browserHandshake(fromClient, (b) => client.send(b), serverInit);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) {
      const fwd = mode === 'watch' ? filter.feed(leftoverClient) : leftoverClient;
      if (fwd.length) up.send(fwd);
    }
  } catch (e: any) {
    console.warn('[vnc] relay failed', e?.message ?? e);
    closeAll(1011, String(e?.message ?? e));
  }
}
