// A stateful stand-in for the parts of Gmail and Google Calendar the app uses (server/src/google/*.ts).
// Each access token is its own mailbox and calendar, so scenarios can run side by side.
// Test hooks: PUT /_state/<token> sets a mailbox and calendar; GET /_state/<token> returns what happened.
import http from 'node:http';
import crypto from 'node:crypto';

const boxes = new Map();
const box = (token) => {
  if (!boxes.has(token)) boxes.set(token, { messages: [], events: [], sent: [], created: [], updated: [], deleted: [] });
  return boxes.get(token);
};
const id = () => crypto.randomBytes(8).toString('hex');
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const fail = (res, status, message) => json(res, status, { error: { code: status, message } });

/** Gmail search, simplified: every term must match; from:, to:, subject:, is:unread, newer_than: (ignored), plain words. */
function matches(m, q) {
  for (const raw of (q ?? '').match(/(?:[a-z_]+:)?(?:"[^"]*"|\S+)/gi) ?? []) {
    const [, field, value] = /^(?:([a-z_]+):)?(.*)$/i.exec(raw);
    const v = value.replace(/^"|"$/g, '').toLowerCase();
    if (!field) { if (!`${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(v)) return false; }
    else if (field === 'from') { if (!m.from.toLowerCase().includes(v)) return false; }
    else if (field === 'to') { if (!m.to.toLowerCase().includes(v)) return false; }
    else if (field === 'subject') { if (!m.subject.toLowerCase().includes(v)) return false; }
    else if (field === 'is' && v === 'unread') { if (!m.unread) return false; }
    else if (field === 'in' || field === 'label' || field === 'newer_than' || field === 'older_than' || field === 'after' || field === 'before' || field === 'category') { /* not modelled */ }
  }
  return true;
}

const headers = (m) => [['From', m.from], ['To', m.to], ['Subject', m.subject], ['Date', m.date], ['Message-ID', m.messageId]].map(([name, value]) => ({ name, value }));
const gmailMessage = (m, full) => ({
  id: m.id, threadId: m.threadId, labelIds: m.unread ? ['INBOX', 'UNREAD'] : ['INBOX'], snippet: m.body.slice(0, 120),
  payload: { mimeType: 'text/plain', headers: headers(m), ...(full ? { body: { data: Buffer.from(m.body, 'utf8').toString('base64url') } } : {}) },
});

/** The RFC 822 text the app sends, back to fields. */
function parseRaw(raw) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const h = {};
  for (const line of head.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const list = (v) => (v ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
  let body = rest.join('\n\n');
  if (/base64/i.test(h['content-transfer-encoding'] ?? '')) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { to: list(h.to), cc: list(h.cc), bcc: list(h.bcc), subject: h.subject ?? '', inReplyTo: h['in-reply-to'] ?? null, body };
}

const toMs = (t) => Date.parse(t?.dateTime ?? t?.date ?? '');

function route(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p.startsWith('/_state/')) {
    const token = decodeURIComponent(p.slice('/_state/'.length));
    if (req.method === 'PUT') {
      const seed = JSON.parse(body || '{}');
      boxes.set(token, {
        messages: (seed.messages ?? []).map((m, i) => ({ id: m.id ?? id(), threadId: m.threadId ?? id(), unread: m.unread ?? true, to: m.to ?? 'me@example.com', date: m.date ?? new Date(Date.now() - (i + 1) * 3600_000).toUTCString(), messageId: m.messageId ?? `<${id()}@mail.example>`, ...m })),
        events: (seed.events ?? []).map((e) => ({ id: e.id ?? id(), status: 'confirmed', ...e })),
        sent: [], created: [], updated: [], deleted: [],
      });
      return json(res, 200, { ok: true });
    }
    return json(res, 200, box(token));
  }
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(res, 401, 'no token');
  const b = box(token);

  // Gmail
  const g = '/gmail/v1/users/me';
  if (p === `${g}/messages` && req.method === 'GET') {
    const max = Number(url.searchParams.get('maxResults') ?? 10);
    const list = b.messages.filter((m) => matches(m, url.searchParams.get('q'))).sort((x, y) => Date.parse(y.date) - Date.parse(x.date)).slice(0, max);
    return json(res, 200, { messages: list.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: list.length });
  }
  if (p === `${g}/messages/send` && req.method === 'POST') {
    const { raw, threadId } = JSON.parse(body || '{}');
    const sent = { id: id(), threadId: threadId ?? id(), ...parseRaw(raw) };
    b.sent.push(sent);
    return json(res, 200, { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] });
  }
  const msg = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/.exec(p);
  if (msg && req.method === 'GET') {
    const m = b.messages.find((x) => x.id === msg[1]);
    if (!m) return fail(res, 404, 'Requested entity was not found.');
    return json(res, 200, gmailMessage(m, url.searchParams.get('format') === 'full'));
  }

  // Calendar
  const c = '/calendar/v3/calendars/primary/events';
  if (p === c && req.method === 'GET') {
    const from = Date.parse(url.searchParams.get('timeMin') ?? '') || -Infinity;
    const to = Date.parse(url.searchParams.get('timeMax') ?? '') || Infinity;
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = b.events.filter((e) => toMs(e.end) > from && toMs(e.start) < to && (!q || `${e.summary} ${e.description ?? ''} ${e.location ?? ''}`.toLowerCase().includes(q))).sort((x, y) => toMs(x.start) - toMs(y.start));
    return json(res, 200, { items });
  }
  if (p === c && req.method === 'POST') {
    const e = { id: id(), status: 'confirmed', ...JSON.parse(body || '{}') };
    b.events.push(e);
    b.created.push(e);
    return json(res, 200, e);
  }
  const ev = /^\/calendar\/v3\/calendars\/primary\/events\/([A-Za-z0-9_-]+)$/.exec(p);
  if (ev) {
    const i = b.events.findIndex((x) => x.id === ev[1]);
    if (i < 0) return fail(res, 404, 'Not Found');
    if (req.method === 'GET') return json(res, 200, b.events[i]);
    if (req.method === 'PATCH') {
      b.events[i] = { ...b.events[i], ...JSON.parse(body || '{}') };
      b.updated.push(b.events[i]);
      return json(res, 200, b.events[i]);
    }
    if (req.method === 'DELETE') {
      b.deleted.push(b.events[i]);
      b.events.splice(i, 1);
      res.writeHead(204);
      return res.end();
    }
  }
  return fail(res, 404, `not modelled: ${req.method} ${p}`);
}

export function startFakeGoogle(port = 0) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => { try { route(req, res, body); } catch (e) { fail(res, 500, String(e?.message ?? e)); } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
