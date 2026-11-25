/**
 * List prices per million tokens, for estimating what a model call cost from its token counts (R9).
 * Only for engines that report tokens but not a price (Hermes, the server's own calls); Claude Code
 * reports its own cost. A model not listed here has no estimate unless MODEL_PRICES adds it.
 */
export interface Price {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  /** Default: a tenth of the input price. */
  cacheRead?: number;
  /** Default: 1.25 times the input price (five-minute cache writes). */
  cacheWrite?: number;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Anthropic's first-party list prices, from the Claude API reference cached 2026-11-03. */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Extra or changed prices from MODEL_PRICES: a JSON object of model id to Price. Anything malformed is left out. */
export function parsePrices(raw: string | undefined): Record<string, Price> {
  let data: unknown;
  try { data = JSON.parse(raw ?? ''); } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out: Record<string, Price> = {};
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const [model, p] of Object.entries(data as Record<string, any>)) {
    if (!p || !num(p.input) || !num(p.output)) continue;
    if ((p.cacheRead !== undefined && !num(p.cacheRead)) || (p.cacheWrite !== undefined && !num(p.cacheWrite))) continue;
    out[normalize(model)] = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}), ...(p.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite } : {}) };
  }
  return out;
}

/** `anthropic/claude-haiku-4-5-20251001` and `claude-haiku-4-5@20251001` are `claude-haiku-4-5`. */
function normalize(model: string): string {
  return model.trim().toLowerCase().split('/').pop()!.replace(/[@-]\d{8}$/, '');
}

const fromEnv = parsePrices(process.env.MODEL_PRICES);

/** Estimated cost in US dollars, or null when the model has no known price or no tokens were reported. */
export function estimateCost(model: string | null | undefined, tokens: Tokens | null | undefined, extra: Record<string, Price> = fromEnv): number | null {
  if (!model || !tokens) return null;
  const key = normalize(model);
  const p = extra[key] ?? DEFAULT_PRICES[key];
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  const write = p.cacheWrite ?? p.input * 1.25;
  return (tokens.input * p.input + tokens.output * p.output + (tokens.cacheRead ?? 0) * read + (tokens.cacheWrite ?? 0) * write) / 1_000_000;
}
