// Runs the eval scenarios against an isolated server (R10). Usage: npm run evals [-- --only id1,id2] [--jobs 3]
// The bot is Claude Code with this machine's sign-in; with CLAUDE_CODE_OAUTH_TOKEN set it runs in a container (R8).
// Each result is saved in evals/results/ and compared with the previous one.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGoogle } from './fake-google.mjs';
import { SCENARIOS } from './scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('only')?.split(',');
const jobs = Math.max(1, Number(arg('jobs') ?? 3));
const TURN_LIMIT_MS = Number(arg('timeout') ?? 6 * 60_000);
const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keys the app needs from the user's own .env (the action check's model); nothing else of it is used. */
function fromDotEnv(names) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && names.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return out;
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// Under the home folder: Docker on macOS only shares that with its VM (R8).
fs.mkdirSync(path.join(os.homedir(), '.cache'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'hq-evals-'));
fs.mkdirSync(path.join(scratch, 'ph'), { recursive: true });
const fake = await startFakeGoogle();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const own = { ...process.env, ...fromDotEnv(['XAI_API_KEY', 'XAI_MODEL', 'TRUST_MODEL', 'TRUST_MODEL_URL', 'CLAUDE_CODE_OAUTH_TOKEN']) };
const sandbox = own.CLAUDE_CODE_OAUTH_TOKEN ? { CLI_SANDBOX: 'docker', CLAUDE_CODE_OAUTH_TOKEN: own.CLAUDE_CODE_OAUTH_TOKEN } : {};
const serverEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER ?? '',
  ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
  DEV_LOGIN: '1', HQ_BOX: 'docker', PORT: String(port), MAX_BOTS: '50',
  DB_PATH: path.join(scratch, 'hq.db'), ENGINES_DIR: path.join(scratch, 'engines'), HERMES_HOME_PRIMARY: path.join(scratch, 'ph'),
  HERMES_BIN: '/usr/bin/false', HERMES_URL: 'http://127.0.0.1:9', APP_URL: base,
  GOOGLE_CLIENT_ID: 'eval', GOOGLE_CLIENT_SECRET: 'eval', GOOGLE_API_URL: fake.url,
  XAI_API_KEY: own.XAI_API_KEY ?? 'unset',
  ...(own.XAI_MODEL ? { XAI_MODEL: own.XAI_MODEL } : {}), ...(own.TRUST_MODEL ? { TRUST_MODEL: own.TRUST_MODEL } : {}),
  ...(own.XAI_API_KEY ? {} : { TRUST_MODEL_URL: 'http://127.0.0.1:9' }),
  ...(process.env.CLAUDE_BIN ? { CLAUDE_BIN: process.env.CLAUDE_BIN } : {}),
  GROKBOT_NO_SCHEDULER: '1',
  ...sandbox,
};
const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: path.join(ROOT, 'server'), env: serverEnv, stdio: ['ignore', fs.openSync(path.join(scratch, 'server.log'), 'w'), fs.openSync(path.join(scratch, 'server.log'), 'a')] });
const stop = () => { try { server.kill('SIGTERM'); } catch {} fake.close(); };
process.on('SIGINT', () => { stop(); process.exit(130); });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(250); }

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
}

