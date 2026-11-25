import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// R10: the evals point Gmail and Calendar at a stand-in with GOOGLE_API_URL. Set before the modules load.
const seen: string[] = [];
const server = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url!.includes('/messages?') ? '{"messages":[]}' : '{"items":[]}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.GOOGLE_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const { searchMessages } = await import('./gmail.js');
const { listEvents } = await import('./calendar.js');

test('GOOGLE_API_URL sends Gmail and Calendar requests to another base', async () => {
  try {
    await searchMessages('t', 'from:ana', 3);
    await listEvents('t', { from: '2026-11-25', to: '2026-11-26' });
    assert.match(seen[0], /^GET \/gmail\/v1\/users\/me\/messages\?maxResults=3&q=from%3Aana$/);
    assert.match(seen[1], /^GET \/calendar\/v3\/calendars\/primary\/events\?timeMin=/);
  } finally { server.close(); }
});
