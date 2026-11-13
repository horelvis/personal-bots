import crypto from 'node:crypto';

/**
 * OAuth providers the app can sign people in with, through the operator's own OAuth client (no
 * intermediary). The flow in routes.ts is the same for every provider; everything that differs
 * lives in one entry here.
 *
 * To add a provider: add an entry to `CATALOG` with its endpoints, the scopes that identify a
 * person, and how its userinfo answer becomes a profile. A provider that differs from the common
 * case says so in its entry: `pkce` (it wants a code verifier), `tokenAuth: 'basic'` (the client
 * secret goes in a header, not the form), `loadProfile` (its profile takes more than one call, for
 * example a separate list of verified emails). It is offered as soon as
 * `<ID>_CLIENT_ID` and `<ID>_CLIENT_SECRET` are set (ID in capitals), with the redirect URI
 * `<SERVER_URL>/api/auth/<id>/callback` registered at the provider.
 *
 * To add a service of a provider (Gmail, Calendar, Drive...): add it to that entry's `services`
 * with the scopes it needs. `scopesFor(provider, ['gmail'])` then asks for them on top of the
 * sign-in scopes.
 */

export interface OAuthProfile { subject: string; email: string; name?: string }

export interface OAuthService { name: string; scopes: string[] }

export interface OAuthProvider {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** Scopes that are enough to know who the person is. */
  signInScopes: string[];
  /** Extra query parameters this provider wants on the authorize URL. */
  authParams?: Record<string, string>;
  /** Send a PKCE challenge with the sign-in and its verifier with the code. */
  pkce?: boolean;
  /** Where the client secret goes in the code exchange: the form body (default) or an HTTP Basic header. */
  tokenAuth?: 'body' | 'basic';
  /**
   * Gather what `profile` needs when one userinfo call is not enough. `get` fetches a URL of the
   * provider with the person's access token and returns the parsed JSON.
   */
  loadProfile?(get: (url: string) => Promise<any>): Promise<any>;
  /** What else can be asked of this provider, each with the scopes it needs. */
  services: Record<string, OAuthService>;
  /** The provider's userinfo answer as a profile, or null when it must not sign anyone in (no verified email). */
  profile(raw: any): OAuthProfile | null;
}

/** A provider as it is declared: everything but the credentials, which come from the environment. */
export type ProviderDefinition = Omit<OAuthProvider, 'clientId' | 'clientSecret'>;

const looksLikeEmail = (v: unknown): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const CATALOG: ProviderDefinition[] = [
  {
    id: 'google',
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    signInScopes: ['openid', 'email', 'profile'],
    authParams: { prompt: 'select_account' },
    // Google services go here, for example:
    //   gmail: { name: 'Gmail', scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
    //   calendar: { name: 'Google Calendar', scopes: ['https://www.googleapis.com/auth/calendar'] },
    services: {},
    profile(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const verified = raw.email_verified === true || raw.email_verified === 'true';
      if (!verified || !looksLikeEmail(raw.email) || !raw.sub) return null;
      return { subject: String(raw.sub), email: raw.email, name: typeof raw.name === 'string' && raw.name ? raw.name : undefined };
    },
  },
];

/** The providers of `catalog` whose client id and secret are both present in `vars` (normally process.env). */
export function configuredProviders(vars: Record<string, string | undefined>, catalog: ProviderDefinition[] = CATALOG): OAuthProvider[] {
  const out: OAuthProvider[] = [];
  for (const def of catalog) {
    const key = def.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const clientId = vars[`${key}_CLIENT_ID`]?.trim();
    const clientSecret = vars[`${key}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) out.push({ ...def, clientId, clientSecret });
  }
  return out;
}

/** Sign-in scopes plus those of the named services, each once. */
export function scopesFor(provider: OAuthProvider, services: string[]): string[] {
  const scopes = [...provider.signInScopes];
  for (const s of services) {
    const service = Object.hasOwn(provider.services, s) ? provider.services[s] : undefined;
    if (!service) throw new Error(`Unknown service "${s}" for ${provider.name}`);
    for (const scope of service.scopes) if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/** A fresh state for one sign-in. It names its provider, so a state made for one cannot finish another's flow. */
export const newState = (providerId: string) => `${providerId}.${crypto.randomBytes(24).toString('base64url')}`;

export function stateBelongsTo(providerId: string, state: string | undefined): boolean {
  const prefix = `${providerId}.`;
  return !!state && state.startsWith(prefix) && state.length > prefix.length;
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function authUrl(provider: OAuthProvider, a: { redirectUri: string; state: string; scopes: string[]; codeChallenge?: string }): string {
  const u = new URL(provider.authorizeUrl);
  for (const [k, v] of Object.entries(provider.authParams ?? {})) u.searchParams.set(k, v);
  u.searchParams.set('client_id', provider.clientId);
  u.searchParams.set('redirect_uri', a.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', a.scopes.join(' '));
  u.searchParams.set('state', a.state);
  if (a.codeChallenge) {
    u.searchParams.set('code_challenge', a.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

/** The state the browser kept against the one the provider sent back. Both must be there. */
export function sameState(kept: string | undefined, returned: string | undefined): boolean {
  if (!kept || !returned) return false;
  const a = Buffer.from(kept);
  const b = Buffer.from(returned);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }

/** Trade the code from the callback for tokens. */
export async function exchangeCode(provider: OAuthProvider, code: string, redirectUri: string, codeVerifier?: string): Promise<OAuthTokens> {
  const basic = provider.tokenAuth === 'basic';
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: provider.clientId });
  if (!basic) form.set('client_secret', provider.clientSecret);
  if (codeVerifier) form.set('code_verifier', codeVerifier);
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(basic ? { authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}` } : {}),
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    // The provider's error code is safe to log; the body may hold more than that.
    throw new Error(`${provider.name} refused the sign-in code (${res.status}${data?.error ? ` ${String(data.error).slice(0, 60)}` : ''})`);
  }
  return { accessToken: String(data.access_token), refreshToken: data.refresh_token ? String(data.refresh_token) : undefined, expiresIn: Number(data.expires_in) || undefined, scope: data.scope ? String(data.scope) : undefined };
}

/** Who the access token belongs to, or null when the provider gives no verified email. */
export async function fetchProfile(provider: OAuthProvider, accessToken: string): Promise<OAuthProfile | null> {
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${provider.name} did not return a profile (${res.status})`);
    return res.json().catch(() => null);
  };
  return provider.profile(provider.loadProfile ? await provider.loadProfile(get) : await get(provider.userinfoUrl));
}
