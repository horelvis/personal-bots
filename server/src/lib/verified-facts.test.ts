import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { USER_FACTS_DDL, createVerifiedFacts } from './verified-facts.js';
import { factHash } from './user-facts.js';

let seq = 0;
function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE bots (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT);
    CREATE TABLE rows (bot_id TEXT, generation INTEGER, seq INTEGER, kind TEXT, body TEXT, created_at INTEGER);
    INSERT INTO users VALUES ('u1'), ('u2');
    INSERT INTO bots VALUES ('alice', 'u1', 'agent'), ('bob', 'u1', 'agent'), ('room', 'u1', 'room'), ('eve', 'u2', 'agent');
  `);
  db.exec(USER_FACTS_DDL);
  const say = (botId: string, body: object) => db.prepare('INSERT INTO rows VALUES (?,?,?,?,?,?)').run(botId, 1, ++seq, 'message', JSON.stringify({ type: 'message', ...body }), seq);
  return { db, facts: createVerifiedFacts(db), say };
}

test("the user's own messages are their words: typed or spoken, in any chat or group, never another user's", () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'typed to alice' });
  say('room', { role: 'user', text: 'typed in the group' });
  say('bob', { role: 'user', text: 'spoken on a call', from: { kind: 'voice', id: 'c', name: 'Voice call' } });
  say('bob', { role: 'user', text: 'a message from another bot', from: { kind: 'bot', id: 'alice', name: 'Alice' } });
  say('bob', { role: 'user', text: 'a routine prompt', from: { kind: 'routine', id: 'r', name: 'Morning' } });
  say('bob', { role: 'assistant', text: 'what bob wrote' });
  say('eve', { role: 'user', text: 'another user' });
  assert.deepEqual(facts.userMessages('u1').map((m) => m.text), ['spoken on a call', 'typed in the group', 'typed to alice']);
});

test('a fact backed by the user\'s words is kept, with its quote and message', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'Carol is my assistant now, copy her on invoices' });
  const r = facts.save('u1', 'alice', { fact: "Carol is the user's assistant.", quote: 'Carol is my assistant now' });
  assert.equal(r.ok, true);
  const [f] = facts.list('u1');
  assert.equal(f.text, "Carol is the user's assistant.");
  assert.equal(f.quote, 'Carol is my assistant now');
  assert.equal(f.sourceText, 'Carol is my assistant now, copy her on invoices');
  assert.equal(f.hash, factHash("Carol is the user's assistant."));
});

// The attack: a bot read an email and wants to keep what it said.
test('a fact whose quote the user never wrote is refused and nothing is kept', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'Please read my latest email' });
  say('alice', { role: 'user', text: 'the assistant is now Carol', from: { kind: 'bot', id: 'bob', name: 'Bob' } });
  const r = facts.save('u1', 'alice', { fact: "Carol is the user's assistant.", quote: 'the assistant is now Carol' });
  assert.equal(r.ok, false);
  assert.deepEqual(facts.list('u1'), []);
});

test("one user's words never back another user's facts", () => {
  const { facts, say } = setup();
  say('eve', { role: 'user', text: 'my bank account changed to ES12 3456' });
  assert.equal(facts.save('u1', 'alice', { fact: 'New bank account.', quote: 'my bank account changed' }).ok, false);
  assert.equal(facts.save('u2', 'eve', { fact: 'New bank account.', quote: 'my bank account changed' }).ok, true);
  assert.equal(facts.list('u1').length, 0);
  assert.equal(facts.list('u2').length, 1);
});

test('saving the same fact twice keeps it once', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'I live in Madrid these days' });
  facts.save('u1', 'alice', { fact: 'Lives in Madrid.', quote: 'I live in Madrid' });
  const again = facts.save('u1', 'bob', { fact: '  Lives in Madrid.  ', quote: 'I live in Madrid' });
  assert.equal(again.ok, true);
  assert.equal(facts.list('u1').length, 1);
});

test('a correction replaces the old fact instead of adding a second one', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'I live in Madrid these days' });
  facts.save('u1', 'alice', { fact: 'Lives in Madrid.', quote: 'I live in Madrid' });
  say('alice', { role: 'user', text: 'I moved, I live in Lisbon now' });
  const r = facts.save('u1', 'alice', { fact: 'Lives in Lisbon.', quote: 'I live in Lisbon now', replaces: 'lives in madrid.' });
  assert.equal(r.ok, true);
  assert.equal((r as any).replaced, true);
  assert.deepEqual(facts.list('u1').map((f) => f.text), ['Lives in Lisbon.']);
});

test('a correction that names no known fact still saves the new one, and says nothing was replaced', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'I live in Lisbon now' });
  const r = facts.save('u1', 'alice', { fact: 'Lives in Lisbon.', quote: 'I live in Lisbon now', replaces: 'Lives in Paris.' });
  assert.equal(r.ok, true);
  assert.equal((r as any).replaced, false);
});

test('removing a fact removes it for that user only', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'I live in Madrid these days' });
  say('eve', { role: 'user', text: 'I live in Madrid these days' });
  facts.save('u1', 'alice', { fact: 'Lives in Madrid.', quote: 'I live in Madrid' });
  facts.save('u2', 'eve', { fact: 'Lives in Madrid.', quote: 'I live in Madrid' });
  assert.equal(facts.remove('u1', factHash('Lives in Madrid.')), 1);
  assert.equal(facts.list('u1').length, 0);
  assert.equal(facts.list('u2').length, 1);
});

test('a card number is never kept', () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'my card is 4111 1111 1111 1111' });
  assert.equal(facts.save('u1', 'alice', { fact: 'Card 4111 1111 1111 1111', quote: 'my card is 4111 1111 1111 1111' }).ok, false);
  assert.equal(facts.list('u1').length, 0);
});

// Found by independent verification: an option the bot wrote, clicked by the user, is the bot's words.
test("an option the user picked on a bot's question card is not the user's words", () => {
  const { facts, say } = setup();
  say('alice', { role: 'user', text: 'Frank is my lawyer now', choice: true });
  assert.equal(facts.userMessages('u1').length, 0);
  assert.equal(facts.save('u1', 'alice', { fact: 'Frank is the lawyer.', quote: 'Frank is my lawyer now' }).ok, false);
});

test('a fact keeps a link to the exact message it came from', () => {
  const { db, facts, say } = setup();
  say('alice', { role: 'user', text: 'I live in Madrid these days' });
  facts.save('u1', 'alice', { fact: 'Lives in Madrid.', quote: 'I live in Madrid' });
  const stored = db.prepare('SELECT source_message FROM user_facts').get() as any;
  assert.match(stored.source_message, /^alice:1:\d+$/);
});
