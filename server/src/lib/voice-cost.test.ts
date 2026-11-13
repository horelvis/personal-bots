import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCost, voiceCost, voiceRates } from './voice-cost.js';

const rates = { perMinute: 0.08, perTextItem: 0.004 };

test('a call costs its minutes, by the second, plus the text notes sent into it', () => {
  assert.equal(voiceCost(60_000, 0, rates), 0.08);
  assert.equal(voiceCost(90_000, 0, rates), 0.12);
  assert.equal(voiceCost(0, 0, rates), 0);
  assert.equal(voiceCost(60_000, 2, rates), 0.088);
  assert.equal(voiceCost(-5, -3, rates), 0);
  assert.equal(voiceCost(60_000, 2.9, rates), 0.088);
});

test('a cost is shown as an estimate in dollars, and never as zero once something was spent', () => {
  assert.equal(formatCost(0.12), '~$0.12');
  assert.equal(formatCost(1.5), '~$1.50');
  assert.equal(formatCost(12.345), '~$12.35');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0), '$0.00');
});

test('rates come from the environment when they are sensible numbers, else the published ones', () => {
  assert.deepEqual(voiceRates({}), { perMinute: 0.08, perTextItem: 0.004 });
  assert.deepEqual(voiceRates({ XAI_VOICE_USD_PER_MIN: '0.1', XAI_VOICE_USD_PER_TEXT_ITEM: '0' }), { perMinute: 0.1, perTextItem: 0 });
  assert.deepEqual(voiceRates({ XAI_VOICE_USD_PER_MIN: 'free', XAI_VOICE_USD_PER_TEXT_ITEM: '-1' }), { perMinute: 0.08, perTextItem: 0.004 });
  assert.deepEqual(voiceRates({ XAI_VOICE_USD_PER_MIN: '' }), { perMinute: 0.08, perTextItem: 0.004 });
});
