import crypto from 'node:crypto';
import { db } from './db.js';
import { estimateCost, type Tokens } from './lib/prices.js';
import { limitDecision, typicalCost, type LimitDecision } from './lib/spend-limit.js';

/**
 * What the bots' work cost (R9): one row per turn, per action check, per X search and per voice call.
 * Costs are US dollars at list price; null means the engine reported no usable figure ("unknown").
 */

export type SpendKind = 'turn' | 'check' | 'search' | 'voice';

export interface SpendEntry {
  userId: string;
  botId: string;
  kind: SpendKind;
  routineId?: string | null;
  model?: string | null;
  tokens?: Tokens | null;
  /** A cost the engine reported itself (Claude Code); otherwise it is estimated from the tokens. */
  costUsd?: number | null;
  at?: number;
}

export function recordSpend(e: SpendEntry) {
  try {
    const reported = typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) ? e.costUsd : null;
    const cost = reported ?? estimateCost(e.model, e.tokens);
    db.prepare(`INSERT INTO spending (id, user_id, bot_id, kind, routine_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `sp_${crypto.randomBytes(8).toString('hex')}`, e.userId, e.botId, e.kind, e.routineId ?? null, e.model ?? null,
      e.tokens?.input ?? null, e.tokens?.output ?? null, e.tokens?.cacheRead ?? null, e.tokens?.cacheWrite ?? null,
      cost, reported !== null ? 'reported' : cost !== null ? 'price-table' : 'unknown', e.at ?? Date.now(),
    );
  } catch (err: any) {
    // Bookkeeping: a failure here must never break the turn it describes.
    console.warn('[spend] could not record:', err?.message ?? err);
  }
}

/** The calendar month (UTC) holding `at`, as [start, end) in milliseconds and its 'YYYY-MM' name. */
export function monthOf(at: number, name?: string): { name: string; start: number; end: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(name ?? '');
  const d = new Date(at);
  const y = m ? Number(m[1]) : d.getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : d.getUTCMonth();
  const start = Date.UTC(y, mo, 1);
  const end = Date.UTC(y, mo + 1, 1);
  return { name: `${y}-${String(mo + 1).padStart(2, '0')}`, start, end };
}

/** Known spending of a user in the month holding `at`. */
export function monthSpend(userId: string, at = Date.now()): number {
  const { start, end } = monthOf(at);
  return Number((db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM spending WHERE user_id=? AND created_at>=? AND created_at<?').get(userId, start, end) as any).s);
}

export const spendLimit = (userId: string): number | null => {
  const v = (db.prepare('SELECT spend_limit_usd FROM users WHERE id=?').get(userId) as any)?.spend_limit_usd;
  return typeof v === 'number' ? v : null;
};

export function setSpendLimit(userId: string, limit: number | null) {
  db.prepare('UPDATE users SET spend_limit_usd=? WHERE id=?').run(limit, userId);
}

/** Whether a turn of this bot (or of this routine) may start now under the user's limit. */
export function mayStart(userId: string, botId: string, routineId: string | null): LimitDecision & { spent: number; limit: number | null } {
  const limit = spendLimit(userId);
  const spent = monthSpend(userId);
  if (limit === null) return { run: true, spent, limit };
  const recent = (routineId
    ? db.prepare("SELECT cost_usd FROM spending WHERE kind='turn' AND routine_id=? ORDER BY created_at DESC LIMIT 5").all(routineId)
    : db.prepare("SELECT cost_usd FROM spending WHERE kind='turn' AND bot_id=? ORDER BY created_at DESC LIMIT 5").all(botId)) as { cost_usd: number | null }[];
  return { ...limitDecision({ spent, limit, typical: typicalCost(recent.map((r) => r.cost_usd)) }), spent, limit };
}

export interface SpendingReport {
  month: string;
  total: number;
  /** Entries whose cost is not known. */
  unknown: number;
  limit: number | null;
  byBot: { botId: string; name: string; cost: number; turns: number; unknown: number }[];
  byRoutine: { routineId: string; name: string; botName: string; cost: number; runs: number; unknown: number }[];
  byKind: { kind: SpendKind; cost: number; count: number; unknown: number }[];
}

export function spendingReport(userId: string, monthName?: string): SpendingReport {
  const { name, start, end } = monthOf(Date.now(), monthName);
  const where = 'WHERE s.user_id=? AND s.created_at>=? AND s.created_at<?';
  const args = [userId, start, end];
  const totals = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS total, SUM(cost_usd IS NULL) AS unknown FROM spending s ${where}`).get(...args) as any;
  const byBot = db.prepare(`SELECT s.bot_id AS botId, COALESCE(b.name, '(removed bot)') AS name, COALESCE(SUM(s.cost_usd),0) AS cost, SUM(s.kind='turn') AS turns, SUM(s.cost_usd IS NULL) AS unknown
    FROM spending s LEFT JOIN bots b ON b.id=s.bot_id ${where} GROUP BY s.bot_id ORDER BY cost DESC`).all(...args) as any[];
  const byRoutine = db.prepare(`SELECT s.routine_id AS routineId, COALESCE(r.name, '(removed routine)') AS name, COALESCE(b.name, '') AS botName, COALESCE(SUM(s.cost_usd),0) AS cost, COUNT(*) AS runs, SUM(s.cost_usd IS NULL) AS unknown
    FROM spending s LEFT JOIN routines r ON r.id=s.routine_id LEFT JOIN bots b ON b.id=s.bot_id ${where} AND s.kind='turn' AND s.routine_id IS NOT NULL GROUP BY s.routine_id ORDER BY cost DESC`).all(...args) as any[];
  const byKind = db.prepare(`SELECT s.kind AS kind, COALESCE(SUM(s.cost_usd),0) AS cost, COUNT(*) AS count, SUM(s.cost_usd IS NULL) AS unknown FROM spending s ${where} GROUP BY s.kind ORDER BY cost DESC`).all(...args) as any[];
  const n = (v: unknown) => Number(v ?? 0);
  return {
    month: name,
    total: n(totals.total),
    unknown: n(totals.unknown),
    limit: spendLimit(userId),
    byBot: byBot.map((r) => ({ botId: r.botId, name: r.name, cost: n(r.cost), turns: n(r.turns), unknown: n(r.unknown) })),
    byRoutine: byRoutine.map((r) => ({ routineId: r.routineId, name: r.name, botName: r.botName, cost: n(r.cost), runs: n(r.runs), unknown: n(r.unknown) })),
    byKind: byKind.map((r) => ({ kind: r.kind, cost: n(r.cost), count: n(r.count), unknown: n(r.unknown) })),
  };
}
