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
  assert.equal(box.open('not sealed'), null);
  assert.equal(box.open(''), null);
});

/** The sealed text with one bit changed in byte `at` of what it encodes (after the "v1." prefix). */
function withBitFlipped(sealed: string, at: number): string {
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  raw[at] ^= 0x01;
  return `v1.${raw.toString('base64url')}`;
}

// Changing a character of the sealed text could leave it the same (it did, 1 run in 64): change a
// bit of the bytes instead, in the nonce, the tag and the body, over many seals.
test('a sealed text changed anywhere opens as null', () => {
  const box = secretBox('a-long-server-secret');
  for (let i = 0; i < 200; i++) {
    const sealed = box.seal('token');
    // Bytes: 0-11 the nonce, 12-27 the tag, 28 onwards the sealed text.
    for (const at of [0, 11, 12, 27, 28, 32]) {
      const changed = withBitFlipped(sealed, at);
      assert.notEqual(changed, sealed);
      assert.equal(box.open(changed), null, `byte ${at} changed, seal ${i}`);
    }
  }
});
