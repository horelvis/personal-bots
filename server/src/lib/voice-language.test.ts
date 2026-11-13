import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGES, languageName, parseAcceptLanguage, resolveLanguage, sttLanguage } from './voice-language.js';

test('there is no automatic language: every entry is a language someone picks', () => {
  assert.equal(LANGUAGES.some((l) => /auto/i.test(l.code) || /auto/i.test(l.name)), false);
  assert.ok(LANGUAGES.length >= 20);
  assert.equal(languageName('es-ES'), 'Spanish (Spain)');
  assert.equal(languageName('ES-es'), 'Spanish (Spain)');
  assert.equal(languageName('auto'), undefined);
});

test('a chosen language is used as chosen', () => {
  assert.equal(resolveLanguage('es-ES', ['en-US']), 'es-ES');
  assert.equal(resolveLanguage('pt-br', ['en-US']), 'pt-BR');
  assert.equal(resolveLanguage('ja', []), 'ja');
});

test('a bot that never had a language chosen gets the closest to what the person reads, never "auto"', () => {
  assert.equal(resolveLanguage('auto', ['es-ES', 'en']), 'es-ES');
  assert.equal(resolveLanguage('auto', ['es-AR', 'en']), 'es-MX');     // same language, another region: the first listed
  assert.equal(resolveLanguage(undefined, ['fr-CA']), 'fr');
  assert.equal(resolveLanguage('', ['en-GB']), 'en');
  assert.equal(resolveLanguage('klingon', ['xx', 'de-DE']), 'de');
  assert.equal(resolveLanguage('auto', []), 'en');
  assert.equal(resolveLanguage('auto', ['xx-YY']), 'en');
});

test('the browser header is read in order of preference', () => {
  assert.deepEqual(parseAcceptLanguage('es-ES,es;q=0.9,en;q=0.8'), ['es-ES', 'es', 'en']);
  assert.deepEqual(parseAcceptLanguage('en;q=0.5, fr-FR;q=0.9, *;q=0.1'), ['fr-FR', 'en']);
  assert.deepEqual(parseAcceptLanguage(undefined), []);
  assert.deepEqual(parseAcceptLanguage(''), []);
});

test('dictation takes the language without its region, and always gets one', () => {
  assert.equal(sttLanguage('es-ES'), 'es');
  assert.equal(sttLanguage('pt-BR'), 'pt');
  assert.equal(sttLanguage('ar-EG'), 'ar');
  assert.equal(sttLanguage('en'), 'en');
});
