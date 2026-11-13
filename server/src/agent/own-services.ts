import { connectedServices } from '../oauth/connections.js';
import { oauthProviders } from '../oauth/registry.js';
import { GOOGLE_SERVICE_TOOLS } from './google-tools.js';
import type { ServiceTools } from './apps-guidance.js';

/** Which tools use which service of which provider. A new service with tools gets a line here. */
const TOOLS_OF: Record<string, Record<string, string[]>> = { google: GOOGLE_SERVICE_TOOLS };

/** The services this server connects with its own OAuth clients, the tools that use each, and whether this person connected it. */
export function ownServices(userId: string): ServiceTools[] {
  const out: ServiceTools[] = [];
  for (const p of oauthProviders) {
    const connected = connectedServices(userId, p.id);
    for (const [id, service] of Object.entries(p.services)) {
      const tools = TOOLS_OF[p.id]?.[id];
      if (tools?.length) out.push({ id, name: service.name, provider: p.name, connected: connected.includes(id), tools });
    }
  }
  return out;
}
