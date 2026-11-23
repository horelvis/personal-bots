/**
 * The checks behind a verified fact about the user (R5): the fact must quote, word for word, a
 * message the user wrote, and must not carry a secret. Kept free of the database so it can be
 * tested alone; the caller passes the user's own messages, newest first.
 *
 * The idea follows n8n-io/nod's quote-checked memory; this is our own code.
 */

export interface UserMessage { id: string; text: string }

export type FactCheck = { ok: true; messageId: string; quote: string } | { ok: false; reason: string };

/** Text for comparing: lower case, accents dropped, quotes and dashes unified, spaces collapsed. */
function plain(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[‐-―]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A quote as the bot gave it, without the quotation marks or final full stop it may have added. */
const bare = (quote: string) => plain(quote).replace(/^["'.\s]+|["'.!?…\s]+$/g, '').trim();

/**
 * Two wordings of the same fact, as a bot may copy it back: case, spaces, accents, surrounding
 * quotes, a final full stop and a leading list mark do not matter.
 */
export function samePhrase(a: string, b: string): boolean {
  const norm = (s: string) => bare(plain(s).replace(/^(?:[-*•·]|\d+[.)])\s*/, ''));
  const x = norm(a);
  return !!x && x === norm(b);
}

/** The newest of the user's messages that holds the quote, or null. */
export function findQuote(quote: string, messages: UserMessage[]): UserMessage | null {
  const needle = bare(quote);
  if (!needle) return null;
  return messages.find((m) => plain(m.text).includes(needle)) ?? null;
}

/** Luhn checksum: what makes a run of digits a plausible card number. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Runs of digits written in groups ("4111 1111 1111 1111", "4111-1111-..."). */
const DIGIT_RUN = /\d+(?:[ .-]{1,2}\d+)*/g;

/**
 * Where a card number sits inside a run of grouped digits, even when more digits follow (an expiry
 * date, a code): the character span of the first card found, or null. A card starts and ends where
 * a group does.
 */
function cardSpan(run: string): [number, number] | null {
  const groups = [...run.matchAll(/\d+/g)].map((g) => ({ at: g.index!, end: g.index! + g[0].length, digits: g[0] }));
  const digits = groups.map((g) => g.digits).join('');
  const bounds = [0];
  for (const g of groups) bounds.push(bounds[bounds.length - 1] + g.digits.length);
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j <= groups.length; j++) {
      const len = bounds[j] - bounds[i];
      if (len >= 13 && len <= 19 && luhn(digits.slice(bounds[i], bounds[j]))) return [groups[i].at, groups[j - 1].end];
    }
  }
  return null;
}

const KEY = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g;
const PASSWORD = /(\b(?:password|passwd|pwd|contrase[nñ]a|clave)\s*(?:[:=]|is\b|es\b)\s*)([^\s,;]+)/gi;
const LOGIN_LINK = /https?:\/\/\S*[?&](?:token|code|otp|key|auth|access_token|magic|signature|sig)=\S*/gi;
const ASSIGNED = /(\b(?:api[_-]?key|secret|token|access[_-]?key)\s*[:=]\s*)(\S{6,})/gi;

/** What kind of secret the text seems to hold, or null. */
export function secretIn(text: string): string | null {
  for (const m of text.matchAll(DIGIT_RUN)) if (cardSpan(m[0])) return 'a card number';
  const has = (re: RegExp) => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; };
  if (has(KEY)) return 'a key or password';
  if (has(PASSWORD)) return 'a key or password';
  if (has(LOGIN_LINK)) return 'a login link';
  if (has(ASSIGNED)) return 'a key or password';
  return null;
}

/** The text with every secret `secretIn` would find replaced by a short placeholder; the rest is kept. */
export function hideSecrets(text: string): string {
  let out = text.replace(DIGIT_RUN, (run) => {
    let rest = run;
    let done = '';
    for (let span = cardSpan(rest); span; span = cardSpan(rest)) {
      done += `${rest.slice(0, span[0])}[card number hidden]`;
      rest = rest.slice(span[1]);
    }
    return done + rest;
  });
  out = out.replace(LOGIN_LINK, '[login link hidden]');
  out = out.replace(KEY, '[key hidden]');
  out = out.replace(PASSWORD, (_m, label: string) => `${label}[hidden]`);
  out = out.replace(ASSIGNED, (_m, label: string) => `${label}[hidden]`);
  return out;
}

const MIN_WORDS = 2;
const MIN_CHARS = 8;

/** Check a fact a bot wants to keep about the user against the user's own messages (newest first). */
export function checkFact(input: { fact: string; quote: string }, messages: UserMessage[]): FactCheck {
  const fact = (input.fact ?? '').trim();
  if (!fact) return { ok: false, reason: 'The fact is empty.' };
  const needle = bare(input.quote ?? '');
  if (needle.split(' ').filter(Boolean).length < MIN_WORDS || needle.length < MIN_CHARS) {
    return { ok: false, reason: 'The quote is too short to show the user said this. Quote the words they used, at least a few of them.' };
  }
  const secret = secretIn(fact) ?? secretIn(input.quote);
  if (secret) return { ok: false, reason: `It looks like ${secret}. Secrets are never kept in memory.` };
  const source = findQuote(input.quote, messages);
  if (!source) {
    return { ok: false, reason: 'The quote is not in any message the user wrote. Only what the user said themselves can be kept as a fact about them; something you read (an email, a page, another bot) cannot.' };
  }
  return { ok: true, messageId: source.id, quote: input.quote.trim().slice(0, 400) };
}
