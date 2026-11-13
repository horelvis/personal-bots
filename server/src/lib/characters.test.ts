import assert from 'node:assert/strict';
import { test } from 'node:test';
import { characterSvg, CHARACTERS, isCharacter } from './characters.js';

test('there are ten characters, each with its own id and name', () => {
  assert.equal(CHARACTERS.length, 10);
  assert.equal(new Set(CHARACTERS.map((c) => c.id)).size, 10);
  for (const c of CHARACTERS) {
    assert.match(c.id, /^bot-[a-z]+$/);
    assert.ok(c.name.length > 2);
  }
});

test('a character is told apart from the drawn shapes', () => {
  assert.equal(isCharacter('bot-chef'), true);
  assert.equal(isCharacter('blob'), false);
  assert.equal(isCharacter('bot-nobody'), false);
  assert.equal(isCharacter('bot-casual'), true);
  assert.equal(isCharacter(undefined), false);
});

test('a character becomes a round picture with a white rim, for screens that only take SVG', () => {
  const svg = characterSvg('data:image/png;base64,AAAA', '#DDEEFF');
  assert.match(svg, /<circle cx="48" cy="48" r="44" fill="#DDEEFF"\/>/);
  assert.match(characterSvg('data:image/png;base64,AAAA', 'red"/><script>'), /fill="#E8ECF3"/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 96 96">/);
  assert.match(svg, /<clipPath id="hqc"><circle cx="48" cy="48" r="44"\/><\/clipPath>/);
  assert.match(svg, /<image [^>]*href="data:image\/png;base64,AAAA"[^>]*clip-path="url\(#hqc\)"/);
  assert.throws(() => characterSvg('https://example.com/a.jpg'), /data/i);
  assert.throws(() => characterSvg('data:image/jpeg;base64,AA"/><script>'), /data/i);
});
