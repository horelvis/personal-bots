import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { checkFact, hideSecrets, samePhrase, type UserMessage } from './fact-check.js';
import { factHash } from './user-facts.js';

/**
 * Verified facts about the user (R5): kept by the server, one list per user, each with the user's
 * own words that back it and the message they came from. These are the only facts about the user
 * shared by all of the user's bots; what a bot writes in its own `USER.md` stays with that bot.
 */

export const USER_FACTS_DDL = `
CREATE TABLE IF NOT EXISTS user_facts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  quote TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_message TEXT,
  source_bot_id TEXT,
  saved_by TEXT,
  created_at INTEGER NOT NULL,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS user_facts_user ON user_facts(user_id, hash);`;

export interface VerifiedFact {
  id: string;
  text: string;
  /** Same as lib/user-facts `factHash`, so a fact and a bot's own entry with the same text match. */
  hash: string;
  quote: string;
  /** The user's message the quote came from, as it was when the fact was saved, with any secret in it hidden. */
  sourceText: string;
  createdAt: number;
}

export type SaveResult =
  | { ok: true; fact: VerifiedFact; existed: boolean; replaced: boolean }
  | { ok: false; reason: string };

/** How many of the user's latest messages a quote is looked for in. */
const MESSAGES = 500;

const row = (r: any): VerifiedFact => ({ id: r.id, text: r.text, hash: r.hash, quote: r.quote, sourceText: r.source_text, createdAt: r.created_at });

export function createVerifiedFacts(db: Database.Database) {
  /**
   * The user's own words, newest first: their messages in any of their chats or groups, typed or
   * spoken. An option the user picked on a bot's question card is the bot's text, so it is left out.
   */
  function userMessages(userId: string, limit = MESSAGES, since = 0): (UserMessage & { botId: string })[] {
    const rows = db.prepare(`
      SELECT r.bot_id, r.generation, r.seq, r.body FROM rows r JOIN bots b ON b.id = r.bot_id
      WHERE b.user_id = ? AND r.kind = 'message' AND json_extract(r.body, '$.role') = 'user'
        AND (json_extract(r.body, '$.from.kind') IS NULL OR json_extract(r.body, '$.from.kind') = 'voice')
        AND COALESCE(json_extract(r.body, '$.choice'), 0) = 0 AND r.created_at >= ?
      ORDER BY r.created_at DESC, r.seq DESC LIMIT ?`).all(userId, since, limit) as any[];
    return rows.map((r) => ({ id: `${r.bot_id}:${r.generation}:${r.seq}`, botId: r.bot_id, text: String(JSON.parse(r.body).text ?? '') }));
  }

  /** The facts in use, oldest first. */
  function list(userId: string): VerifiedFact[] {
    return (db.prepare('SELECT * FROM user_facts WHERE user_id=? AND replaced_by IS NULL ORDER BY created_at, rowid').all(userId) as any[]).map(row);
  }

  /** The fact in use whose text reads the same as `text`, if any. */
  function findActive(userId: string, text: string): VerifiedFact | null {
    return list(userId).find((f) => samePhrase(f.text, text)) ?? null;
  }

  /**
   * Keep a fact a bot proposes, if the user's own words back it. `replaces` names a fact it corrects:
   * when no fact in use reads like it, nothing is saved (a correction must not leave two
   * contradicting facts), unless `replacesElsewhere` says the caller deals with the old one itself.
   */
  function save(userId: string, savedBy: string, input: { fact: string; quote: string; replaces?: string; replacesElsewhere?: boolean }): SaveResult {
    const messages = userMessages(userId);
    const check = checkFact(input, messages);
    if (!check.ok) return check;
    const source = messages.find((m) => m.id === check.messageId)!;
    const text = input.fact.trim().slice(0, 1000);
    const hash = factHash(text);
    const old = (input.replaces ?? '').trim();
    return db.transaction((): SaveResult => {
      const target = old ? list(userId).find((f) => samePhrase(f.text, old) && f.hash !== hash) ?? null : null;
      if (old && !target && !input.replacesElsewhere) {
        const kept = list(userId).map((f) => `- ${f.text}`).join('\n') || '(none yet)';
        return { ok: false, reason: `No fact the team keeps matches "${old.slice(0, 200)}", so nothing was saved. Facts the team keeps:\n${kept}\nPass the one this corrects as replaces, copied exactly, or leave replaces out if this is not a correction.` };
      }
      const same = db.prepare('SELECT * FROM user_facts WHERE user_id=? AND hash=? AND replaced_by IS NULL').get(userId, hash) as any;
      let fact: VerifiedFact;
      if (same) fact = row(same);
      else {
        fact = { id: `fact_${crypto.randomBytes(9).toString('base64url')}`, text, hash, quote: check.quote, sourceText: hideSecrets(source.text).slice(0, 1000), createdAt: Date.now() };
        db.prepare('INSERT INTO user_facts(id,user_id,text,hash,quote,source_text,source_message,source_bot_id,saved_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(fact.id, userId, text, hash, fact.quote, fact.sourceText, source.id, source.botId, savedBy, fact.createdAt);
      }
      let replaced = false;
      if (target) {
        db.prepare('UPDATE user_facts SET replaced_by=? WHERE id=?').run(fact.id, target.id);
        replaced = true;
      }
      return { ok: true, fact, existed: !!same, replaced };
    })();
  }

  /** Remove a fact (by the hash of its text) for this user. Returns how many were removed. */
  function remove(userId: string, hash: string): number {
    return db.prepare('DELETE FROM user_facts WHERE user_id=? AND hash=?').run(userId, hash).changes;
  }

  return { userMessages, list, findActive, save, remove };
}
