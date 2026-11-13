import { configuredProviders, type OAuthProvider } from './providers.js';

/** The OAuth providers this server has a client for. Read once at start: changing the variables needs a restart. */
export const oauthProviders: OAuthProvider[] = configuredProviders(process.env);

export const oauthProvider = (id: string): OAuthProvider | undefined => oauthProviders.find((p) => p.id === id);
