import { Hono } from 'hono';
import { env } from './env.js';
import { getBotRow } from './store.js';
import { cliAdapter } from './agent/cli/index.js';
import { forwardModelRequest } from './lib/model-proxy.js';

/** `/cli-model/<botId>/...`: a containerized CLI bot's model requests, sent on with the real token (R8). */
export const cliModelApi = new Hono();

cliModelApi.all('/:botId/*', (c) => {
  const botId = c.req.param('botId');
  const bot = getBotRow(botId);
  if (!bot || !cliAdapter(bot.engine)) return c.json({ type: 'error', error: { type: 'not_found_error', message: 'No such bot.' } }, 404);
  const path = new URL(c.req.url).pathname.slice(`/cli-model/${botId}`.length);
  return forwardModelRequest(c.req.raw, { botId, path, secret: env.sessionSecret, token: env.claudeOauthToken, upstream: env.cliModelUpstream });
});
