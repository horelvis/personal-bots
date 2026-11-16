import { sha256 } from './ids.js';

/**
 * Facts about the user, shared by all of that user's bots.
 *
 * Every bot keeps writing its own `USER.md`. Nothing is copied between bots: the shared view is the
 * union of those files, read when it is needed. These are the rules of that union, kept free of the
 * file system and the database so they can be tested alone.
 */

export interface Fact {
  text: string;
  /** The bots whose own file holds this fact. */
  bots: string[];
}

/** How much of what other bots know is added to a bot's instructions. */
export const FACTS_LIMIT = 40;
export const FACTS_CHARS = 4000;

/** Identifies a fact across bots: the same text, whatever space surrounds it. */
export const factHash = (text: string) => sha256(text.trim()).slice(0, 16);

/** One list out of every bot's entries: the same text is one fact. Order: by bot, then as written. */
export function mergeFacts(perBot: { botId: string; entries: string[] }[]): Fact[] {
  const byHash = new Map<string, Fact>();
  for (const { botId, entries } of perBot) {
    for (const raw of entries) {
      const text = raw.trim();
      if (!text) continue;
      const h = factHash(text);
      const known = byHash.get(h);
      if (!known) byHash.set(h, { text, bots: [botId] });
      else if (!known.bots.includes(botId)) known.bots.push(botId);
    }
  }
  return [...byHash.values()];
}

/** The latest facts that fit the limits. */
function capped(texts: string[]): string[] {
  const out: string[] = [];
  let chars = 0;
  for (let i = texts.length - 1; i >= 0 && out.length < FACTS_LIMIT; i--) {
    if (chars + texts[i].length > FACTS_CHARS) break;
    chars += texts[i].length;
    out.unshift(texts[i]);
  }
  return out;
}

/**
 * What one bot is told. `others` are the facts it does not hold itself (a Hermes agent already has
 * its own in its memory); `all` is every fact (for a bot whose memory the app sends in full).
 */
export function factsFor(facts: Fact[], botId: string): { others: string[]; all: string[] } {
  return {
    others: capped(facts.filter((f) => !f.bots.includes(botId)).map((f) => f.text)),
    all: capped(facts.map((f) => f.text)),
  };
}

/**
 * A bot's entries without the fact `hash` names. Returns the same array when nothing matches, so the
 * caller can tell there is nothing to write.
 */
export function withoutFact(entries: string[], hash: string): string[] {
  if (!/^[0-9a-f]{16}$/.test(hash)) return entries;
  const keep = entries.filter((e) => factHash(e) !== hash);
  return keep.length === entries.length ? entries : keep;
}