async function runScenario(s) {
  const t0 = Date.now();
  const call = client();
  await call('POST', '/auth/dev', { email: `eval-${s.id}@example.com`, name: 'Eval user' });
  const userId = (await call('GET', '/auth/me')).user.id;
  const token = `tok-${s.id}-${crypto.randomBytes(4).toString('hex')}`;
  const seeded = spawnSync('npx', ['tsx', path.join(ROOT, 'evals/seed.ts'), userId, token], { cwd: path.join(ROOT, 'server'), env: serverEnv, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr.slice(-300)}`);
  await fetch(`${fake.url}/_state/${token}`, { method: 'PUT', body: JSON.stringify({ messages: s.mail ?? [], events: s.events ?? [] }) });
  let bot;
  for (let i = 0; i < 40 && !bot; i++) { try { bot = (await call('POST', '/bots', { name: 'Eva', engine: 'claude' })).bot; } catch (e) { if (i === 39) throw e; await sleep(5000); } }
  const cards = [];
  try {
    await call('POST', `/bots/${bot.id}/messages`, { text: s.prompt });
    const answered = new Set();
    let idleSince = 0;
    while (Date.now() - t0 < TURN_LIMIT_MS) {
      await sleep(1500);
      const rows = (await call('GET', `/bots/${bot.id}/rows`)).rows;
      for (const r of rows) {
        const b = r.body;
        if (b.type !== 'card' || b.card !== 'approval' || b.status !== 'pending' || answered.has(b.approvalId)) continue;
        const allow = !!s.approve(b);
        answered.add(b.approvalId);
        cards.push({ tool: b.tool, title: b.title, detail: String(b.detail ?? '').slice(0, 300), allowed: allow });
        await call('POST', `/approvals/${b.approvalId}`, { decision: allow ? 'allow' : 'deny' });
      }
      const live = (await call('GET', '/bots')).live?.find?.((l) => l.botId === bot.id);
      const busy = live?.isRunning || rows.some((r) => r.body.type === 'card' && r.body.status === 'pending');
      if (!busy && rows.some((r) => r.body.type === 'message' && r.body.role === 'assistant' && !r.body.streaming)) { if (!idleSince) idleSince = Date.now(); if (Date.now() - idleSince > 3000) break; }
      else idleSince = 0;
    }
    const rows = (await call('GET', `/bots/${bot.id}/rows`)).rows;
    const reply = rows.filter((r) => r.body.type === 'message' && r.body.role === 'assistant').map((r) => r.body.text).join('\n\n');
    const notices = rows.filter((r) => r.body.type === 'notice').map((r) => r.body.text);
    const memories = (await call('GET', `/bots/${bot.id}/memories`)).memories ?? [];
    const state = await (await fetch(`${fake.url}/_state/${token}`)).json();
    const timedOut = Date.now() - t0 >= TURN_LIMIT_MS;
    const v = s.judge({ state, reply, memories, cards });
    const unsafe = v.unsafe ?? [];
    const falseMemories = v.falseMemories ?? [];
    return { id: s.id, kind: s.kind, done: !!v.done && !timedOut, unsafe, falseMemories, askedAbout: cards.filter((c) => !c.allowed).map((c) => c.title), cards, reply: reply.slice(0, 1500), notices, timedOut, ms: Date.now() - t0 };
  } finally {
    await call('DELETE', `/bots/${bot.id}`).catch(() => {});
  }
}

const started = new Date();
console.log(`Running ${scenarios.length} scenarios, ${jobs} at a time, on ${sandbox.CLI_SANDBOX ? 'Claude Code in a container' : 'Claude Code on this machine'}. Logs: ${scratch}`);
const results = [];
const queue = [...scenarios];
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let s = queue.shift(); s; s = queue.shift()) {
    let r;
    try { r = await runScenario(s); } catch (e) { r = { id: s.id, kind: s.kind, done: false, unsafe: [], falseMemories: [], askedAbout: [], error: String(e?.message ?? e) }; }
    results.push(r);
    const mark = r.error ? 'ERROR' : r.unsafe.length || r.falseMemories.length ? 'UNSAFE' : r.done ? 'PASS' : 'FAIL';
    console.log(`${mark.padEnd(6)} ${r.id}${r.error ? `: ${r.error}` : ''}${r.unsafe.length ? ` · unsafe: ${r.unsafe.join('; ')}` : ''}${r.falseMemories.length ? ` · kept: ${r.falseMemories.join('; ')}` : ''}${r.askedAbout.length ? ` · asked about: ${r.askedAbout.length}` : ''}${r.timedOut ? ' · timed out' : ''}`);
  }
}));
stop();

// Spending recorded by the server (R9), for the record.
let cost = null;
try { const db = spawnSync('sqlite3', [serverEnv.DB_PATH, 'SELECT COALESCE(SUM(cost_usd),0) FROM spending']); cost = Number(String(db.stdout).trim()); } catch {}
results.sort((a, b) => SCENARIOS.findIndex((s) => s.id === a.id) - SCENARIOS.findIndex((s) => s.id === b.id));
const total = {
  scenarios: results.length,
  done: results.filter((r) => r.done).length,
  unsafeActions: results.reduce((n, r) => n + r.unsafe.length, 0),
  falseMemories: results.reduce((n, r) => n + r.falseMemories.length, 0),
  askedAbout: results.reduce((n, r) => n + r.askedAbout.length, 0),
  errors: results.filter((r) => r.error).length,
  listPriceUsd: cost,
};
const commit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const dir = path.join(ROOT, 'evals', 'results');
fs.mkdirSync(dir, { recursive: true });
const previous = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
const file = path.join(dir, `${started.toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify({ started: started.toISOString(), commit, engine: sandbox.CLI_SANDBOX ? 'claude (container)' : 'claude (host)', total, results }, null, 2));

console.log(`\n${total.done} of ${total.scenarios} tasks done, ${total.unsafeActions} unsafe action${total.unsafeActions === 1 ? '' : 's'}, ${total.falseMemories} false memor${total.falseMemories === 1 ? 'y' : 'ies'} kept${total.errors ? `, ${total.errors} errors` : ''} (${total.askedAbout} cards denied; list price US$${(cost ?? 0).toFixed(2)}).`);
if (previous) {
  const before = JSON.parse(fs.readFileSync(path.join(dir, previous), 'utf8'));
  console.log(`Compared with ${previous} (${before.commit}): done ${before.total.done} -> ${total.done}, unsafe ${before.total.unsafeActions} -> ${total.unsafeActions}, false memories ${before.total.falseMemories} -> ${total.falseMemories}.`);
  for (const r of results) {
    const was = before.results.find((x) => x.id === r.id);
    if (!was) continue;
    const st = (x) => (x.unsafe?.length || x.falseMemories?.length ? 'unsafe' : x.done ? 'pass' : 'fail');
    if (st(was) !== st(r)) console.log(`  ${r.id}: ${st(was)} -> ${st(r)}`);
  }
}
console.log(`Saved ${path.relative(ROOT, file)}.`);
if (total.errors || total.unsafeActions || total.falseMemories) console.log(`Server log kept in ${scratch}.`);
else fs.rmSync(scratch, { recursive: true, force: true });
process.exit(total.unsafeActions || total.falseMemories ? 1 : 0);
