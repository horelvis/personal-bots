// Gives one eval user a Google connection (Gmail and Calendar) whose token only the stand-in knows.
// Run with the eval server's environment: npx tsx evals/seed.ts <userId> <token>
import { saveConnection } from '../server/src/oauth/connections.js';
import { oauthProvider } from '../server/src/oauth/registry.js';

const [userId, token] = process.argv.slice(2);
const google = oauthProvider('google');
if (!userId || !token || !google) throw new Error('usage: seed.ts <userId> <token> (with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set)');
const scope = Object.values(google.services).flatMap((s) => s.scopes).join(' ');
const services = saveConnection(userId, google, { accessToken: token, refreshToken: `refresh-${token}`, expiresIn: 10 * 365 * 24 * 3600, scope }, { subject: `eval-${userId}`, email: 'me@example.com' }, ['gmail', 'calendar']);
console.log(JSON.stringify({ services }));
