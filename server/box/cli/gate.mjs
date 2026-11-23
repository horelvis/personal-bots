// The gate: the only other member of a CLI bot's internal network.
// - App relay (GATE_APP_PORT): forwards only the MCP and model paths to the app (GATE_APP).
// - Egress proxy (GATE_PROXY_PORT): HTTP CONNECT and absolute-URI HTTP to public addresses only.
// It holds no secrets and never logs request headers.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- addresses

function parseIPv4(s) {
  if (net.isIPv4(s) !== true) return null;
  const parts = s.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const v4 = (a, b, c, d) => (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
const BLOCKED_V4 = [
  [v4(0, 0, 0, 0), 8], [v4(10, 0, 0, 0), 8], [v4(100, 64, 0, 0), 10], [v4(127, 0, 0, 0), 8],
  [v4(169, 254, 0, 0), 16], [v4(172, 16, 0, 0), 12], [v4(192, 0, 0, 0), 24], [v4(192, 0, 2, 0), 24],
  [v4(192, 168, 0, 0), 16], [v4(198, 18, 0, 0), 15], [v4(198, 51, 100, 0), 24], [v4(203, 0, 113, 0), 24],
  [v4(224, 0, 0, 0), 4], [v4(240, 0, 0, 0), 4],
];

function publicV4(n) {
  for (const [base, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === base) return false;
  }
  return true;
}

/** Expands an IPv6 literal (no zone) into 8 16-bit numbers, or null. */
function parseIPv6(s) {
  if (net.isIPv6(s) !== true) return null;
  let tail = [];
  let head = s;
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const n = parseIPv4(last);
    if (n === null) return null;
    tail = [n >>> 16, n & 0xffff];
    head = s.slice(0, lastColon + 1);
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const want = 8 - tail.length;
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toNums = (h) => (h === '' ? [] : h.split(':').map((x) => parseInt(x, 16)));
  let groups;
  if (halves.length === 2) {
    const left = toNums(halves[0]);
    const right = toNums(halves[1]);
    const fill = want - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill(0), ...right];
  } else {
    groups = toNums(head);
  }
  if (groups.length !== want || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return [...groups, ...tail];
}

/** True only for an address that is safe to reach from a bot: not private, loopback, link-local, reserved or metadata. */
export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false;
  const n4 = parseIPv4(ip);
  if (n4 !== null) return publicV4(n4);
  let s = ip;
  const pct = s.indexOf('%');
  if (pct !== -1) {
    if (pct === s.length - 1) return false;
    s = s.slice(0, pct);
  }
  const g = parseIPv6(s);
  if (g === null) return false;
  const embedded = () => publicV4(((g[6] << 16) | g[7]) >>> 0);
  // ::/96 covers :: and ::1 and the deprecated IPv4-compatible form: never public.
  if (g.slice(0, 6).every((x) => x === 0)) return false;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-translated ::ffff:0:0:0/96: judged by the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded();
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return embedded();
  // NAT64 64:ff9b::/96.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded();
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

// ---------------------------------------------------------------- app paths

const APP_PREFIXES = ['/mcp/', '/cli-model/'];

/** True only for the app paths a bot may reach: /mcp/... and /cli-model/..., with no traversal tricks. */
export function allowedAppPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return false;
  const raw = url.split(/[?#]/, 1)[0];
  if (/%2f|%5c/i.test(raw) || raw.includes('\\')) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  if (decoded.includes('\\') || decoded.includes('\0') || /%2e|%2f|%5c/i.test(decoded)) return false;
  const prefix = APP_PREFIXES.find((p) => raw.startsWith(p) && decoded.startsWith(p));
  if (!prefix || decoded.length === prefix.length) return false;
  const segments = decoded.split('/');
  return !segments.some((seg) => seg === '..' || seg === '.');
}

// ---------------------------------------------------------------- plumbing

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(headers) {
  const named = new Set(
    String(headers.connection ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  );
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || named.has(key) || v === undefined) continue;
    out[key] = v;
  }
  return out;
}

function refuseLog(host, reason) {
  process.stderr.write(`gate: refused ${JSON.stringify(String(host).slice(0, 255))}: ${reason}\n`);
}

/** Resolves host to one public IP, or returns { error }. Never re-resolved afterwards (no DNS rebinding). */
async function publicTarget(host, portText) {
  const port = /^\d{1,5}$/.test(String(portText)) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'bad port' };
  if (!host) return { error: 'no host' };
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return { error: 'does not resolve' };
    }
  }
  const ip = addresses.find((a) => isPublicAddress(a));
  if (!ip) return { error: 'not a public address' };
  return { ip, port };
}

