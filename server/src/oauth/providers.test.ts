import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { authUrl, configuredProviders, exchangeCode, fetchProfile, newState, pkcePair, sameState, scopesFor, stateBelongsTo, type OAuthProvider, type ProviderDefinition } from './providers.js';

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

test('a state names its provider, and only that provider accepts it', () => {
  const s = newState('google');
  assert.match(s, /^google\.[\w-]{20,}$/);
  assert.notEqual(newState('google'), s);
  assert.equal(stateBelongsTo('google', s), true);
  assert.equal(stateBelongsTo('acme', s), false);
  assert.equal(stateBelongsTo('goo', s), false);
  assert.equal(stateBelongsTo('google', undefined), false);
  assert.equal(stateBelongsTo('google', 'google.'), false);
});

// The same provider as a catalog entry: everything except the credentials, which come from the environment.
const { clientId: _id, clientSecret: _secret, ...acmeDef } = acme;
const catalogEntry: ProviderDefinition = acmeDef;

test('a provider added to the catalog is offered once its own client id and secret are set', () => {
  const vars = { ...env, ACME_CLIENT_ID: 'a', ACME_CLIENT_SECRET: 'b' };
  assert.deepEqual(configuredProviders(vars, [catalogEntry]).map((p) => p.id), ['acme']);
  assert.deepEqual(configuredProviders(env, [catalogEntry]).map((p) => p.id), []);
});

test('PKCE: the challenge is the SHA-256 of the verifier, and the URL carries it only when asked', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[\w-]{43,128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const base = { redirectUri: 'https://hq.example/cb', state: 's', scopes: ['identity'] };
  const withIt = new URL(authUrl(acme, { ...base, codeChallenge: challenge }));
  assert.equal(withIt.searchParams.get('code_challenge'), challenge);
  assert.equal(withIt.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(authUrl(acme, base)).searchParams.has('code_challenge'), false);
});

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the code exchange sends the secret where the provider wants it, and the verifier when there is one', async (t) => {
  const calls: { url: string; headers: Headers; body: URLSearchParams }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: new URLSearchParams(String(init.body)) });
    return answer({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'identity' });
  });
  const tokens = await exchangeCode(acme, 'c0de', 'https://hq.example/cb', 'ver1fier');
  assert.deepEqual(tokens, { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scope: 'identity' });
  assert.equal(calls[0].url, 'https://acme.example/oauth/token');
  assert.equal(calls[0].body.get('code'), 'c0de');
  assert.equal(calls[0].body.get('code_verifier'), 'ver1fier');
  assert.equal(calls[0].body.get('client_secret'), 'acme-secret');
  assert.equal(calls[0].headers.has('authorization'), false);

  await exchangeCode({ ...acme, tokenAuth: 'basic' }, 'c0de', 'https://hq.example/cb');
  assert.equal(calls[1].body.has('client_secret'), false);
  assert.equal(calls[1].body.has('code_verifier'), false);
  assert.equal(calls[1].headers.get('authorization'), `Basic ${Buffer.from('acme-id:acme-secret').toString('base64')}`);
});

test('a refused code is an error that names the provider and not the secret', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => answer({ error: 'invalid_grant', error_description: 'acme-secret leaked?' }, 400));
  await assert.rejects(exchangeCode(acme, 'bad', 'https://hq.example/cb'), (e: Error) => /Acme refused the sign-in code \(400 invalid_grant\)/.test(e.message) && !e.message.includes('acme-secret'));
});

test('a provider can gather its profile from more than one call', async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    seen.push(`${url} ${new Headers(init.headers).get('authorization')}`);
    return String(url).endsWith('/emails') ? answer([{ email: 'old@acme.example', primary: false, verified: true }, { email: 'ana@acme.example', primary: true, verified: true }]) : answer({ id: 7, name: 'Ana' });
  });
  const twoCalls: OAuthProvider = {
    ...acme,
    async loadProfile(get) {
      const [me, emails] = await Promise.all([get(this.userinfoUrl), get('https://acme.example/me/emails')]);
      return { ...me, email: (emails as any[]).find((e) => e.primary && e.verified)?.email };
    },
    profile: (raw) => (raw?.email ? { subject: String(raw.id), email: raw.email, name: raw.name } : null),
  };
  assert.deepEqual(await fetchProfile(twoCalls, 'at'), { subject: '7', email: 'ana@acme.example', name: 'Ana' });
  assert.deepEqual(seen.sort(), ['https://acme.example/me Bearer at', 'https://acme.example/me/emails Bearer at']);
});
