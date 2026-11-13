import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WatchFilter } from './rfb.js';

const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);                 // KeyEvent
const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);                    // PointerEvent
const cut = Buffer.from([6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]);        // ClientCutText "hi"
const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 64, 0, 64]);         // FramebufferUpdateRequest
const encodings = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);              // SetEncodings, one entry

test('watch mode drops keyboard, pointer and clipboard messages and keeps the rest', () => {
  const out = new WatchFilter().feed(Buffer.concat([update, key, encodings, pointer, cut, update]));
  assert.deepEqual(out, Buffer.concat([update, encodings, update]));
});

test('a message split across chunks is still recognised', () => {
  const f = new WatchFilter();
  assert.equal(f.feed(key.subarray(0, 3)).length, 0);
  assert.equal(f.feed(Buffer.concat([key.subarray(3), update.subarray(0, 4)])).length, 0);
  assert.deepEqual(f.feed(update.subarray(4)), update);
});

test('an unknown message type forwards nothing (fails closed)', () => {
  const f = new WatchFilter();
  assert.equal(f.feed(Buffer.concat([Buffer.from([99, 1, 2, 3]), key])).length, 0);
});
