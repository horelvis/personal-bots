import type { ServerEvent } from '../types.js';

type Listener = (ev: ServerEvent) => void;

/** Per-user fan-out of server events to connected SSE clients. */
class Hub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  private taps = new Set<(userId: string, ev: ServerEvent) => void>();

  /** Every event of every user, for the server's own channels (Telegram). Not counted as a user being online. */
  tap(fn: (userId: string, ev: ServerEvent) => void): () => void {
    this.taps.add(fn);
    return () => { this.taps.delete(fn); };
  }

  emit(userId: string, ev: ServerEvent) {
    for (const fn of this.taps) {
      try { fn(userId, ev); } catch { /* a broken tap must not stop the others */ }
    }
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const fn of set) {
      try { fn(ev); } catch { /* ignore broken listener */ }
    }
  }

  isOnline(userId: string) {
    return (this.listeners.get(userId)?.size ?? 0) > 0;
  }
}

export const hub = new Hub();
