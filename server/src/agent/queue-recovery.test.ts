import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery } from './queue-recovery.js';

const row = (id: number, botId: string, state: string, trigger: unknown) => ({ id, bot_id: botId, state, trigger: typeof trigger === 'string' ? trigger : JSON.stringify(trigger) });

test('a turn that was running is interrupted, never run again', () => {
  const plan = planRecovery([row(1, 'a', 'running', { type: 'user', text: 'send the email' })]);
  assert.deepEqual(plan.interrupted, [{ id: 1, botId: 'a' }]);
  assert.deepEqual(plan.resume, []);
});

test('turns that were waiting run again, in the order they were queued', () => {
  const plan = planRecovery([
    row(7, 'a', 'queued', { type: 'user', text: 'third' }),
    row(3, 'a', 'queued', { type: 'user', text: 'first' }),
    row(5, 'b', 'queued', { type: 'system', text: 'second' }),
  ]);
  assert.deepEqual(plan.resume.map((r) => [r.id, r.botId, (r.trigger as any).text]), [[3, 'a', 'first'], [5, 'b', 'second'], [7, 'a', 'third']]);
  assert.deepEqual(plan.interrupted, []);
});

test('the turn that was running is reported and the ones behind it still run', () => {
  const plan = planRecovery([
    row(1, 'a', 'running', { type: 'user', text: 'one' }),
    row(2, 'a', 'queued', { type: 'user', text: 'two' }),
  ]);
  assert.deepEqual(plan.interrupted, [{ id: 1, botId: 'a' }]);
  assert.deepEqual(plan.resume.map((r) => r.id), [2]);
});

test('every kind of trigger is kept as it was', () => {
  const triggers = [
    { type: 'user', text: 'hi' },
    { type: 'routine', routineId: 'r1', name: 'Morning', prompt: 'summarize' },
    { type: 'bot', fromBotId: 'b', fromName: 'Bob', text: 'done', depth: 2 },
    { type: 'system', text: 'The user connected Gmail.' },
  ];
  const plan = planRecovery(triggers.map((t, i) => row(i + 1, 'a', 'queued', t)));
  assert.deepEqual(plan.resume.map((r) => r.trigger), triggers);
});

// Who waits for whom is kept in memory: after a restart nobody is waiting for this answer.
test('a queued question from another bot becomes an ordinary message from it', () => {
  const plan = planRecovery([row(1, 'a', 'queued', { type: 'bot', fromBotId: 'b', fromName: 'Bob', text: 'what time is it?', depth: 1, askId: 'ask_4' })]);
  assert.deepEqual(plan.resume[0].trigger, { type: 'bot', fromBotId: 'b', fromName: 'Bob', text: 'what time is it?', depth: 1 });
});

test('a stored turn that cannot be read is dropped, not run and not a crash', () => {
  const plan = planRecovery([
    row(1, 'a', 'queued', '{not json'),
    row(2, 'a', 'queued', { type: 'mystery', text: 'x' }),
    row(3, 'a', 'queued', { type: 'user' }),
    row(4, 'a', 'queued', { type: 'user', text: 'ok' }),
    row(5, 'a', 'weird-state', { type: 'user', text: 'x' }),
  ]);
  assert.deepEqual(plan.resume.map((r) => r.id), [4]);
  assert.deepEqual(plan.dropped, [1, 2, 3, 5]);
});

test('nothing stored, nothing to do', () => {
  assert.deepEqual(planRecovery([]), { interrupted: [], resume: [], dropped: [] });
});
