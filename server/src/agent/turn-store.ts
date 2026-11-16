import type Database from 'better-sqlite3';
import { planRecovery, type RecoveryPlan, type StoredTurn } from './queue-recovery.js';
import type { Trigger } from './loop.js';

/**
 * The turns handed to bots, kept in the database from the moment they are queued until they end,
 * so a stop of the server neither loses a waiting turn nor runs a started one again.
 *
 * Row states: 'queued' while the turn waits, 'running' once its run has started. Every write here is
 * guarded: a failing write must never make a started turn look as if it had not started.
 */

export const TURN_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS turn_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);`;

export interface TurnStore {
  /** Store a queued turn. Null when it could not be stored: it still runs, it just would not survive a stop. */
  add(botId: string, trigger: Trigger): number | null;
  /**
   * The turn's place in the queue has come. 'run' once it is marked as started (or is not stored at
   * all); 'skip' when that cannot be recorded and the row cannot be removed either, because running
   * it then could make it run a second time after a stop.
   */
  begin(id: number | null): 'run' | 'skip';
  /** The turn ended, however it ended. */
  end(id: number | null): void;
  forget(id: number): void;
  /** What the last stop left behind, already rid of the rows that cannot be used. */
  takeRecovery(): RecoveryPlan;
  /**
   * Close a cut-off turn's chat with `close` and forget the turn, both or neither. False when it
   * failed: the turn is kept and the next start tries again.
   */
  closeInterrupted(id: number, close: () => void): boolean;
}

const why = (e: any) => String(e?.message ?? e);

export function createTurnStore(db: Database.Database): TurnStore {
  const forget = (id: number) => db.prepare('DELETE FROM turn_queue WHERE id=?').run(id);

  return {
    add(botId, trigger) {
      try {
        return Number(db.prepare("INSERT INTO turn_queue(bot_id, trigger, state, created_at) VALUES (?,?, 'queued', ?)").run(botId, JSON.stringify(trigger), Date.now()).lastInsertRowid);
      } catch (e) {
        console.warn(`[agent] ${botId}: a queued turn could not be stored: ${why(e)}`);
        return null;
      }
    },

    begin(id) {
      if (id === null) return 'run';
      try {
        db.prepare("UPDATE turn_queue SET state='running' WHERE id=?").run(id);
        return 'run';
      } catch (e) {
        // Without the mark, a stop would leave the turn 'queued' and run it again. Forgotten, it can
        // only be lost by a stop, never repeated.
        try {
          forget(id);
          console.warn(`[agent] turn ${id}: could not mark it as started (${why(e)}); it runs without surviving a stop`);
          return 'run';
        } catch (e2) {
          console.error(`[agent] turn ${id}: could not mark it as started nor forget it (${why(e2)}); not run`);
          return 'skip';
        }
      }
    },

    end(id) {
      if (id === null) return;
      try { forget(id); } catch (e) {
        console.warn(`[agent] turn ${id}: could not remove it after it ended (${why(e)}); the next start will report it as interrupted`);
      }
    },

    forget(id) { forget(id); },

    takeRecovery() {
      const plan = planRecovery(db.prepare('SELECT id, bot_id, state, trigger FROM turn_queue ORDER BY id').all() as StoredTurn[]);
      for (const id of plan.dropped) forget(id);
      return plan;
    },

    closeInterrupted(id, close) {
      try {
        db.transaction(() => { close(); forget(id); })();
        return true;
      } catch (e) {
        console.warn(`[agent] turn ${id}: could not close its chat after the restart (${why(e)}); the next start tries again`);
        return false;
      }
    },
  };
}
