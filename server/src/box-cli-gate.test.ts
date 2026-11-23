import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
// @ts-expect-error plain ESM script shipped in the CLI image, no type declarations
import { allowedAppPath, isPublicAddress, startGate } from '../box/cli/gate.mjs';

const notPublic = [
  // IPv4 ranges
  '0.0.0.0', '0.255.255.255',
  '10.0.0.1', '10.255.255.255',
  '100.64.0.1', '100.127.255.255',
  '127.0.0.1', '127.255.255.254',
  '169.254.169.254', '169.254.0.1',
  '172.16.0.0', '172.31.255.255',
  '192.0.0.1', '192.0.0.255',
  '192.0.2.1',
  '192.168.0.1', '192.168.255.255',
  '198.18.0.1', '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1', '239.255.255.255',
  '240.0.0.1', '255.255.255.255',
  // IPv6 ranges
  '::', '::1', '0:0:0:0:0:0:0:1',
  'fc00::1', 'fd12:3456::1',
  'fe80::1', 'fe80::1%eth0', 'febf::1',
  'ff02::1',
  '2001:db8::1', '2001:0db8:ffff::1',
  // embedded IPv4
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
  '64:ff9b::a00:1', '64:ff9b::127.0.0.1',
  // garbage
  '', 'localhost', 'not an ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '::g', 'fe80::1%', '1.2.3.4%eth0',
];

const isPublic = [
  '8.8.8.8', '1.1.1.1',
  '9.255.255.255', '11.0.0.0',
  '100.63.255.255', '100.128.0.0',
  '126.255.255.255', '128.0.0.0',
  '169.253.255.255', '169.255.0.0',
  '172.15.255.255', '172.32.0.0',
  '192.0.1.0', '192.0.3.0',
  '192.167.255.255', '192.169.0.0',
  '198.17.255.255', '198.20.0.0',
  '198.51.99.255', '198.51.101.0',
  '203.0.112.255', '203.0.114.0',
  '223.255.255.255',
  '2606:4700:4700::1111', '2001:4860:4860::8888',
  'fbff::1', 'fec0::1', '2001:db9::1',
  '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808',
];

test('isPublicAddress refuses private, loopback, link-local, reserved and malformed addresses', () => {
  for (const ip of notPublic) assert.equal(isPublicAddress(ip), false, `${JSON.stringify(ip)} should not be public`);
});

test('isPublicAddress accepts public addresses, including just outside each refused range', () => {
  for (const ip of isPublic) assert.equal(isPublicAddress(ip), true, `${ip} should be public`);
});

test('allowedAppPath lets through only the MCP and model paths', () => {
  for (const p of ['/mcp/bot_1', '/cli-model/bot_1/v1/messages?beta=true']) assert.equal(allowedAppPath(p), true, p);
  for (const p of [
    '/api/auth/dev', '/', '/mcpx', '/mcp', '/cli-model', '/mcp/../api/x', '/mcp/%2e%2e/api', '/cli-model/..%2fapi',
    '/mcp/%2E%2E/api', '/mcp/a%2fb', '/mcp/%zz', 'http://evil/mcp/x', '', '/mcp/x/..',
  ]) {
    assert.equal(allowedAppPath(p), false, p);
  }
});

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => (data += c));
    sock.on('end', () => resolve(data));
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
  });
}

test('the gate relays app paths, refuses the rest, and refuses private egress', async () => {
  const app = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`app saw ${req.url} host=${req.headers.host}`);
  });
  const appPort = await listen(app);
  const gate = await startGate({ app: `127.0.0.1:${appPort}`, appPort: 0, proxyPort: 0, host: '127.0.0.1' });
  try {
    const relayed = await get(gate.appPort, '/mcp/x?y=1');
    assert.equal(relayed.status, 200);
    assert.equal(relayed.body, `app saw /mcp/x?y=1 host=127.0.0.1:${appPort}`);

    const refused = await get(gate.appPort, '/api/x');
    assert.equal(refused.status, 403);

    const loop = await connect(gate.proxyPort, `127.0.0.1:${appPort}`);
    assert.match(loop, /^HTTP\/1\.1 403 /);
    const local = await connect(gate.proxyPort, 'localhost:80');
    assert.match(local, /^HTTP\/1\.1 403 /);
    const badPort = await connect(gate.proxyPort, '8.8.8.8:0');
    assert.match(badPort, /^HTTP\/1\.1 403 /);

    const plain = await get(gate.proxyPort, `http://127.0.0.1:${appPort}/mcp/x`);
    assert.equal(plain.status, 403);
  } finally {
    await gate.close();
    await new Promise((r) => app.close(r));
  }
});
