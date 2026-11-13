/**
 * What a voice call costs, as far as the app can tell. The voice provider bills by the minute of
 * session, plus a small amount for each text note sent into the call; it does not report a figure
 * to the app, so this is an estimate from the published rates. The rates can be set in the
 * environment, since published prices change.
 */

export interface VoiceRates { perMinute: number; perTextItem: number }

const PUBLISHED: VoiceRates = { perMinute: 0.08, perTextItem: 0.004 };

const rate = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function voiceRates(vars: Record<string, string | undefined>): VoiceRates {
  return { perMinute: rate(vars.XAI_VOICE_USD_PER_MIN, PUBLISHED.perMinute), perTextItem: rate(vars.XAI_VOICE_USD_PER_TEXT_ITEM, PUBLISHED.perTextItem) };
}

/** Dollars for a call of this length with this many text notes, to a tenth of a cent. */
export function voiceCost(durationMs: number, textItems: number, rates: VoiceRates): number {
  const minutes = Math.max(0, durationMs) / 60_000;
  const items = Math.max(0, Math.floor(textItems));
  return Math.round((minutes * rates.perMinute + items * rates.perTextItem) * 1000) / 1000;
}

/** "~$0.12": the tilde says it is an estimate. Something spent never reads as nothing. */
export function formatCost(usd: number): string {
  if (!(usd > 0)) return '$0.00';
  if (usd < 0.005) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}
