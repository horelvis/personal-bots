import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../env.js';
import { hub } from '../lib/hub.js';
import { appendRow, getBotRow, listBots } from '../store.js';
import { enqueue, resolveApproval } from '../agent/loop.js';
import { alwaysAllowOffered } from '../agent/cli/tools.js';
import type { Row, ServerEvent } from '../types.js';
import { cardMessage, outcomeText, parseButton, pickBot, type Button } from './route.js';

/**
 * Telegram (R11): one Telegram bot for the server, polled with getUpdates. A Telegram account
 * linked to a user talks to that user's bots; their replies and approval cards come back there.
 */

const LINK_MINUTES = 10;

async function tg<T = any>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${env.telegramApiUrl}/bot${env.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(`Telegram ${method}: ${data?.description ?? res.status}`);
  return data.result as T;
}

const keyboard = (rows: Button[][]) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.label, callback_data: b.data }))) });
const send = (chatId: string, text: string, buttons?: Button[][]) =>
  tg<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), ...(buttons ? { reply_markup: keyboard(buttons) } : {}) });
/** A reply that may fail without consequence (the chat was closed, Telegram is down). */
const say = (chatId: string, text: string) => send(chatId, text).then(() => undefined, (e) => console.warn('[telegram] send:', e?.message ?? e));

// ---------- linking ----------

let botUsername: string | null = null;
export const telegramEnabled = () => !!env.telegramToken;

export function telegramStatus(userId: string) {
  const u = db.prepare('SELECT telegram_user_id FROM users WHERE id=?').get(userId) as any;
  return { configured: telegramEnabled(), botUsername, linked: !!u?.telegram_user_id };
}

/** A one-time code the user sends to the Telegram bot (as a t.me link) to link their account. */
export function newLinkCode(userId: string): { code: string; url: string | null; expiresAt: number } {
  db.prepare('DELETE FROM telegram_links WHERE user_id=? OR expires_at<?').run(userId, Date.now());
  const code = crypto.randomBytes(12).toString('base64url');
  const expiresAt = Date.now() + LINK_MINUTES * 60_000;
  db.prepare('INSERT INTO telegram_links(code,user_id,expires_at) VALUES (?,?,?)').run(code, userId, expiresAt);
  return { code, url: botUsername ? `https://t.me/${botUsername}?start=${code}` : null, expiresAt };
}

export function unlinkTelegram(userId: string) {
  db.prepare('UPDATE users SET telegram_user_id=NULL, telegram_chat_id=NULL WHERE id=?').run(userId);
}

const userByTelegram = (telegramUserId: string): { id: string; telegram_chat_id: string } | undefined =>
  db.prepare('SELECT id, telegram_chat_id FROM users WHERE telegram_user_id=?').get(telegramUserId) as any;
const chatOf = (userId: string): string | null => (db.prepare('SELECT telegram_chat_id FROM users WHERE id=?').get(userId) as any)?.telegram_chat_id ?? null;

function link(code: string, telegramUserId: string, chatId: string): boolean {
  const row = db.prepare('SELECT user_id FROM telegram_links WHERE code=? AND expires_at>=?').get(code, Date.now()) as any;
  if (!row) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM telegram_links WHERE code=?').run(code);
    // One account, one user: linking here unlinks it anywhere else.
    db.prepare('UPDATE users SET telegram_user_id=NULL, telegram_chat_id=NULL WHERE telegram_user_id=?').run(telegramUserId);
    db.prepare('UPDATE users SET telegram_user_id=?, telegram_chat_id=? WHERE id=?').run(telegramUserId, chatId, row.user_id);
  })();
  return true;
}

// ---------- incoming ----------

/** Bots whose replies go back to Telegram: until the turn the message started has ended. */
const replying = new Map<string, { chatId: string; started: boolean }>();
const forwarded = new Set<string>();

async function onMessage(m: any) {
  const chatId = String(m.chat?.id ?? '');
  const from = String(m.from?.id ?? '');
  const text = typeof m.text === 'string' ? m.text : '';
  if (!chatId || !from || m.chat?.type !== 'private') return;
  const start = /^\/start(?:@\S+)?(?:\s+(\S+))?/.exec(text);
  if (start) {
    if (start[1] && link(start[1], from, chatId)) return say(chatId, 'Linked. Write here to talk to your main Bot, or start with "Name:" to talk to another one.');
    if (!userByTelegram(from)) return say(chatId, 'This bot is private. To use it, open Settings → Telegram in the app and follow the link there.');
    return say(chatId, 'You are linked. Write here to talk to your main Bot, or start with "Name:" to talk to another one.');
  }
  const user = userByTelegram(from);
  if (!user) return say(chatId, 'This bot is private. To use it, open Settings → Telegram in the app and follow the link there.');
  if (!text.trim()) return say(chatId, 'Only text messages work here for now.');
  const bots = listBots(user.id).filter((b) => b.kind !== 'room').map((b) => ({ id: b.id, name: b.name, isPrimary: b.isPrimary }));
  const picked = pickBot(text, bots);
  if (!picked) return say(chatId, 'You have no Bots yet. Create one in the app.');
  const bot = getBotRow(picked.botId);
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text: picked.text });
  replying.set(bot.id, { chatId: user.telegram_chat_id ?? chatId, started: false });
  enqueue(bot.id, { type: 'user', text: picked.text });
}