/** Splits "host:port" or "[v6]:port". */
function splitHostPort(target) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:\[\]]+):(\d+)$/.exec(target);
  return m ? { host: m[1], port: m[2] } : null;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return sockets;
}

// ---------------------------------------------------------------- servers

function appRelay(app) {
  const target = splitHostPort(app);
  if (!target) throw new Error(`GATE_APP must be host:port, got ${JSON.stringify(app)}`);
  const server = http.createServer((req, res) => {
    if (!allowedAppPath(req.url ?? '')) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden\n');
      return;
    }
    const headers = { ...cleanHeaders(req.headers), host: app };
    const up = http.request(
      { host: target.host, port: Number(target.port), method: req.method, path: req.url, headers, agent: false },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, cleanHeaders(upRes.headers));
        res.flushHeaders();
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway\n');
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.requestTimeout = 0;
  return server;
}

function egressProxy() {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('absolute http:// URL required\n');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('only http:// here, use CONNECT for https\n');
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const t = await publicTarget(host, url.port || '80');
    if (t.error) {
      refuseLog(host, t.error);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden\n');
      return;
    }
    const headers = { ...cleanHeaders(req.headers), host: url.host };
    const up = http.request(
      { host: t.ip, port: t.port, method: req.method, path: url.pathname + url.search, headers, agent: false, setHost: false },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, cleanHeaders(upRes.headers));
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway\n');
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.requestTimeout = 0;
  server.on('connect', async (req, client, head) => {
    client.on('error', () => client.destroy());
    const hp = splitHostPort(req.url ?? '');
    const t = hp ? await publicTarget(hp.host, hp.port) : { error: 'bad target' };
    if (t.error) {
      refuseLog(hp?.host ?? req.url, t.error);
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    let connected = false;
    const up = net.connect(t.port, t.ip, () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => {
      if (!connected && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  return server;
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

/** Starts both servers. Returns their bound ports and close(). */
export async function startGate({ app, appPort = 8787, proxyPort = 3128, host = '0.0.0.0' }) {
  const relay = appRelay(app);
  const proxy = egressProxy();
  const sockets = [trackSockets(relay), trackSockets(proxy)];
  const boundApp = await listenOn(relay, appPort, host);
  let boundProxy;
  try {
    boundProxy = await listenOn(proxy, proxyPort, host);
  } catch (err) {
    relay.close();
    throw err;
  }
  const close = () =>
    new Promise((resolve) => {
      let left = 2;
      const done = () => --left === 0 && resolve();
      relay.close(done);
      proxy.close(done);
      for (const set of sockets) for (const s of set) s.destroy();
    });
  return { appPort: boundApp, proxyPort: boundProxy, close };
}

// ---------------------------------------------------------------- main

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = process.env.GATE_APP;
  if (!app) {
    process.stderr.write('gate: GATE_APP (host:port of the app) is required\n');
    process.exit(2);
  }
  const port = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const gate = await startGate({
    app,
    appPort: port(process.env.GATE_APP_PORT, 8787),
    proxyPort: port(process.env.GATE_PROXY_PORT, 3128),
  });
  process.stderr.write(`gate: app relay on :${gate.appPort} -> ${app}, egress proxy on :${gate.proxyPort}\n`);
  const stop = () => gate.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
