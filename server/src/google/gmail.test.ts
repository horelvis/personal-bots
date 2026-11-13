import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRawMessage, describeSend, messageSummary, messageText, safeId } from './gmail.js';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

test('a message is built with the given recipients, an encoded subject and the body', () => {
  const mime = decode(buildRawMessage({ to: ['ana@example.com', 'luis@example.com'], cc: ['eva@example.com'], subject: 'Reunión mañana', body: 'Hola,\nnos vemos a las 10.' }));
  assert.match(mime, /^To: ana@example\.com, luis@example\.com\r\n/m);
  assert.match(mime, /^Cc: eva@example\.com\r\n/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/m);
  assert.match(mime, /^Content-Type: text\/plain; charset="UTF-8"\r\n/m);
  const body = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, 'Hola,\nnos vemos a las 10.');
});

test('a reply carries the headers that keep it in its thread', () => {
  const mime = decode(buildRawMessage({ to: ['ana@example.com'], subject: 'Re: Hi', body: 'ok', inReplyTo: '<abc@mail.example>' }));
  assert.match(mime, /^In-Reply-To: <abc@mail\.example>\r\n/m);
  assert.match(mime, /^References: <abc@mail\.example>\r\n/m);
});

test('addresses or a subject that would add headers are refused', () => {
  assert.throws(() => buildRawMessage({ to: ['ana@example.com\r\nBcc: spy@example.com'], subject: 's', body: 'b' }), /address/i);
  assert.throws(() => buildRawMessage({ to: ['not an address'], subject: 's', body: 'b' }), /address/i);
  assert.throws(() => buildRawMessage({ to: [], subject: 's', body: 'b' }), /recipient/i);
  assert.throws(() => buildRawMessage({ to: ['ana@example.com'], subject: 's', body: 'b', inReplyTo: '<a@b>\r\nBcc: spy@example.com' }), /message id/i);
  const mime = decode(buildRawMessage({ to: ['ana@example.com'], subject: 'Hi\r\nBcc: spy@example.com', body: 'b' }));
  assert.equal(/^Bcc:/m.test(mime), false);
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const message = {
  id: 'm1', threadId: 't1', snippet: 'Hello Ana', labelIds: ['INBOX', 'UNREAD'],
  payload: {
    headers: [{ name: 'From', value: 'Luis <luis@example.com>' }, { name: 'to', value: 'ana@example.com' }, { name: 'Subject', value: 'Hello' }, { name: 'Date', value: 'Fri, 13 Nov 2026 10:00:00 +0100' }, { name: 'Message-ID', value: '<abc@mail.example>' }],
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/plain', body: { data: b64('Hello Ana,\nthis is the text.') } }, { mimeType: 'text/html', body: { data: b64('<p>Hello <b>Ana</b></p>') } }],
  },
};

test('a message is summarised from its headers, whatever their case', () => {
  assert.deepEqual(messageSummary(message), { id: 'm1', threadId: 't1', from: 'Luis <luis@example.com>', to: 'ana@example.com', subject: 'Hello', date: 'Fri, 13 Nov 2026 10:00:00 +0100', snippet: 'Hello Ana', unread: true, messageId: '<abc@mail.example>' });
});

test('the text of a message prefers plain text, falls back to stripped HTML, and is cut when long', () => {
  assert.equal(messageText(message), 'Hello Ana,\nthis is the text.');
  const htmlOnly = { payload: { mimeType: 'text/html', body: { data: b64('<style>p{}</style><p>Hello <b>Ana</b></p><script>x()</script><p>Bye &amp; thanks</p>') } } };
  assert.equal(messageText(htmlOnly), 'Hello Ana\nBye & thanks');
  const nested = { payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('deep') } }] }] } };
  assert.equal(messageText(nested), 'deep');
  const long = { payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(50)) } } };
  assert.equal(messageText(long, 20), `${'x'.repeat(20)}\n[cut: 30 more characters]`);
  assert.equal(messageText({ payload: {} }), '');
});

test('an entity that names no character is left as it is, and the rest is still read', () => {
  const odd = { payload: { mimeType: 'text/html', body: { data: b64('<p>hi &#99999999; and &#xFFFFFFFF; there &#65;</p>') } } };
  assert.equal(messageText(odd), 'hi &#99999999; and &#xFFFFFFFF; there A');
});

test('what the user is asked to approve names everyone the message goes to, and shows the text', () => {
  const detail = describeSend({ to: ['ana@example.com'], cc: ['eva@example.com'], bcc: ['hidden@example.com'], subject: 'Q3 report', body: 'Here it is.', in_reply_to: '<abc@mail.example>' });
  assert.equal(detail, 'To: ana@example.com\nCc: eva@example.com\nBcc: hidden@example.com\nSubject: Q3 report\nReply in an existing thread\n\nHere it is.');
  assert.equal(describeSend({ to: 'ana@example.com, luis@example.com', subject: 's', body: 'b' }), 'To: ana@example.com, luis@example.com\nSubject: s\n\nb');
  const long = describeSend({ to: ['ana@example.com'], subject: 's', body: 'x'.repeat(2000) });
  assert.match(long, /x{1200}\n\[\+800 more characters\]$/);
  assert.equal(describeSend({ subject: 's', body: 'b' }), 'To: (nobody)\nSubject: s\n\nb');
});

test('ids that could change the address of a request are refused', () => {
  assert.equal(safeId('18c2f0a1b2c3d4e5'), '18c2f0a1b2c3d4e5');
  assert.equal(safeId('abc_DEF-123'), 'abc_DEF-123');
  for (const bad of ['..', '.', '', 'a/b', 'a?b=1', 'a b', 'a%2Fb']) assert.throws(() => safeId(bad), /id/i, bad);
});
