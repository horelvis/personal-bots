import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretBox } from './secretbox.js';

test('what is sealed comes back, and never sits in the sealed text', () => {
  const box = secretBox('a-long-server-secret');
  const sealed = box.seal('ya29.refresh-token-ñ');
  assert.equal(box.open(sealed), 'ya29.refresh-token-ñ');
  assert.equal(sealed.includes('ya29'), false);
  assert.notEqual(box.seal('ya29.refresh-token-ñ'), sealed);
});

test('a different secret, a changed text or junk opens as null', () => {
  const box = secretBox('a-long-server-secret');
  const sealed = box.seal('token');
  assert.equal(secretBox('another-secret').open(sealed), null);
  const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  assert.equal(box.open(flipped), null);
  assert.equal(box.open('not sealed'), null);
  assert.equal(box.open(''), null);
});
