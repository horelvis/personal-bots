import crypto from 'node:crypto';

/**
 * What a bot is told about the apps it can reach, and two small things that depend on the same
 * facts. Pure: the callers gather what is configured and connected.
 */

/** A service the server connects with its own OAuth client (Gmail, Google Calendar), and the tools that use it. */
export interface ServiceTools { id: string; name: string; provider: string; connected: boolean; tools: string[] }

const COMPOSIO = 'find the right action with COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL. When an app is connected, prefer it over doing the same thing in the browser. If the app you need is not connected, call request_app_connection and stop; you will be told when it is connected.';

/**
 * The lines of a bot's instructions about connected apps. A bot only uses a tool it was told about:
 * its own services are named with their tools, and it is told plainly what is not available, so it
 * does not go looking for another way in (another connector, the browser).
 */
export function appsGuidance(a: { owner: string; services: ServiceTools[]; composio: boolean }): string {
  if (!a.services.length) {
    return a.composio
      ? `- Connected apps (Gmail, Calendar, Slack, GitHub, Notion and many more): ${COMPOSIO}`
      : '- No connected apps are set up here: do not call COMPOSIO tools or request_app_connection.';
  }
  const lines = a.services.map((s) => (s.connected
    ? `- ${s.name} is connected through ${a.owner}'s own ${s.provider} account: use ${s.tools.join(', ')}. Prefer these over the browser and over any other connector.`
    : `- ${s.name} is not connected. Its tools (${s.tools.join(', ')}) will say so. If you need it, ask ${a.owner} to open "Connect Apps" in the app and connect ${s.name} under ${s.provider}, then stop; do not use request_app_connection, another connector or the browser for it.`));
  const names = a.services.map((s) => s.name).join(' or ');
  lines.push(a.composio
    ? `- Other connected apps (Slack, GitHub, Notion and many more): ${COMPOSIO} Not for ${names}: that goes through the tools above.`
    : '- No other connected apps are set up here: do not call COMPOSIO tools or request_app_connection.');
  return lines.join('\n');
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The own service a bot means when it asks for an app by one of its usual names ("gmail", "googlecalendar"). */
export function serviceForToolkit(toolkit: string, services: ServiceTools[]): ServiceTools | undefined {
  const asked = squash(toolkit);
  if (!asked) return undefined;
  return services.find((s) => {
    const id = squash(s.id), name = squash(s.name), provider = squash(s.provider);
    return asked === id || asked === name || asked === provider + id || asked === provider + name || asked === id.replace(provider, '') || (asked === 'googlemail' && id === 'gmail');
  });
}

/**
 * A short stamp of a tool set. An agent reads the list of tools once, when it starts: when the
 * stamp it started with differs from the current one, it has to start again to see the new tools.
 */
export function toolsStamp(tools: { name: string; description: string }[]): string {
  const h = crypto.createHash('sha256');
  for (const t of [...tools].sort((x, y) => x.name.localeCompare(y.name))) h.update(`${t.name}\0${t.description}\0`);
  return h.digest('hex').slice(0, 16);
}
