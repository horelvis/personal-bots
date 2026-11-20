import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './lib/ids.js';
import { db } from './db.js';
import { engineHome } from './engine.js';
import { factsFor, mergeFacts, withoutFact, type Fact } from './lib/user-facts.js';
import type { Memory } from './types.js';

/**
 * What a bot remembers lives in its Hermes home, not in our database: `memories/MEMORY.md` (the
 * agent's own notes) and `memories/USER.md` (what it knows about the user). Each file is a list of
 * entries separated by a line holding only "§". The app shows them and lets the user remove one.
 *
 * `MEMORY.md` is private to its bot. What the bots know about the user is shared: each bot still
 * writes its own `USER.md`, and the app reads all of a user's bots together (lib/user-facts.ts), so
 * a fact is shown once, reaches every bot, and is removed from every bot at once. No file is copied
 * from one bot to another.
 */

const SEP = '\n§\n';
const FILES = [
  { key: 'm', file: 'MEMORY.md', source: 'learned' as const },
  { key: 'u', file: 'USER.md', source: 'chat' as const },
];

function read(file: string): { entries: string[]; mtime: number } {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { entries: raw.split(SEP).map((e) => e.trim()).filter(Boolean), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return { entries: [], mtime: 0 };
  }
}

// Bot ids never contain a dot, so it separates the parts of a memory id.
const idFor = (botId: string, key: string, text: string) => `mem.${botId}.${key}.${sha256(text).slice(0, 16)}`;

const NOTES = FILES[0];
const USER = FILES[1];

const userFile = (botId: string) => {
  const home = engineHome(botId);
  return home ? path.join(home, 'memories', USER.file) : null;
};

const ownerOf = (botId: string): string | null => (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any)?.user_id ?? null;

/** The user's bots that keep memory, oldest first. Never another user's. */
const botsOf = (userId: string): string[] =>
  (db.prepare("SELECT id FROM bots WHERE user_id=? AND COALESCE(kind,'agent')<>'room' ORDER BY created_at, id").all(userId) as any[]).map((b) => b.id as string);

/** Everything the user's bots know about the user, each fact once, and when its first holder's file last changed. */
function userFacts(userId: string): { facts: Fact[]; mtimes: Map<string, number> } {
  const mtimes = new Map<string, number>();
  const perBot = botsOf(userId).map((botId) => {
    const file = userFile(botId);
    const { entries, mtime } = file ? read(file) : { entries: [], mtime: 0 };
    mtimes.set(botId, mtime);
    return { botId, entries };
  });
  return { facts: mergeFacts(perBot), mtimes };
}

/** The user facts to put in a bot's instructions: those it does not hold itself, and all of them. */
export function sharedFactsFor(botId: string): { others: string[]; all: string[] } {
  const owner = ownerOf(botId);
  return owner ? factsFor(userFacts(owner).facts, botId) : { others: [], all: [] };
}

/** A bot's own notes, then what all of its user's bots know about the user (each fact once). */
export function listMemories(botId: string): Memory[] {
  const home = engineHome(botId);
  const owner = ownerOf(botId);
  if (!home || !owner) return [];
  const out: Memory[] = [];
  const notes = read(path.join(home, 'memories', NOTES.file));
  for (const text of notes.entries) out.push({ id: idFor(botId, NOTES.key, text), botId, text, createdAt: Math.round(notes.mtime), source: NOTES.source });
  const { facts, mtimes } = userFacts(owner);
  // The bot's own facts first, as they were listed before sharing; then what it knows through the team.
  const has = (f: Fact) => f.bots.includes(botId);
  for (const f of [...facts.filter(has), ...facts.filter((f) => !has(f))]) {
    const mine = has(f);
    out.push({ id: idFor(botId, USER.key, f.text), botId, text: f.text, createdAt: Math.round(mtimes.get(mine ? botId : f.bots[0]) ?? 0), source: USER.source, ...(mine ? {} : { shared: true }) });
  }
  return out;
}

/**
 * Add one entry to a bot's memory file ('m' = its own notes, 'u' = what it knows about the user).
 * Used for bots on a CLI engine, whose agent has no memory tool of its own. Returns false when the
 * bot has no home or the entry is empty or already there.
 */
export function addMemory(botId: string, key: 'm' | 'u', text: string): boolean {
  const home = engineHome(botId);
  const f = FILES.find((x) => x.key === key);
  // The separator line is ours: an entry cannot contain one.
  const entry = text.split('\n').filter((l) => l.trim() !== '§').join('\n').trim().slice(0, 2000);
  if (!home || !f || !entry) return false;
  const file = path.join(home, 'memories', f.file);
  const { entries } = read(file);
  if (entries.includes(entry)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...entries, entry].join(SEP) + '\n');
  return true;
}

/** The bot a memory id belongs to, so the caller can check who owns it. */
export function memoryBot(id: string): string | null {
  const parts = id.split('.');
  return parts.length === 4 && parts[0] === 'mem' ? parts[1] : null;
}

/**
 * Remove one entry. A bot's own note leaves that bot's file. A fact about the user is shared, so it
 * leaves the file of every bot of the same user that holds it (never another user's bots).
 */
export function deleteMemory(id: string): boolean {
  const botId = memoryBot(id);
  const home = botId ? engineHome(botId) : null;
  if (!botId || !home) return false;
  const f = FILES.find((x) => x.key === id.split('.')[2]);
  if (!f) return false;
  if (f.key === USER.key) {
    const owner = ownerOf(botId);
    if (!owner) return false;
    let removed = false;
    for (const other of botsOf(owner)) {
      const file = userFile(other);
      if (!file) continue;
      const { entries } = read(file);
      const keep = withoutFact(entries, id.split('.')[3]);
      if (keep === entries) continue;
      fs.writeFileSync(file, keep.join(SEP) + (keep.length ? '\n' : ''));
      removed = true;
    }
    return removed;
  }
  const file = path.join(home, 'memories', f.file);
  const { entries } = read(file);
  const keep = entries.filter((text) => idFor(botId, f.key, text) !== id);
  if (keep.length === entries.length) return false;
  fs.writeFileSync(file, keep.join(SEP) + (keep.length ? '\n' : ''));
  return true;
}
