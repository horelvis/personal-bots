import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMessage, parseButton, pickBot } from './route.js';

const bots = [{ id: 'b1', name: 'Doug', isPrimary: true }, { id: 'b2', name: 'Alice', isPrimary: false }, { id: 'b3', name: 'Mary Jane', isPrimary: false }];

test('a message goes to the main bot unless it names another one', () => {
  assert.deepEqual(pickBot('Hello there', bots), { botId: 'b1', text: 'Hello there' });
  assert.deepEqual(pickBot('@alice what is on today?', bots), { botId: 'b2', text: 'what is on today?' });
  assert.deepEqual(pickBot('Alice: email Bob', bots), { botId: 'b2', text: 'email Bob' });
  assert.deepEqual(pickBot('Mary Jane: hi', bots), { botId: 'b3', text: 'hi' });
  // A name that is no bot stays part of the message.
  assert.deepEqual(pickBot('Bob: hi', bots), { botId: 'b1', text: 'Bob: hi' });
  assert.deepEqual(pickBot('@nobody hi', bots), { botId: 'b1', text: '@nobody hi' });
  // No main bot: the first one.
  assert.deepEqual(pickBot('hi', [bots[1], bots[2]]), { botId: 'b2', text: 'hi' });
  assert.equal(pickBot('hi', []), null);
  assert.equal(pickBot('   ', bots), null);
});

test('an approval card becomes a message with buttons tied to that approval', () => {
  const m = cardMessage({ botName: 'Doug', title: 'Gmail: send an email', detail: 'To: ana@example.com\nSubject: Hi', approvalId: 'apr_123', alwaysOffered: true });
  assert.match(m.text, /Doug/);
  assert.match(m.text, /Gmail: send an email/);
  assert.match(m.text, /ana@example\.com/);
  assert.deepEqual(m.buttons.flat().map((b) => b.data), ['ap:apr_123:allow', 'ap:apr_123:deny', 'ap:apr_123:always']);
  const noAlways = cardMessage({ botName: 'Doug', title: 'x', detail: '', approvalId: 'apr_1', alwaysOffered: false });
  assert.deepEqual(noAlways.buttons.flat().map((b) => b.data), ['ap:apr_1:allow', 'ap:apr_1:deny']);
  // Telegram limits a message to 4096 characters.
  assert.ok(cardMessage({ botName: 'D', title: 't', detail: 'x'.repeat(10000), approvalId: 'a', alwaysOffered: false }).text.length <= 4096);
});

test('button data is read back only when it is well formed', () => {
  assert.deepEqual(parseButton('ap:apr_123:allow'), { approvalId: 'apr_123', decision: 'allow' });
  assert.deepEqual(parseButton('ap:apr_1:always'), { approvalId: 'apr_1', decision: 'always' });
  for (const bad of ['ap:apr_1:yes', 'ap::allow', 'xx:apr_1:allow', 'ap:apr 1:allow', '', 'ap:apr_1:allow:extra']) assert.equal(parseButton(bad), null, bad);
});
