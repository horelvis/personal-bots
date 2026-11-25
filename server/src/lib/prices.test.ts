import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, parsePrices } from './prices.js';

const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('a known model is priced per million tokens, including cache reads and writes', () => {
  // claude-sonnet-5-5: $2 in, $10 out, cache read $0.10, cache write 1.25 x input.
  close(estimateCost('claude-sonnet-5-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 }), 2 + 1 + 0.2 + 1);
});

test('a model name with a date or a provider prefix matches the base model', () => {
  close(estimateCost('claude-haiku-4-5-20251001', { input: 1_000_000, output: 0 }), 1);
  close(estimateCost('anthropic/claude-opus-5-5', { input: 0, output: 1_000_000 }), 20);
});

test('an unknown model, or no tokens reported, has no cost', () => {
  assert.equal(estimateCost('grok-4.7', { input: 1000, output: 1000 }), null);
  assert.equal(estimateCost('hermes-agent', { input: 1000, output: 1000 }), null);
  assert.equal(estimateCost(null, { input: 1000, output: 1000 }), null);
  assert.equal(estimateCost('claude-sonnet-5-5', null), null);
});

test('MODEL_PRICES adds or overrides prices; a bad value is ignored', () => {
  const extra = parsePrices('{"grok-4.7": {"input": 3, "output": 15}, "claude-sonnet-5-5": {"input": 1, "output": 1}}');
  close(estimateCost('grok-4.7', { input: 1_000_000, output: 1_000_000 }, extra), 18);
  close(estimateCost('claude-sonnet-5-5', { input: 1_000_000, output: 0 }, extra), 1);
  assert.deepEqual(parsePrices('not json'), {});
  assert.deepEqual(parsePrices('{"x": {"input": "a"}}'), {});
});
