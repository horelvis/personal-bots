import type { Trigger } from './loop.js';

/**
 * What to do, when the server starts, with the turns that were stored when it stopped (the
 * `turn_queue` table). Kept free of the database so the rule can be tested alone:
 *
 *  - a turn that was running is interrupted: it is reported in its chat and never run again, because
 *    whatever it was doing (sending an email, say) may already have happened;
 *  - a turn that was still waiting runs, in the order it was queued;
 *  - anything that cannot be read is dropped.
 */

export interface StoredTurn { id: number; bot_id: string; state: string; trigger: string }

export interface RecoveryPlan {
  interrupted: { id: number; botId: string }[];
  resume: { id: number; botId: string; trigger: Trigger }[];
  /** Ids of stored turns that are not understood; they are only removed. */
  dropped: number[];
}

const str = (v: unknown): v is string => typeof v === 'string';

/** A stored trigger, if it still has the shape the loop expects. */
function readTrigger(raw: string): Trigger | null {
  let t: any;
  try { t = JSON.parse(raw); } catch { return null; }
  if (!t || typeof t !== 'object') return null;
  switch (t.type) {
    case 'user':
    case 'system':
      return str(t.text) ? { type: t.type, text: t.text } : null;
    case 'routine':
      return str(t.routineId) && str(t.name) && str(t.prompt) ? { type: 'routine', routineId: t.routineId, name: t.name, prompt: t.prompt } : null;
    case 'bot':
      // Who waits for whom is kept in memory, so a question (askId) comes back as an ordinary message.
      return str(t.fromBotId) && str(t.fromName) && str(t.text) && typeof t.depth === 'number'
        ? { type: 'bot', fromBotId: t.fromBotId, fromName: t.fromName, text: t.text, depth: t.depth }
        : null;
  }
  return null;
}

export function planRecovery(rows: StoredTurn[]): RecoveryPlan {
  const plan: RecoveryPlan = { interrupted: [], resume: [], dropped: [] };
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    if (r.state === 'running') { plan.interrupted.push({ id: r.id, botId: r.bot_id }); continue; }
    const trigger = r.state === 'queued' ? readTrigger(r.trigger) : null;
    if (trigger) plan.resume.push({ id: r.id, botId: r.bot_id, trigger });
    else plan.dropped.push(r.id);
  }
  return plan;
}
