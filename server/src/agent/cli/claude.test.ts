import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude } from './claude.js';
import type { TurnOptions } from './adapter.js';

const base: TurnOptions = {
  home: '/tmp/bot',
  cwd: '/tmp/bot/work',
  prompt: 'hello',
  system: 'You are Ada.',
  sessionId: '5fc807a6-0522-4739-9898-35f0232c1f54',
  resume: false,
  model: null,
  effort: 'medium',
  mcp: { url: 'http://127.0.0.1:8787/mcp/bot_1', token: 'tok' },
  permissionTool: 'permission_prompt',
};

const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('a first turn starts a session with the given id', () => {
  const { args } = claude.command(base);
  assert.equal(valueOf(args, '--session-id'), base.sessionId);
  assert.ok(!args.includes('--resume'));
  assert.equal(args[0], '-p');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
});

// Other processes on the machine (another bot's shell, `ps`) can read a command line.
test('nothing private is on the command line: prompt, persona and token travel another way', () => {
  const c = claude.command({ ...base, prompt: 'my private question', system: 'Private persona and memory.' });
  const line = c.args.join(' ');
  assert.ok(!line.includes('my private question'));
  assert.ok(!line.includes('Private persona'));
  assert.ok(!line.includes('tok'));
  assert.equal(c.stdin, 'my private question');
  const file = (name: string) => c.files.find((f) => f.path === `/tmp/bot/${name}`)?.content ?? '';
  assert.equal(valueOf(c.args, '--append-system-prompt-file'), '/tmp/bot/system.md');
  assert.equal(file('system.md'), 'Private persona and memory.');
  assert.equal(valueOf(c.args, '--mcp-config'), '/tmp/bot/mcp.json');
  assert.equal(JSON.parse(file('mcp.json')).mcpServers.hq.headers.Authorization, 'Bearer tok');
  // The files sit beside the work folder, not in it: reading them is a read outside the bot's folder.
  assert.ok(c.files.every((f) => !f.path.startsWith(base.cwd)));
});

test('a later turn resumes the session instead of starting one', () => {
  const { args } = claude.command({ ...base, resume: true });
  assert.equal(valueOf(args, '--resume'), base.sessionId);
  assert.ok(!args.includes('--session-id'));
});

test('permission prompts go to the app and are never switched off', () => {
  const { args } = claude.command(base);
  assert.equal(valueOf(args, '--permission-prompt-tool'), 'mcp__hq__permission_prompt');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('bypassPermissions'));
  // Only the app's own tools and reading the web skip the prompt; shell and file writes do not.
  const allowed = valueOf(args, '--allowedTools').split(',');
  assert.deepEqual(allowed.sort(), ['WebFetch', 'WebSearch', 'mcp__hq']);
});

test("the host user's settings and MCP servers are left out", () => {
  const { args } = claude.command(base);
  assert.equal(valueOf(args, '--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  const cfg = JSON.parse(claude.command(base).files.find((f) => f.path.endsWith('mcp.json'))!.content);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['hq']);
  assert.equal(cfg.mcpServers.hq.url, base.mcp.url);
});

test('model and effort are passed only when set', () => {
  assert.ok(!claude.command(base).args.includes('--model'));
  const { args } = claude.command({ ...base, model: 'sonnet', effort: 'high' });
  assert.equal(valueOf(args, '--model'), 'sonnet');
  assert.equal(valueOf(args, '--effort'), 'high');
});

test('a prompt that looks like a flag cannot become one', () => {
  const c = claude.command({ ...base, prompt: '--dangerously-skip-permissions' });
  assert.ok(!c.args.includes('--dangerously-skip-permissions'));
  assert.equal(c.stdin, '--dangerously-skip-permissions');
});

test('init gives the session id', () => {
  assert.deepEqual(claude.parse({ type: 'system', subtype: 'init', session_id: 'abc', tools: [] }), [{ type: 'session', id: 'abc' }]);
});

test('text and thinking deltas of the main agent are mapped; a sub-agent is ignored', () => {
  const delta = (d: any, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: d } });
  assert.deepEqual(claude.parse(delta({ type: 'text_delta', text: 'Hi' })), [{ type: 'delta', text: 'Hi' }]);
  assert.deepEqual(claude.parse(delta({ type: 'thinking_delta', thinking: 'hmm' })), [{ type: 'reasoning', text: 'hmm' }]);
  assert.deepEqual(claude.parse(delta({ type: 'input_json_delta', partial_json: '{' })), []);
  assert.deepEqual(claude.parse(delta({ type: 'text_delta', text: 'Hi' }, 'toolu_1')), []);
});

test('an assistant message yields its text and tool calls in order', () => {
  const msg = {
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_2', name: 'mcp__hq__create_routine', input: { name: 'x' } },
    ] },
  };
  assert.deepEqual(claude.parse(msg), [
    { type: 'text', text: 'On it.' },
    { type: 'tool', callId: 'toolu_1', name: 'Bash', args: { command: 'ls' } },
    { type: 'tool', callId: 'toolu_2', name: 'mcp__hq__create_routine', args: { name: 'x' } },
  ]);
});

test('tool results carry their call id, text and error flag', () => {
  const plain = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'probe-ok', is_error: false }] } };
  assert.deepEqual(claude.parse(plain), [{ type: 'tool-result', callId: 'toolu_1', text: 'probe-ok', isError: false }]);
  const parts = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'pong' }] }] } };
  assert.deepEqual(claude.parse(parts), [{ type: 'tool-result', callId: 'toolu_2', text: 'pong', isError: false }]);
  const denied = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'The user declined this action.', is_error: true }] } };
  assert.deepEqual(claude.parse(denied), [{ type: 'tool-result', callId: 'toolu_3', text: 'The user declined this action.', isError: true }]);
});

test('the result ends the turn; a failed one is an error with its reason', () => {
  assert.deepEqual(claude.parse({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), [{ type: 'done' }]);
  assert.deepEqual(claude.parse({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }), [{ type: 'error', message: 'Not logged in' }]);
  assert.deepEqual(claude.parse({ type: 'result', subtype: 'error_max_turns', is_error: true }), [{ type: 'error', message: 'error max turns' }]);
});

test('lines the app does not need are dropped', () => {
  assert.deepEqual(claude.parse({ type: 'rate_limit_event' }), []);
  assert.deepEqual(claude.parse({ type: 'system', subtype: 'status', status: 'requesting' }), []);
  assert.deepEqual(claude.parse(null), []);
});

test('the child gets no secrets of the app, only what the CLI needs', () => {
  const env = claude.environment({ PATH: '/bin', HOME: '/home/u', SESSION_SECRET: 's3cret', GOOGLE_CLIENT_SECRET: 'g', XAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'a', TZ: 'UTC' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.TZ, 'UTC');
  assert.equal(env.ANTHROPIC_API_KEY, 'a');
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(env.XAI_API_KEY, undefined);
});

// R6 (S11): every shell command and read goes to the app's check, not only what the CLI deems risky.
test('the CLI asks the app before every shell command and read', () => {
  const { args } = claude.command(base);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.ask.sort(), ['Bash', 'Glob', 'Grep', 'Read']);
});
