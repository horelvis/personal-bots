import OpenAI from 'openai';
import { db } from './db.js';
import { env } from './env.js';
import { verifiedFacts } from './engine-memory.js';
import { turnRoutine } from './agent/loop.js';
import { trustCheck, type TrustAction, type TrustDecision } from './lib/trust-check.js';

/**
 * The action check (R6) wired to the app: the model call, the user's rules, and what the check sees
 * of the user's words (their messages of the last day in any of their chats, and for a routine's
 * turn its instruction). The rules of the check itself are in lib/trust-check.ts.
 */

const client = new OpenAI({ apiKey: env.xaiKey, baseURL: env.trustModelUrl, timeout: 20_000, maxRetries: 0 });

async function askModel(prompt: { system: string; user: string }): Promise<string> {
  const r = await client.chat.completions.create({
    model: env.trustModel,
    temperature: 0,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
  });
  return r.choices[0]?.message?.content ?? '';
}

const DAY = 24 * 60 * 60_000;
const RECENT = 10;

export const userRules = (userId: string): string => String((db.prepare('SELECT trust_rules FROM users WHERE id=?').get(userId) as any)?.trust_rules ?? '');

export function setUserRules(userId: string, text: string) {
  db.prepare('UPDATE users SET trust_rules=? WHERE id=?').run(text.trim().slice(0, 4000), userId);
}

/** Decide whether `action` runs for this bot now, from the user's own words. */
export async function checkAction(userId: string, botId: string, action: TrustAction): Promise<TrustDecision> {
  const messages = verifiedFacts.userMessages(userId, RECENT, Date.now() - DAY).map((m) => m.text);
  const routine = turnRoutine(botId);
  const decision = await trustCheck(action, { messages, rules: userRules(userId), ...(routine ? { routine } : {}) }, askModel, 15_000);
  if (!decision.run) console.log(`[trust] ${botId} ${action.tool}: ask (${decision.reason})`);
  return decision;
}

/** A routine's turn runs with nobody watching: an action the check does not clear is reported, not asked. */
export const unattended = (botId: string) => !!turnRoutine(botId);
