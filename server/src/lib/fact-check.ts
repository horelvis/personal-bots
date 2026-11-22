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

/** What kind of secret the text seems to hold, or null. */
export function secretIn(text: string): string | null {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return 'a card number';
  }
  if (/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) return 'a key or password';
  if (/\b(?:password|passwd|contrase[nñ]a)\s*[:=]\s*\S+/i.test(text)) return 'a key or password';
  if (/https?:\/\/\S*[?&](?:token|code|otp|key|auth|access_token|magic|signature|sig)=/i.test(text)) return 'a login link';
  return null;
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
