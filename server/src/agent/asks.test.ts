import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterAnswer, askBotWaitSeconds, createAsks } from './asks.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('the asker gets the answer when the asked bot finishes', async () => {
  const asks = createAsks(1000);
  const id = asks.open('a', 'b')!;
  const waiting = asks.wait(id);
  assert.equal(asks.settle(id, '  It is 42.  '), 'delivered');
  assert.deepEqual(await waiting, { status: 'answered', text: 'It is 42.' });
});

test('a bot that finishes without saying anything gives no answer', async () => {
  const asks = createAsks(1000);
  const id = asks.open('a', 'b')!;
  const waiting = asks.wait(id);
  assert.equal(asks.settle(id, '   '), 'delivered');
  assert.deepEqual(await waiting, { status: 'no_answer' });
  const id2 = asks.open('a', 'b')!;
  const waiting2 = asks.wait(id2);
  asks.settle(id2, null);
  assert.deepEqual(await waiting2, { status: 'no_answer' });
});

test('past the limit the asker stops waiting, and the answer that comes after is late', async () => {
  const asks = createAsks(20);
  const id = asks.open('a', 'b')!;
  assert.deepEqual(await asks.wait(id), { status: 'timeout' });
  // The asked bot finishes afterwards: the caller must deliver this one as a message.
  assert.equal(asks.settle(id, 'Here it is.'), 'late');
  // And only once.
  assert.equal(asks.settle(id, 'Here it is.'), 'unknown');
});

test('an answer is delivered once', async () => {
  const asks = createAsks(1000);
  const id = asks.open('a', 'b')!;
  const waiting = asks.wait(id);
  assert.equal(asks.settle(id, 'one'), 'delivered');
  assert.equal(asks.settle(id, 'two'), 'unknown');
  assert.deepEqual(await waiting, { status: 'answered', text: 'one' });
});

test('asking back the bot that is waiting for you is refused at once', async () => {
  const asks = createAsks(1000);
  const ab = asks.open('a', 'b')!;
  void asks.wait(ab);
  assert.equal(asks.open('b', 'a'), null);
  // Once a has its answer, b may ask a.
  asks.settle(ab, 'done');
  assert.notEqual(asks.open('b', 'a'), null);
});

test('a longer circle is refused too', async () => {
  const asks = createAsks(1000);
  void asks.wait(asks.open('a', 'b')!);
  void asks.wait(asks.open('b', 'c')!);
  assert.equal(asks.open('c', 'a'), null);
  // Not a circle: d is outside it.
  assert.notEqual(asks.open('c', 'd'), null);
});

test('a bot cannot ask itself', () => {
  assert.equal(createAsks(1000).open('a', 'a'), null);
});

test('one bot may wait for two others at the same time', async () => {
  const asks = createAsks(1000);
  const b = asks.open('a', 'b')!;
  const c = asks.open('a', 'c')!;
  const wb = asks.wait(b);
  const wc = asks.wait(c);
  asks.settle(c, 'from c');
  asks.settle(b, 'from b');
  assert.deepEqual(await wb, { status: 'answered', text: 'from b' });
  assert.deepEqual(await wc, { status: 'answered', text: 'from c' });
});

test('when the asker stops, it no longer waits and no longer blocks others', async () => {
  const asks = createAsks(1000);
  const id = asks.open('a', 'b')!;
  const waiting = asks.wait(id);
  asks.release('a');
  assert.deepEqual(await waiting, { status: 'timeout' });
  // b can ask a now: a is not waiting for b any more.
  assert.notEqual(asks.open('b', 'a'), null);
  // b's answer to the old question arrives later, as a message.
  assert.equal(asks.settle(id, 'late answer'), 'late');
});

test('a timeout does not leave the circle check blocked', async () => {
  const asks = createAsks(20);
  await asks.wait(asks.open('a', 'b')!);
  await tick();
  assert.notEqual(asks.open('b', 'a'), null);
});

test('ask sends the question and resolves with the answer', async () => {
  const asks = createAsks(1000);
  let sent = '';
  const waiting = asks.ask('a', 'b', (id) => { sent = id; });
  assert.notEqual(sent, '');
  asks.settle(sent, 'yes');
  assert.deepEqual(await waiting, { status: 'answered', text: 'yes' });
});

test('ask refuses a circle without sending anything', async () => {
  const asks = createAsks(1000);
  void asks.ask('a', 'b', () => {});
  let sent = false;
  assert.deepEqual(await asks.ask('b', 'a', () => { sent = true; }), { status: 'circle' });
  assert.equal(sent, false);
});

// A question that could not be sent must not sit there as if someone were waiting for it.
test('when sending fails, nobody is left waiting', async () => {
  const asks = createAsks(1000);
  await assert.rejects(asks.ask('a', 'b', () => { throw new Error('row write failed'); }), /row write failed/);
  // b may ask a at once: a is not waiting for b.
  assert.notEqual(asks.open('b', 'a'), null);
});

test('what to do when the asked bot finishes', () => {
  // The asker has the answer already, or the question is unknown: nothing more to do.
  assert.equal(afterAnswer('delivered', 'text'), 'nothing');
  assert.equal(afterAnswer('unknown', 'text'), 'nothing');
  // The asker stopped waiting and was promised a later answer.
  assert.equal(afterAnswer('late', 'Here it is.'), 'send_reply');
  // ...so it must also hear when none will come.
  assert.equal(afterAnswer('late', '   '), 'say_no_answer');
  assert.equal(afterAnswer('late', ''), 'say_no_answer');
});

test('the wait setting falls back to 9 minutes and stays under the tool-call limit', () => {
  assert.equal(askBotWaitSeconds(undefined), 540);
  assert.equal(askBotWaitSeconds(''), 540);
  assert.equal(askBotWaitSeconds('abc'), 540);
  assert.equal(askBotWaitSeconds('0'), 540);
  assert.equal(askBotWaitSeconds('-5'), 540);
  assert.equal(askBotWaitSeconds('6'), 6);
  assert.equal(askBotWaitSeconds('99999999'), 1500);
});
