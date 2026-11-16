import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TURN_QUEUE_DDL, beginWithRetry, createTurnStore, shareWait } from './turn-store.js';

function setup() {
  const db = new Database(':memory:');
  // The queue refers to its bot.
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY); INSERT INTO bots VALUES ('a');");
  db.exec(TURN_QUEUE_DDL);
  return { db, store: createTurnStore(db), rows: () => db.prepare('SELECT id, bot_id, state FROM turn_queue ORDER BY id').all() };
}

const msg = (text: string) => ({ type: 'user' as const, text });

test('a turn is stored as queued, marked running when it starts, and removed when it ends', () => {
  const { store, rows } = setup();
  const id = store.add('a', msg('hi'))!;
  assert.deepEqual(rows(), [{ id, bot_id: 'a', state: 'queued' }]);
  assert.equal(store.begin(id), 'run');
  assert.deepEqual(rows(), [{ id, bot_id: 'a', state: 'running' }]);
  store.end(id);
  assert.deepEqual(rows(), []);
});

test('a turn that could not be stored still runs', () => {
  const { store } = setup();
  assert.equal(store.begin(null), 'run');
  store.end(null);
});

// If the "running" mark cannot be written, a stop would leave the turn "queued" and it would run again.
test('when the running mark cannot be written, the turn is forgotten and then runs', () => {
  const { db, store, rows } = setup();
  const id = store.add('a', msg('send the email'))!;
  db.exec("CREATE TRIGGER no_mark BEFORE UPDATE ON turn_queue BEGIN SELECT RAISE(ABORT, 'database is busy'); END;");
  assert.equal(store.begin(id), 'run');
  assert.deepEqual(rows(), []);
});

test('when the turn can be neither marked nor forgotten, it is not run', () => {
  const { db, store } = setup();
  const id = store.add('a', msg('send the email'))!;
  db.exec('DROP TABLE turn_queue');
  assert.equal(store.begin(id), 'skip');
});

test('ending a turn whose row cannot be removed does not throw', () => {
  const { db, store } = setup();
  const id = store.add('a', msg('x'))!;
  store.begin(id);
  db.exec('DROP TABLE turn_queue');
  assert.doesNotThrow(() => store.end(id));
});

test('recovery reads every stored turn and drops the ones it cannot use', () => {
  const { db, store, rows } = setup();
  const run1 = store.add('a', msg('one'))!;
  store.begin(run1);
  const q2 = store.add('a', msg('two'))!;
  db.prepare("INSERT INTO turn_queue(bot_id, trigger, state, created_at) VALUES ('a', '{bad', 'queued', 0)").run();
  const plan = store.takeRecovery();
  assert.deepEqual(plan.interrupted, [{ id: run1, botId: 'a' }]);
  assert.deepEqual(plan.resume.map((r) => r.id), [q2]);
  assert.equal(plan.dropped.length, 1);
  // The dropped row is gone; the others stay until they are dealt with.
  assert.deepEqual(rows().map((r: any) => r.id), [run1, q2]);
});

// Closing the chat and forgetting the turn happen together, or not at all.
test('an interrupted turn is forgotten only when its chat was closed', () => {
  const { db, store, rows } = setup();
  db.exec('CREATE TABLE chat (text TEXT)');
  const id = store.add('a', msg('one'))!;
  store.begin(id);
  const failed = store.closeInterrupted(id, () => {
    db.prepare("INSERT INTO chat VALUES ('half done')").run();
    throw new Error('could not write the notice');
  });
  assert.equal(failed, false);
  // Kept for the next start, and the half-written chat change rolled back.
  assert.deepEqual(rows(), [{ id, bot_id: 'a', state: 'running' }]);
  assert.deepEqual(db.prepare('SELECT * FROM chat').all(), []);
  const ok = store.closeInterrupted(id, () => { db.prepare("INSERT INTO chat VALUES ('Interrupted')").run(); });
  assert.equal(ok, true);
  assert.deepEqual(rows(), []);
  assert.deepEqual(db.prepare('SELECT * FROM chat').all(), [{ text: 'Interrupted' }]);
});

test('forget removes one turn', () => {
  const { store, rows } = setup();
  const a = store.add('a', msg('x'))!;
  const b = store.add('a', msg('y'))!;
  store.forget(a);
  assert.deepEqual(rows().map((r: any) => r.id), [b]);
});

// A database that fails for a moment should not cost the user a turn, nor make them send it twice.
test('a turn that cannot be started is tried again in its place, and starts once the database answers', async () => {
  const { db, store, rows } = setup();
  const id = store.add('a', msg('send the email'))!;
  db.exec("CREATE TRIGGER no_mark BEFORE UPDATE ON turn_queue BEGIN SELECT RAISE(ABORT, 'database is busy'); END;");
  db.exec("CREATE TRIGGER no_forget BEFORE DELETE ON turn_queue BEGIN SELECT RAISE(ABORT, 'database is busy'); END;");
  const waits: number[] = [];
  const started = beginWithRetry(store, id, [10, 20, 30], async (ms) => {
    waits.push(ms);
    if (waits.length === 2) db.exec('DROP TRIGGER no_mark; DROP TRIGGER no_forget;');
  });
  assert.equal(await started, 'run');
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(rows(), [{ id, bot_id: 'a', state: 'running' }]);
});

test('a turn that still cannot be started is left queued for the next start', async () => {
  const { db, store, rows } = setup();
  const id = store.add('a', msg('send the email'))!;
  db.exec("CREATE TRIGGER no_mark BEFORE UPDATE ON turn_queue BEGIN SELECT RAISE(ABORT, 'database is busy'); END;");
  db.exec("CREATE TRIGGER no_forget BEFORE DELETE ON turn_queue BEGIN SELECT RAISE(ABORT, 'database is busy'); END;");
  const waits: number[] = [];
  assert.equal(await beginWithRetry(store, id, [1, 2], async (ms) => { waits.push(ms); }), 'later');
  assert.deepEqual(waits, [1, 2]);
  // Still queued: the next start runs it, once.
  assert.deepEqual(rows(), [{ id, bot_id: 'a', state: 'queued' }]);
  db.exec('DROP TRIGGER no_mark; DROP TRIGGER no_forget;');
  assert.deepEqual(store.takeRecovery().resume.map((r) => r.id), [id]);
});

test('a turn that starts at once does not wait', async () => {
  const { store } = setup();
  const id = store.add('a', msg('x'))!;
  let waited = false;
  assert.equal(await beginWithRetry(store, id, [1000], async () => { waited = true; }), 'run');
  assert.equal(waited, false);
});

// After a restart all of a bot's turns wait for the same engine: one wait, not one per turn.
test('the engine wait after a restart is shared by every turn of the same bot', async () => {
  const calls: string[] = [];
  let release!: (v: boolean) => void;
  const wait = shareWait((botId) => { calls.push(botId); return new Promise<boolean>((r) => { release = r; }); });
  const a1 = wait('a');
  const a2 = wait('a');
  const b1 = wait('b');
  assert.deepEqual(calls, ['a', 'b']);
  release(true);
  assert.equal(await b1, true);
  // Every later turn of 'a' gets the same answer without waiting again.
  assert.equal(a1, a2);
  assert.equal(wait('a'), a1);
  assert.deepEqual(calls, ['a', 'b']);
});
