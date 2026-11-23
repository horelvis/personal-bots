import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './lib/ids.js';
import { db } from './db.js';
import { engineHome } from './engine.js';
import { factHash, factsFor, mergeFacts, withoutFact } from './lib/user-facts.js';
import { createVerifiedFacts, type VerifiedFact } from './lib/verified-facts.js';
import { samePhrase } from './lib/fact-check.js';
import type { Memory } from './types.js';

/**
 * What a bot remembers lives in its Hermes home, not in our database: `memories/MEMORY.md` (the
 * agent's own notes) and `memories/USER.md` (what it knows about the user). Each file is a list of
 * entries separated by a line holding only "§". The app shows them and lets the user remove one.
 *
 * `MEMORY.md` is private to its bot. So is its `USER.md`: what a bot noted about the user on its
 * own is not checked, so it stays with that bot. What the user's own words back is a verified fact
 * (lib/verified-facts.ts, saved through the `remember_about_user` tool): those are kept once per
 * user, reach every bot of that user, and are shown with the message they came from. Removing a
 * fact about the user removes it everywhere: from the verified facts and from every bot's file.
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

/** The verified facts about each user (one list per user, shared by all of that user's bots). */
export const verifiedFacts = createVerifiedFacts(db);

/** Key of a verified fact in a memory id; `u` and `m` are a bot's own files. */
const VERIFIED = 'v';

const ownEntries = (botId: string) => {
  const file = userFile(botId);
  return file ? read(file) : { entries: [], mtime: 0 };
};

/**
 * The user facts to put in a bot's instructions. `others`: the verified facts it does not hold in its
 * own file (a Hermes agent already has its own in its memory). `all`: its own entries, then those.
 */
export function sharedFactsFor(botId: string): { others: string[]; all: string[] } {
  const owner = ownerOf(botId);
  if (!owner) return { others: [], all: [] };
  const facts = mergeFacts([
    { botId, entries: ownEntries(botId).entries },
    { botId: '@verified', entries: verifiedFacts.list(owner).map((f) => f.text) },
  ]);
  return factsFor(facts, botId);
}

/**
 * Remove from a bot's own `USER.md` the entry that reads like `text` (a correction of a fact the bot
 * noted on its own). Returns whether one was removed.
 */
export function forgetOwnUserEntry(botId: string, text: string): boolean {
  const file = userFile(botId);
  if (!file) return false;
  const { entries } = read(file);
  const keep = entries.filter((e) => !samePhrase(e, text));
  if (keep.length === entries.length) return false;
  fs.writeFileSync(file, keep.join(SEP) + (keep.length ? '\n' : ''));
  return true;
}

/** Whether a bot's own `USER.md` holds an entry that reads like `text`. */
export const ownUserEntryLike = (botId: string, text: string) => ownEntries(botId).entries.some((e) => samePhrase(e, text));

const verifiedMeta = (f: VerifiedFact) => ({ verified: { quote: f.quote, message: f.sourceText } });

/**
 * A bot's own notes; its own entries about the user (verified when the team holds the same fact,
 * otherwise kept by this bot only); then the verified facts it knows through the team.
 */
export function listMemories(botId: string): Memory[] {
  const home = engineHome(botId);
  const owner = ownerOf(botId);
  if (!home || !owner) return [];
  const out: Memory[] = [];
  const notes = read(path.join(home, 'memories', NOTES.file));
  for (const text of notes.entries) out.push({ id: idFor(botId, NOTES.key, text), botId, text, createdAt: Math.round(notes.mtime), source: NOTES.source });
  const verified = new Map(verifiedFacts.list(owner).map((f) => [f.hash, f]));
  const own = ownEntries(botId);
  const ownHashes = new Set<string>();
  for (const text of own.entries) {
    const h = factHash(text);
    if (ownHashes.has(h)) continue;
    ownHashes.add(h);
    const v = verified.get(h);
    out.push({ id: idFor(botId, USER.key, text), botId, text, createdAt: Math.round(own.mtime), source: USER.source, ...(v ? verifiedMeta(v) : { onlyThisBot: true }) });
  }
  for (const f of verified.values()) {
    if (ownHashes.has(f.hash)) continue;
    out.push({ id: idFor(botId, VERIFIED, f.text), botId, text: f.text, createdAt: f.createdAt, source: USER.source, shared: true, ...verifiedMeta(f) });
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
  const key = id.split('.')[2];
  const f = key === VERIFIED ? USER : FILES.find((x) => x.key === key);
  if (!f) return false;
  if (f.key === USER.key) {
    const owner = ownerOf(botId);
    if (!owner) return false;
    // A verified fact, and the same text in any of the user's bots' own files.
    let removed = verifiedFacts.remove(owner, id.split('.')[3]) > 0;
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
