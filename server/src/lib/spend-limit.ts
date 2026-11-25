/** Whether a turn may start under the user's monthly spending limit (R9.3, R9.4). Pure. */

export type LimitDecision = { run: true } | { run: false; why: 'reached' | 'would-pass' };

/**
 * `spent` is this month's known spending, `typical` what a run like this one usually costs (or null).
 * At or over the limit nothing starts; a run whose usual cost would take spending past it does not start either.
 */
export function limitDecision(o: { spent: number; limit: number | null; typical: number | null }): LimitDecision {
  if (o.limit === null) return { run: true };
  if (o.spent >= o.limit) return { run: false, why: 'reached' };
  if (o.typical !== null && o.spent + o.typical > o.limit) return { run: false, why: 'would-pass' };
  return { run: true };
}

/** The median of the last five known costs, newest first; null when none is known. */
export function typicalCost(costsNewestFirst: (number | null)[]): number | null {
  const known = costsNewestFirst.slice(0, 5).filter((c): c is number => typeof c === 'number');
  if (!known.length) return null;
  const s = [...known].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
