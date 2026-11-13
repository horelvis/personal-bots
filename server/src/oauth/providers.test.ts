import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authUrl, configuredProviders, sameState, scopesFor, type OAuthProvider } from './providers.js';

const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh' };
const google = () => configuredProviders(env).find((p) => p.id === 'google')!;

test('a provider is offered only when both its client id and secret are set', () => {
  assert.deepEqual(configuredProviders({}).map((p) => p.id), []);
  assert.deepEqual(configuredProviders({ GOOGLE_CLIENT_ID: 'x' }).map((p) => p.id), []);
  assert.deepEqual(configuredProviders({ GOOGLE_CLIENT_SECRET: 'y' }).map((p) => p.id), []);
  assert.deepEqual(configuredProviders(env).map((p) => p.id), ['google']);
  assert.equal(google().clientId, 'cid.apps.googleusercontent.com');
});

test('the Google sign-in URL asks for identity only and carries the state', () => {
  const p = google();
  const u = new URL(authUrl(p, { redirectUri: 'http://localhost:8787/api/auth/google/callback', state: 'st4te', scopes: scopesFor(p, []) }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8787/api/auth/google/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  assert.equal(u.searchParams.get('state'), 'st4te');
});

test('the state must be present on both sides and equal', () => {
  assert.equal(sameState('abc123', 'abc123'), true);
  assert.equal(sameState('abc123', 'abc124'), false);
  assert.equal(sameState('abc123', 'abc1234'), false);
  assert.equal(sameState(undefined, 'abc123'), false);
  assert.equal(sameState('abc123', undefined), false);
  assert.equal(sameState('', ''), false);
});

test('only a verified Google email becomes a profile', () => {
  const profile = google().profile;
  assert.deepEqual(profile({ sub: '1', email: 'Ana@Example.com', email_verified: true, name: 'Ana' }), { subject: '1', email: 'Ana@Example.com', name: 'Ana' });
  assert.deepEqual(profile({ sub: '1', email: 'ana@example.com', email_verified: 'true' }), { subject: '1', email: 'ana@example.com', name: undefined });
  assert.equal(profile({ sub: '1', email: 'ana@example.com', email_verified: false, name: 'Ana' }), null);
  assert.equal(profile({ sub: '1', email: 'ana@example.com' }), null);
  assert.equal(profile({ sub: '1', email_verified: true }), null);
  assert.equal(profile({ sub: '1', email: 'not-an-email', email_verified: true }), null);
  assert.equal(profile(null), null);
});

// What adding a provider, or a service of one, amounts to: one more entry of this shape.
const acme: OAuthProvider = {
  id: 'acme', name: 'Acme', clientId: 'acme-id', clientSecret: 'acme-secret',
  authorizeUrl: 'https://acme.example/oauth/authorize', tokenUrl: 'https://acme.example/oauth/token', userinfoUrl: 'https://acme.example/me',
  signInScopes: ['identity'],
  authParams: { audience: 'api' },
  services: { files: { name: 'Acme Files', scopes: ['files.read', 'files.write'] }, mail: { name: 'Acme Mail', scopes: ['mail.send', 'identity'] } },
  profile: () => null,
};

test('a service adds its scopes to the sign-in ones, without repeats, and unknown services are refused', () => {
  assert.deepEqual(scopesFor(acme, []), ['identity']);
  assert.deepEqual(scopesFor(acme, ['files']), ['identity', 'files.read', 'files.write']);
  assert.deepEqual(scopesFor(acme, ['files', 'mail']), ['identity', 'files.read', 'files.write', 'mail.send']);
  assert.throws(() => scopesFor(acme, ['nope']), /unknown service/i);
  assert.deepEqual(scopesFor(google(), []), ['openid', 'email', 'profile']);
});

test('any provider gets the same URL shape, plus its own extra parameters', () => {
  const u = new URL(authUrl(acme, { redirectUri: 'https://hq.example/api/auth/acme/callback', state: 's', scopes: scopesFor(acme, ['files']) }));
  assert.equal(u.origin + u.pathname, 'https://acme.example/oauth/authorize');
  assert.equal(u.searchParams.get('scope'), 'identity files.read files.write');
  assert.equal(u.searchParams.get('audience'), 'api');
  assert.equal(u.searchParams.get('client_id'), 'acme-id');
});
