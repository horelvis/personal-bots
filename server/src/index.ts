import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals, recoverTurns } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines } from './engine.js';
import { TOOLS } from './agent/tools.js';
import { toolsStamp } from './agent/apps-guidance.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true, engine: 'hermes' }));
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[hq] server on http://localhost:${info.port}`);
  // Only a server that really got the port may take the queue and start the schedulers. A second
  // start on the same database fails to listen a moment later; had it already picked up the stored
  // turns, it would have run them beside the live server and marked that server's running turn as
  // interrupted. Nothing can queue a turn before this point: no request is served yet.
  // GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
  if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
    // First the turns the last stop cut off, so they keep their place ahead of anything queued from now on.
    // A failure there must not keep the routines, triggers and check-ins from starting.
    try { recoverTurns(); } catch (e: any) { console.error('[agent] could not pick up the turns from before the restart:', e?.message ?? e); }
    initRoutines(enqueue);
    void initTriggers(enqueue);
    initProactive(enqueue);
  } else console.log('[hq] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
});
attachVncRelay(server as unknown as Server);
startIdleWatcher();
initEngines(toolsStamp(TOOLS));
