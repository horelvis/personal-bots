/**
 * One bot waiting for another bot's answer (the ask_bot tool).
 *
 * The asked bot answers in a turn of its own, queued like any other; this keeps track of who is
 * waiting for whom until that turn ends. It holds no database state: after a restart nobody is
 * waiting any more.
 *
 *  - `open` registers a question, unless it would close a circle of bots waiting on each other
 *    (A waits for B, B asks A: A cannot answer while it waits, so both would sit until the limit).
 *  - `wait` resolves with the answer, or with `timeout` once the limit passes or the asker stops.
 *  - `settle` is called when the asked bot's turn ends. It says whether the asker got the answer
 *    (`delivered`) or had already stopped waiting (`late`: the caller sends it as a message).
 */

export type Answer = { status: 'answered'; text: string } | { status: 'no_answer' } | { status: 'timeout' };

interface Ask {
  asker: string;
  target: string;
  /** Still holding the asker's tool call. False once it timed out or the asker stopped. */
  waiting: boolean;
  resolve?: (a: Answer) => void;
  timer?: NodeJS.Timeout;
}

export interface Asks {
  /** Register a question. Null when the bot asks itself or the question would close a circle. */
  open(asker: string, target: string): string | null;
  wait(id: string): Promise<Answer>;
  settle(id: string, text: string | null): 'delivered' | 'late' | 'unknown';
  /** The asker's turn is over: it waits for nobody any more. Answers still to come will be late. */
  release(asker: string): void;
  /**
   * Open a question, hand it to `send` (which puts it in the other bot's queue) and wait. `circle`
   * means it was not sent. If `send` throws, the question is dropped before the error is passed on,
   * so nobody is recorded as waiting for something that was never asked.
   */
  ask(asker: string, target: string, send: (id: string) => void): Promise<Answer | { status: 'circle' }>;
}

/**
 * What is left to do when the asked bot's turn ends, given what `settle` said. An asker that stopped
 * waiting was told the answer would come later: it gets the reply as a message, or is told that
 * none will come.
 */
export function afterAnswer(settled: 'delivered' | 'late' | 'unknown', reply: string): 'nothing' | 'send_reply' | 'say_no_answer' {
  if (settled !== 'late') return 'nothing';
  return reply.trim() ? 'send_reply' : 'say_no_answer';
}

/**
 * Seconds ask_bot waits: 9 minutes unless set, and never more than 25 minutes, so the wait ends
 * before the 30-minute limit the engines put on a tool call.
 */
export function askBotWaitSeconds(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw?.trim() || !Number.isFinite(n) || n <= 0) return 9 * 60;
  return Math.min(Math.max(1, Math.round(n)), 25 * 60);
}

export function createAsks(waitMs: number): Asks {
  const asks = new Map<string, Ask>();
  let next = 0;

  /** Is `from` waiting, directly or through others, for `to`? */
  const waitsFor = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const a of asks.values()) if (a.waiting && a.asker === from && waitsFor(a.target, to, seen)) return true;
    return false;
  };

  const giveUp = (a: Ask) => {
    if (!a.waiting) return;
    a.waiting = false;
    clearTimeout(a.timer);
    a.resolve?.({ status: 'timeout' });
  };

  const self: Asks = {
    open(asker, target) {
      // If the target already waits for the asker, the asker waiting for the target closes the circle.
      if (waitsFor(target, asker)) return null;
      const id = `ask_${++next}`;
      asks.set(id, { asker, target, waiting: true });
      return id;
    },

    wait(id) {
      const a = asks.get(id);
      if (!a || !a.waiting) return Promise.resolve({ status: 'timeout' });
      return new Promise<Answer>((resolve) => {
        a.resolve = resolve;
        a.timer = setTimeout(() => giveUp(a), waitMs);
      });
    },

    settle(id, text) {
      const a = asks.get(id);
      if (!a) return 'unknown';
      asks.delete(id);
      if (!a.waiting) return 'late';
      a.waiting = false;
      clearTimeout(a.timer);
      const said = (text ?? '').trim();
      a.resolve?.(said ? { status: 'answered', text: said } : { status: 'no_answer' });
      return 'delivered';
    },

    release(asker) {
      for (const a of asks.values()) if (a.asker === asker) giveUp(a);
    },

    async ask(asker, target, send) {
      const id = self.open(asker, target);
      if (!id) return { status: 'circle' };
      const waiting = self.wait(id);
      try {
        send(id);
      } catch (e) {
        self.settle(id, null);
        throw e;
      }
      return waiting;
    },
  };
  return self;
}
