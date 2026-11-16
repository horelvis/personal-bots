import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factHash, factsFor, mergeFacts, withoutFact } from './user-facts.js';

const bots = [
  { botId: 'a', entries: ['Lives in Madrid.', 'Prefers short answers.'] },
  { botId: 'b', entries: ['Prefers short answers.', 'Has two dogs.'] },
  { botId: 'c', entries: [] },
];

test('the same fact in two bots is one fact, and it remembers who has it', () => {
  assert.deepEqual(mergeFacts(bots), [
    { text: 'Lives in Madrid.', bots: ['a'] },
    { text: 'Prefers short answers.', bots: ['a', 'b'] },
    { text: 'Has two dogs.', bots: ['b'] },
  ]);
});

test('facts that differ only in surrounding space are the same fact', () => {
  const merged = mergeFacts([{ botId: 'a', entries: ['  Likes tea.  '] }, { botId: 'b', entries: ['Likes tea.'] }]);
  assert.deepEqual(merged, [{ text: 'Likes tea.', bots: ['a', 'b'] }]);
  assert.equal(factHash('  Likes tea.  '), factHash('Likes tea.'));
});

test('a bot is told the facts it does not have itself', () => {
  assert.deepEqual(factsFor(mergeFacts(bots), 'a').others, ['Has two dogs.']);
  assert.deepEqual(factsFor(mergeFacts(bots), 'b').others, ['Lives in Madrid.']);
  assert.deepEqual(factsFor(mergeFacts(bots), 'c').others, ['Lives in Madrid.', 'Prefers short answers.', 'Has two dogs.']);
  assert.deepEqual(factsFor(mergeFacts(bots), 'a').all, ['Lives in Madrid.', 'Prefers short answers.', 'Has two dogs.']);
});

test('a bot with every fact is told nothing more', () => {
  assert.deepEqual(factsFor(mergeFacts([{ botId: 'a', entries: ['x'] }]), 'a').others, []);
});

test('too many facts are capped by count and by size, keeping the latest', () => {
  const many = mergeFacts([{ botId: 'b', entries: Array.from({ length: 100 }, (_, i) => `Fact number ${i}.`) }]);
  const told = factsFor(many, 'a').others;
  assert.equal(told.length, 40);
  assert.equal(told.at(-1), 'Fact number 99.');
  assert.equal(told[0], 'Fact number 60.');
  const long = mergeFacts([{ botId: 'b', entries: Array.from({ length: 10 }, (_, i) => `${i}`.repeat(1000)) }]);
  const cut = factsFor(long, 'a').others;
  assert.ok(cut.join('').length <= 4000);
  assert.equal(cut.at(-1), '9'.repeat(1000));
});

test('removing a fact takes out that fact and nothing else', () => {
  const entries = ['Lives in Madrid.', 'Prefers short answers.', 'Has two dogs.'];
  assert.deepEqual(withoutFact(entries, factHash('Prefers short answers.')), ['Lives in Madrid.', 'Has two dogs.']);
  // The same fact stored with stray space goes too.
  assert.deepEqual(withoutFact(['  Has two dogs. ', 'x'], factHash('Has two dogs.')), ['x']);
});

test('removing a fact a bot does not have changes nothing', () => {
  const entries = ['Lives in Madrid.'];
  assert.equal(withoutFact(entries, factHash('Something else.')), entries);
  assert.equal(withoutFact(entries, ''), entries);
  assert.equal(withoutFact(entries, 'not-a-hash'), entries);
});

test('a near match is not removed', () => {
  const entries = ['Lives in Madrid.', 'Lives in Madrid', 'lives in madrid.'];
  assert.deepEqual(withoutFact(entries, factHash('Lives in Madrid.')), ['Lives in Madrid', 'lives in madrid.']);
});
