import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { forwardModelRequest, MODEL_PATHS, placeholderToken } from './model-proxy.js';

/** A stand-in provider that records what reached it and streams two chunks back. */
async function upstream() {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
      res.write('event: a\ndata: 1\n\n');
      setTimeout(() => res.end('event: b\ndata: 2\n\n'), 20);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const secret = 'test-secret';
const real = 'sk-ant-oat01-REAL-TOKEN-ON-THE-HOST';

test('the placeholder token is per bot and never the real one', () => {
  assert.notEqual(placeholderToken(secret, 'bot_a'), placeholderToken(secret, 'bot_b'));
  assert.match(placeholderToken(secret, 'bot_a'), /^sk-ant-oat01-hq-[0-9a-f]{64}$/);
});

test('a model request is forwarded with the real token instead of the placeholder', async () => {
  const up = await upstream();
  try {
    const req = new Request('http://gate/cli-model/bot_a/v1/messages?beta=true', {
      method: 'POST',
      headers: { authorization: `Bearer ${placeholderToken(secret, 'bot_a')}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json', cookie: 'hq=1', 'x-api-key': 'leak' },
      body: '{"model":"x"}',
    });
    const res = await forwardModelRequest(req, { botId: 'bot_a', path: '/v1/messages', secret, token: real, upstream: up.url });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    const got = up.seen[0];
    assert.equal(got.url, '/v1/messages?beta=true');
    assert.equal(got.method, 'POST');
    assert.equal(got.body, '{"model":"x"}');
    assert.equal(got.headers.authorization, `Bearer ${real}`);
    assert.equal(got.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.headers['x-api-key'], undefined);
  } finally { up.close(); }
});

test('a wrong token, another bot\'s token, an unknown path or no real token is refused before the provider', async () => {
  const up = await upstream();
  try {
    const call = (auth: string, path = '/v1/messages', token = real) =>
      forwardModelRequest(new Request(`http://gate/cli-model/bot_a${path}`, { method: 'POST', headers: { authorization: auth }, body: '{}' }), { botId: 'bot_a', path, secret, token, upstream: up.url });
    assert.equal((await call('Bearer nope')).status, 401);
    assert.equal((await call(`Bearer ${placeholderToken(secret, 'bot_b')}`)).status, 401);
    assert.equal((await call('')).status, 401);
    assert.equal((await call(`Bearer ${placeholderToken(secret, 'bot_a')}`, '/v1/files')).status, 403);
    assert.equal((await call(`Bearer ${placeholderToken(secret, 'bot_a')}`, '/v1/messages/../files')).status, 403);
    const none = await call(`Bearer ${placeholderToken(secret, 'bot_a')}`, '/v1/messages', '');
    assert.equal(none.status, 503);
    assert.match(await none.text(), /setup-token/);
    assert.equal(up.seen.length, 0);
  } finally { up.close(); }
});

test('only the provider paths Claude Code uses are allowed', () => {
  assert.deepEqual([...MODEL_PATHS].sort(), ['/api/hello', '/v1/messages', '/v1/messages/count_tokens']);
});
