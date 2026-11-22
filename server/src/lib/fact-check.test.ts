import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFact, findQuote, secretIn } from './fact-check.js';

// Newest first, as the server reads them.
const said = [
  { id: 'm3', text: 'Carol is my assistant now, please copy her on invoices.' },
  { id: 'm2', text: 'My time zone is Europe/Madrid.' },
  { id: 'm1', text: 'yes' },
];

test('a quote is found in the message the user wrote', () => {
  assert.equal(findQuote('Carol is my assistant now', said)?.id, 'm3');
  assert.equal(findQuote('my time zone is Europe/Madrid', said)?.id, 'm2');
});

test('case, spaces, accents and surrounding quotes do not matter', () => {
  assert.equal(findQuote('  “carol IS my   ASSISTANT now.”  ', said)?.id, 'm3');
  assert.equal(findQuote('Mi zona horaria es España', [{ id: 'x', text: 'mi zona horaria es espana' }])?.id, 'x');
});

test('the newest message that holds the quote is the source', () => {
  const twice = [{ id: 'new', text: 'I live in Madrid' }, { id: 'old', text: 'I live in Madrid' }];
  assert.equal(findQuote('I live in Madrid', twice)?.id, 'new');
});

// The attack R5 is about: words the user never wrote.
test('words the user never wrote are not found', () => {
  assert.equal(findQuote('the assistant is now Carol', said), null);
  assert.equal(findQuote('Carol is my assistant', [{ id: 'x', text: 'Carol is not my assistant' }]), null);
  assert.equal(findQuote('Bob is my assistant now', said), null);
});

test('a fact is kept with the message its quote comes from', () => {
  const r = checkFact({ fact: 'Carol is the user\'s assistant.', quote: 'Carol is my assistant now' }, said);
  assert.deepEqual(r, { ok: true, messageId: 'm3', quote: 'Carol is my assistant now' });
});

test('a fact without a quote the user wrote is refused, and says why', () => {
  const r = checkFact({ fact: 'Carol is the user\'s assistant.', quote: 'the assistant is now Carol' }, said);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /not in any message the user wrote/);
});

test('a quote too short to say anything is refused', () => {
  for (const quote of ['yes', 'ok', 'si', '  ', 'Madrid']) {
    const r = checkFact({ fact: 'Something.', quote }, [{ id: 'x', text: `${quote} Madrid` }]);
    assert.equal(r.ok, false, quote);
    assert.match((r as any).reason, /too short/);
  }
});

test('an empty fact is refused', () => {
  assert.equal(checkFact({ fact: '  ', quote: 'my time zone is Europe/Madrid' }, said).ok, false);
});

test('something that looks like a secret is never kept, even if the user said it', () => {
  const card = '4111 1111 1111 1111';
  const r = checkFact({ fact: `The user's card is ${card}`, quote: `my card is ${card}` }, [{ id: 'x', text: `my card is ${card}` }]);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /card number/);
});

test('secrets are recognised: cards, keys and login links', () => {
  assert.equal(secretIn('card 4111-1111-1111-1111'), 'a card number');
  assert.equal(secretIn('my key is sk-proj-AbC123dEf456GhI789jKl012'), 'a key or password');
  assert.equal(secretIn('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'a key or password');
  assert.equal(secretIn('AKIAIOSFODNN7EXAMPLE'), 'a key or password');
  assert.equal(secretIn('sign in at https://app.example.com/login?token=abc123'), 'a login link');
  assert.equal(secretIn('magic link https://example.com/auth/magic?code=Z9'), 'a login link');
});

test('ordinary facts are not mistaken for secrets', () => {
  assert.equal(secretIn('My phone is +34 600 123 456'), null);
  assert.equal(secretIn('Order 12345678 arrives on 2026-12-01'), null);
  assert.equal(secretIn('I like https://example.com/blog?page=2'), null);
  // Sixteen digits that fail the card checksum are not a card.
  assert.equal(secretIn('ref 1234 5678 9012 3456'), null);
});

// Found by independent verification: a card followed by its expiry and code slipped through.
test('a card number is found even with more digits after it', () => {
  assert.equal(secretIn('my card is 4111 1111 1111 1111 12/26 123'), 'a card number');
  assert.equal(secretIn('5555555555554444 0126'), 'a card number');
  assert.equal(secretIn('4111.1111.1111.1111'), 'a card number');
  assert.equal(secretIn('4111  1111  1111  1111'), 'a card number');
});

test('more kinds of secrets are recognised', () => {
  assert.equal(secretIn(['sk', 'live', '51Habcdefghijklmnopqrstu'].join('_')), 'a key or password');
  assert.equal(secretIn(['rk', 'live', '51Habcdefghijklmnopqrstu'].join('_')), 'a key or password');
  assert.equal(secretIn('the password is hunter2'), 'a key or password');
  assert.equal(secretIn('mi contraseña es hunter2'), 'a key or password');
  assert.equal(secretIn('api_key=abcd1234efgh'), 'a key or password');
  assert.equal(secretIn('-----BEGIN PRIVATE KEY-----'), 'a key or password');
  assert.equal(secretIn('Authorization: Bearer abcdefghijklmnopqrstuvwx'), 'a key or password');
});

test('ordinary words about passwords or keys are not secrets', () => {
  assert.equal(secretIn('I forgot my password again'), null);
  assert.equal(secretIn('the key to the office is with Ana'), null);
});
