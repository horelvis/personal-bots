/**
 * The language a bot speaks and listens in. It is always one the person picked from this list:
 * there is no automatic detection. A bot whose language was never chosen (older rows hold "auto")
 * starts on the listed language closest to what the person's browser asks for, and that becomes
 * its setting.
 */

export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' }, { code: 'ar-EG', name: 'Arabic (Egypt)' },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' }, { code: 'ar-AE', name: 'Arabic (UAE)' }, { code: 'bn', name: 'Bengali' },
  { code: 'zh', name: 'Chinese' }, { code: 'fr', name: 'French' }, { code: 'de', name: 'German' }, { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' }, { code: 'it', name: 'Italian' }, { code: 'ja', name: 'Japanese' }, { code: 'ko', name: 'Korean' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' }, { code: 'pt-PT', name: 'Portuguese (Portugal)' }, { code: 'ru', name: 'Russian' },
  { code: 'es-MX', name: 'Spanish (Mexico)' }, { code: 'es-ES', name: 'Spanish (Spain)' }, { code: 'tr', name: 'Turkish' }, { code: 'vi', name: 'Vietnamese' },
];

export const DEFAULT_LANGUAGE = 'en';

const listed = (code: unknown) => LANGUAGES.find((l) => l.code.toLowerCase() === String(code ?? '').toLowerCase());
const base = (code: string) => code.toLowerCase().split('-')[0];

export const languageName = (code: unknown): string | undefined => listed(code)?.name;

/** The stored choice when it is a listed language; otherwise the listed language closest to `preferred` (most wanted first). */
export function resolveLanguage(stored: unknown, preferred: readonly string[]): string {
  const chosen = listed(stored);
  if (chosen) return chosen.code;
  for (const want of preferred) {
    const exact = listed(want);
    if (exact) return exact.code;
    const sameLanguage = LANGUAGES.find((l) => base(l.code) === base(String(want)));
    if (sameLanguage) return sameLanguage.code;
  }
  return DEFAULT_LANGUAGE;
}

/** The languages of an Accept-Language header, most wanted first. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  return (header ?? '').split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((x) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(x.tag) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

/** Dictation takes the language without its region ("es-ES" is "es"). */
export const sttLanguage = (code: string): string => base(code);
