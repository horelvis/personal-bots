import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpPortFor, displayFor, displayNumber, parseDisplayList, screenIdFor, vncPortFor } from './screens.js';

test('the default screen is display 99, other screens carry their display number', () => {
  assert.equal(displayFor('default'), ':99');
  assert.equal(displayFor(null), ':99');
  assert.equal(displayFor(undefined), ':99');
  assert.equal(displayFor('screen-100'), ':100');
  assert.equal(displayNumber('default'), 99);
  assert.equal(displayNumber('screen-101'), 101);
});

test('screen ids round-trip through display numbers', () => {
  assert.equal(screenIdFor(99), 'default');
  assert.equal(screenIdFor(102), 'screen-102');
  for (const n of [99, 100, 101, 102]) assert.equal(displayNumber(screenIdFor(n)), n);
});

test('ports follow the display number', () => {
  assert.equal(cdpPortFor('default'), 9299);
  assert.equal(cdpPortFor('screen-100'), 9300);
  // Host ports stay clear of 6000-6063, which X11 uses.
  assert.equal(vncPortFor('default'), 59099);
  assert.equal(vncPortFor('screen-102'), 59102);
});

test('the display list becomes screens, default first, junk lines ignored', () => {
  const screens = parseDisplayList('100 1440 900\nnot a display\n99 1280 800\n\n101 x y\n');
  assert.deepEqual(screens, [
    { id: 'default', display: ':99', width: 1280, height: 800, default: true },
    { id: 'screen-100', display: ':100', width: 1440, height: 900, default: false },
  ]);
  assert.deepEqual(parseDisplayList(''), []);
});
