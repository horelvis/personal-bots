import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliAdapter, CliEvent, TurnOptions } from './adapter.js';
import { claude } from './claude.js';
import { runCli } from './run.js';

const opts: TurnOptions = {
  home: os.tmpdir(), cwd: os.tmpdir(), prompt: 'hi', system: '', sessionId: 'x', resume: false, model: null, effort: null,
  mcp: { url: 'http://127.0.0.1:1/mcp/b', token: 't' }, permissionTool: 'permission_prompt',
};

/** A stand-in CLI: node running `script`, read with Claude Code's own line format. */
const fake = (script: string): CliAdapter => ({
  ...claude,
  bin: process.execPath,
  command: () => ({ args: ['-e', script], files: [], stdin: '' }),
  environment: () => ({ PATH: process.env.PATH ?? '' }),
});

async function collect(adapter: CliAdapter, signal = new AbortController().signal): Promise<CliEvent[]> {
  const out: CliEvent[] = [];
  for await (const ev of runCli(adapter, opts, signal)) out.push(ev);
  return out;
}

const say = (o: object) => `console.log(${JSON.stringify(JSON.stringify(o))});`;

test('lines are parsed in order and noise between them is skipped', async () => {
  const script = [
    say({ type: 'system', subtype: 'init', session_id: 's1' }),
    'console.log("not json");',
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }),
    say({ type: 'result', subtype: 'success', is_error: false, result: 'Hello' }),
  ].join('');
  assert.deepEqual(await collect(fake(script)), [{ type: 'session', id: 's1' }, { type: 'text', text: 'Hello' }, { type: 'done' }]);
});

test('a CLI that dies without a result is an error with its last stderr line', async () => {
  const events = await collect(fake('console.error("warming up"); console.error("Not logged in"); process.exit(3);'));
  assert.deepEqual(events, [{ type: 'error', message: 'Not logged in' }]);
});

test('a CLI that is not installed says so', async () => {
  const events = await collect({ ...fake(''), bin: '/nonexistent/claude-cli' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match((events[0] as any).message, /not installed/);
});

test('the child sees only the environment the adapter allows', async () => {
  process.env.RUN_TEST_SECRET = 'leak';
  try {
    const script = `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: String(process.env.RUN_TEST_SECRET) }] } }));` + say({ type: 'result', subtype: 'success', is_error: false });
    assert.deepEqual(await collect(fake(script)), [{ type: 'text', text: 'undefined' }, { type: 'done' }]);
  } finally { delete process.env.RUN_TEST_SECRET; }
});

test('aborting stops the process and throws', async () => {
  const ctrl = new AbortController();
  const script = say({ type: 'system', subtype: 'init', session_id: 's1' }) + 'setTimeout(() => {}, 60000);';
  const seen: CliEvent[] = [];
  const started = Date.now();
  await assert.rejects(async () => {
    for await (const ev of runCli(fake(script), opts, ctrl.signal)) {
      seen.push(ev);
      ctrl.abort();
    }
  }, /interrupted/);
  assert.deepEqual(seen, [{ type: 'session', id: 's1' }]);
  assert.ok(Date.now() - started < 5000, 'the process was stopped, not waited for');
});

test('the prompt arrives on stdin and private files are written for the owner only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  try {
    const script = `let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:d}]}}));` + say({ type: 'result', subtype: 'success', is_error: false }) + '});';
    const adapter: CliAdapter = { ...fake(script), command: () => ({ args: ['-e', script], files: [{ path: path.join(home, 'secret.json'), content: '{"k":1}' }], stdin: 'what is up' }) };
    const out: CliEvent[] = [];
    for await (const ev of runCli(adapter, { ...opts, home }, new AbortController().signal)) out.push(ev);
    assert.deepEqual(out, [{ type: 'text', text: 'what is up' }, { type: 'done' }]);
    assert.equal(fs.readFileSync(path.join(home, 'secret.json'), 'utf8'), '{"k":1}');
    assert.equal(fs.statSync(path.join(home, 'secret.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('git cannot look for a repository above the bot home', async () => {
  const script = `console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: String(process.env.GIT_CEILING_DIRECTORIES) }] } }));` + say({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(await collect(fake(script)), [{ type: 'text', text: os.tmpdir() }, { type: 'done' }]);
});

// R8: a turn that runs elsewhere (a container) is stopped through the runner, not only by signalling the local client.
test('a runner prepares the process and is told to stop it when the turn is aborted', async () => {
  const stops: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-runner-'));
  const runner = {
    async prepare() {
      return { bin: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH ?? '' }, files: [{ path: path.join(dir, 'f.txt'), content: 'x' }], stdin: '', stop: () => { stops.push('stopped'); } };
    },
  };
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  await assert.rejects(async () => { for await (const _ of runCli(fake(''), { ...opts, home: dir, cwd: dir }, ctrl.signal, runner)) { /* nothing */ } }, /interrupted/);
  assert.deepEqual(stops, ['stopped']);
  assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});
