/**
 * Gmail through the user's own Google connection: search, read and send. The functions that talk to
 * Google take an access token; everything else here is plain data handling.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function addresses(list: string[] | undefined, what: string): string[] {
  const out = (list ?? []).map((a) => String(a).trim()).filter(Boolean);
  for (const a of out) if (!ADDRESS.test(a)) throw new Error(`"${a.slice(0, 80)}" is not an email address (${what})`);
  return out;
}

/** A header value on one line: an encoded word when it has anything beyond plain ASCII. */
function headerText(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

export interface OutgoingMessage { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; inReplyTo?: string }

/** The message as Gmail's send endpoint wants it: an RFC 822 text, base64url encoded. */
export function buildRawMessage(m: OutgoingMessage): string {
  const to = addresses(m.to, 'to');
  if (!to.length) throw new Error('A message needs at least one recipient');
  const cc = addresses(m.cc, 'cc');
  const bcc = addresses(m.bcc, 'bcc');
  if (m.inReplyTo !== undefined && !/^<[^<>\s]+>$/.test(m.inReplyTo)) throw new Error('inReplyTo is not a message id (it looks like <id@host>)');
  const lines = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${headerText(m.subject ?? '')}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const header = (msg: any, name: string): string | undefined =>
  (msg?.payload?.headers as { name: string; value: string }[] | undefined)?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

export function messageSummary(msg: any) {
  return {
    id: String(msg.id), threadId: String(msg.threadId ?? ''),
    from: header(msg, 'From') ?? '', to: header(msg, 'To') ?? '', subject: header(msg, 'Subject') ?? '', date: header(msg, 'Date') ?? '',
    snippet: String(msg.snippet ?? ''), unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD'),
    messageId: header(msg, 'Message-ID') ?? '',
  };
}

const decodePart = (part: any): string => (part?.body?.data ? Buffer.from(String(part.body.data), 'base64url').toString('utf8') : '');

function findPart(part: any, mime: string): any {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6])>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** The readable text of a message: its plain-text part, or its HTML with the markup removed. */
export function messageText(msg: any, max = 20_000): string {
  const plain = findPart(msg?.payload, 'text/plain');
  const html = plain ? undefined : findPart(msg?.payload, 'text/html');
  const text = plain ? decodePart(plain) : html ? htmlToText(decodePart(html)) : '';
  return text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]` : text;
}

async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Gmail: ${data?.error?.message ?? res.statusText} (${res.status})`);
  return data;
}

/** Messages matching a Gmail search (the same syntax as the Gmail search box), newest first. */
export async function searchMessages(token: string, query: string, max = 10) {
  const list = await call(token, `/messages?maxResults=${Math.max(1, Math.min(25, max))}&q=${encodeURIComponent(query)}`);
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const meta = '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID';
  return Promise.all(ids.map(async (id) => messageSummary(await call(token, `/messages/${encodeURIComponent(id)}?format=metadata${meta}`))));
}

export async function readMessage(token: string, id: string) {
  const msg = await call(token, `/messages/${encodeURIComponent(id)}?format=full`);
  return { ...messageSummary(msg), text: messageText(msg) };
}

export async function sendMessage(token: string, m: OutgoingMessage & { threadId?: string }) {
  const sent = await call(token, '/messages/send', { method: 'POST', body: { raw: buildRawMessage(m), ...(m.threadId ? { threadId: m.threadId } : {}) } });
  return { id: String(sent.id), threadId: String(sent.threadId ?? '') };
}