async function onButton(q: any) {
  const from = String(q.from?.id ?? '');
  const user = userByTelegram(from);
  const parsed = parseButton(String(q.data ?? ''));
  if (!user || !parsed) return void tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Not available.' }).catch(() => {});
  const ap = db.prepare('SELECT status FROM approvals WHERE id=?').get(parsed.approvalId) as any;
  try {
    // The same path as the app's buttons: it checks the approval is this user's and answers it only once.
    resolveApproval(user.id, parsed.approvalId, parsed.decision);
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: ap?.status === 'pending' ? 'Done.' : 'Already answered.' });
  } catch {
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Not available.' }).catch(() => {});
  }
}

// ---------- outgoing: replies and cards ----------

function onEvent(userId: string, ev: ServerEvent) {
  if (ev.type === 'live') {
    const r = replying.get(ev.state.botId);
    if (r && ev.state.isRunning) r.started = true;
    else if (r?.started && !ev.state.isRunning) replying.delete(ev.state.botId);
    return;
  }
  if (ev.type !== 'rows') return;
  const chatId = chatOf(userId);
  if (!chatId) return;
  for (const row of ev.rows) void forward(userId, chatId, row).catch((e) => console.warn('[telegram]', e?.message ?? e));
}

async function forward(userId: string, chatId: string, row: Row) {
  const b = row.body;
  const key = `${row.botId}:${row.generation}:${row.seq}`;
  if (b.type === 'message' && b.role === 'assistant' && !b.streaming && b.text.trim() && replying.has(row.botId)) {
    if (forwarded.has(key)) return;
    forwarded.add(key);
    return void (await send(replying.get(row.botId)!.chatId, `${getBotRow(row.botId)?.name ?? 'Bot'}: ${b.text}`));
  }
  if (b.type === 'notice' && b.tone === 'error' && replying.has(row.botId) && !forwarded.has(key)) {
    forwarded.add(key);
    return void (await send(chatId, `${getBotRow(row.botId)?.name ?? 'Bot'}: ${b.text}`));
  }
  if (b.type !== 'card') return;
  const name = getBotRow(row.botId)?.name ?? 'A Bot';
  if (b.card === 'approval') {
    const sent = db.prepare('SELECT * FROM telegram_cards WHERE approval_id=?').get(b.approvalId) as any;
    if (b.status === 'pending' && !sent) {
      const m = cardMessage({ botName: name, title: b.title, detail: b.detail, approvalId: b.approvalId, alwaysOffered: alwaysAllowOffered(b.tool) });
      // Claimed before sending, so two updates of the same card do not send it twice.
      db.prepare('INSERT OR IGNORE INTO telegram_cards(approval_id,chat_id,message_id,text) VALUES (?,?,?,?)').run(b.approvalId, chatId, 0, m.text);
      const msg = await send(chatId, m.text, m.buttons);
      db.prepare('UPDATE telegram_cards SET message_id=? WHERE approval_id=?').run(msg.message_id, b.approvalId);
    } else if (b.status !== 'pending' && sent?.message_id) {
      db.prepare('DELETE FROM telegram_cards WHERE approval_id=?').run(b.approvalId);
      await tg('editMessageText', { chat_id: sent.chat_id, message_id: sent.message_id, text: `${sent.text}\n\n${outcomeText(b.status)}`.slice(0, 4096) });
    }
    return;
  }
  if (forwarded.has(key) || (b as any).status !== 'pending') return;
  forwarded.add(key);
  // A sign-in needs a secret: it is never asked for here (R11.4).
  if (b.card === 'connect') return void (await send(chatId, `${name} needs ${b.toolkitName} connected: ${b.reason}\nSign in from the app: ${env.appUrl}`));
  if (b.card === 'question') return void (await send(chatId, `${name} asks: ${b.question}${b.options.length ? `\n${b.options.map((o) => `- ${o}`).join('\n')}` : ''}\nReply here with your answer.`));
  if (b.card === 'draft') return void (await send(chatId, `${name} has a draft for you to look at in the app: ${env.appUrl}`));
}

// ---------- polling ----------

let running = false;

export async function startTelegram() {
  if (!telegramEnabled() || running) return;
  running = true;
  try {
    botUsername = (await tg<{ username: string }>('getMe', {})).username ?? null;
    console.log(`[telegram] polling as @${botUsername}`);
  } catch (e: any) {
    console.error('[telegram] cannot start:', e?.message ?? e);
    running = false;
    return;
  }
  hub.tap(onEvent);
  let offset = 0;
  while (running) {
    try {
      const updates = await tg<any[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        if (u.message) await onMessage(u.message).catch((e) => console.warn('[telegram] message:', e?.message ?? e));
        if (u.callback_query) await onButton(u.callback_query).catch((e) => console.warn('[telegram] button:', e?.message ?? e));
      }
    } catch (e: any) {
      console.warn('[telegram] polling:', e?.message ?? e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
