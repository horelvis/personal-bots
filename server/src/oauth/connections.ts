import { db, now } from '../db.js';
import { env } from '../env.js';
import { secretBox } from '../lib/secretbox.js';
import { RefreshError, refreshTokens, revokeToken, servicesCovered, type OAuthProfile, type OAuthProvider, type OAuthTokens } from './providers.js';
import { oauthProvider, oauthProviders } from './registry.js';

/**
 * A person's connection to a provider's services (Gmail, Calendar...): one row per person and
 * provider, holding the tokens of one grant and which services it is used for.
 *
 * Tokens are sealed with a key derived from SESSION_SECRET before they are stored, and leave this
 * module only as an access token for a call to the provider. They never go to the browser or to an
 * agent. A changed SESSION_SECRET makes the stored tokens unreadable: the person connects again.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  services TEXT NOT NULL,
  scopes TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`);

const box = secretBox(env.sessionSecret);

/** The service is not connected (never was, was disconnected, or the provider withdrew the grant). */
export class NotConnected extends Error {
  constructor(public provider: string, public service: string, name: string) {
    super(`${name} is not connected. Ask the user to connect it: in the app, open "Connect Apps" and choose ${name}.`);
  }
}

interface Row { user_id: string; provider: string; email: string; services: string; scopes: string; access_token: string; refresh_token: string | null; expires_at: number }

const rowFor = (userId: string, providerId: string) => db.prepare('SELECT * FROM oauth_connections WHERE user_id=? AND provider=?').get(userId, providerId) as Row | undefined;
const servicesOf = (row: Row | undefined): string[] => { try { return row ? (JSON.parse(row.services) as string[]) : []; } catch { return []; } };
const expiry = (tokens: OAuthTokens) => now() + (tokens.expiresIn ?? 3600) * 1000;

/** The services of this provider the person has connected. */
export const connectedServices = (userId: string, providerId: string): string[] => servicesOf(rowFor(userId, providerId));

/**
 * Keep the tokens of a finished connect flow. `wanted` are the services the flow asked for; only
 * those the provider actually granted every scope for are marked connected. Returns them.
 */
export function saveConnection(userId: string, provider: OAuthProvider, tokens: OAuthTokens, profile: OAuthProfile, wanted: string[]): string[] {
  const old = rowFor(userId, provider.id);
  const granted = servicesCovered(provider, tokens.scope ?? '');
  const services = wanted.filter((s) => granted.includes(s));
  // No refresh token comes back when the provider already gave one for this grant: keep the one we have.
  const refresh = tokens.refreshToken ? box.seal(tokens.refreshToken) : old?.refresh_token ?? null;
  if (!services.length) return [];
  db.prepare(
    `INSERT INTO oauth_connections(user_id,provider,email,subject,services,scopes,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id,provider) DO UPDATE SET email=excluded.email, subject=excluded.subject, services=excluded.services, scopes=excluded.scopes,
       access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
  ).run(userId, provider.id, profile.email, profile.subject, JSON.stringify(services), tokens.scope ?? '', box.seal(tokens.accessToken), refresh, expiry(tokens), now(), now());
  return services;
}

const refreshing = new Map<string, Promise<string>>();

/** An access token for one service of a provider, renewed when it is about to run out. Throws NotConnected. */
export async function accessTokenFor(userId: string, providerId: string, service: string): Promise<string> {
  const provider = oauthProvider(providerId);
  const name = provider?.services[service]?.name ?? service;
  const row = rowFor(userId, providerId);
  if (!provider || !row || !servicesOf(row).includes(service)) throw new NotConnected(providerId, service, name);
  const current = box.open(row.access_token);
  if (current && row.expires_at - now() > 60_000) return current;

  const key = `${userId}\n${providerId}`;
  let pending = refreshing.get(key);
  if (!pending) {
    pending = (async () => {
      const refresh = row.refresh_token ? box.open(row.refresh_token) : null;
      if (!refresh) {
        // Nothing to renew with (or sealed under another secret): the connection is over.
        db.prepare('DELETE FROM oauth_connections WHERE user_id=? AND provider=?').run(userId, providerId);
        throw new NotConnected(providerId, service, name);
      }
      try {
        const tokens = await refreshTokens(provider, refresh);
        db.prepare('UPDATE oauth_connections SET access_token=?, refresh_token=?, expires_at=?, updated_at=? WHERE user_id=? AND provider=?')
          .run(box.seal(tokens.accessToken), box.seal(tokens.refreshToken ?? refresh), expiry(tokens), now(), userId, providerId);
        return tokens.accessToken;
      } catch (e) {
        if (e instanceof RefreshError && e.revoked) {
          db.prepare('DELETE FROM oauth_connections WHERE user_id=? AND provider=?').run(userId, providerId);
          throw new NotConnected(providerId, service, name);
        }
        throw e;
      }
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

/** Stop using a service. When it was the last one of that provider, the grant is handed back and forgotten. */
export async function disconnectService(userId: string, providerId: string, service: string): Promise<void> {
  const row = rowFor(userId, providerId);
  if (!row) return;
  const left = servicesOf(row).filter((s) => s !== service);
  if (left.length) {
    db.prepare('UPDATE oauth_connections SET services=?, updated_at=? WHERE user_id=? AND provider=?').run(JSON.stringify(left), now(), userId, providerId);
    return;
  }
  db.prepare('DELETE FROM oauth_connections WHERE user_id=? AND provider=?').run(userId, providerId);
  const provider = oauthProvider(providerId);
  const token = (row.refresh_token && box.open(row.refresh_token)) || box.open(row.access_token);
  if (provider && token) await revokeToken(provider, token);
}

/** What the app shows: every configured provider with services, and which ones this person connected. Never any token. */
export function connectionsFor(userId: string) {
  return oauthProviders.filter((p) => Object.keys(p.services).length > 0).map((p) => {
    const row = rowFor(userId, p.id);
    const connected = servicesOf(row);
    return { id: p.id, name: p.name, email: row?.email ?? null, services: Object.entries(p.services).map(([id, s]) => ({ id, name: s.name, connected: connected.includes(id) })) };
  });
}
