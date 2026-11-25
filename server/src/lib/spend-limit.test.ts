import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitDecision, typicalCost } from './spend-limit.js';

test('no limit: always runs', () => {
  assert.equal(limitDecision({ spent: 1000, limit: null, typical: 50 }).run, true);
});

test('at or over the limit: does not run', () => {
  const d = limitDecision({ spent: 10, limit: 10, typical: null });
  assert.equal(d.run, false);
  assert.equal(d.run === false && d.why, 'reached');
});

test('a run that would clearly pass the limit is not started', () => {
  const d = limitDecision({ spent: 9.5, limit: 10, typical: 0.8 });
  assert.equal(d.run === false && d.why, 'would-pass');
  assert.equal(limitDecision({ spent: 9.5, limit: 10, typical: 0.4 }).run, true);
  assert.equal(limitDecision({ spent: 9.5, limit: 10, typical: null }).run, true);
});

test('the typical cost of a run is the median of the last five known costs', () => {
  assert.equal(typicalCost([]), null);
  assert.equal(typicalCost([null, null]), null);
  assert.equal(typicalCost([0.1, 0.5, 0.3]), 0.3);
  assert.equal(typicalCost([0.1, 0.2, 0.3, 0.4, 9, 100]), 0.3); // only the last five (newest first): 0.1..9
  assert.ok(Math.abs((typicalCost([0.2, null, 0.4]) ?? 0) - 0.3) < 1e-9);
});
