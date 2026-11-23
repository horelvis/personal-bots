import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude } from './claude.js';
import { botNetworkCreateArgs, sandboxPlan, SANDBOX, turnContainerName } from './sandbox-plan.js';
import type { TurnOptions } from './adapter.js';

const opts: TurnOptions = {
  botId: 'bot_a1',
  home: '/srv/engines/bot_a1',
  cwd: '/srv/engines/bot_a1/work',
  prompt: 'hello',
  system: 'You are Alice.',
  sessionId: '00000000-0000-4000-8000-000000000000',
  resume: false,
  model: null,
  effort: null,
  mcp: { url: 'http://127.0.0.1:8787/mcp/bot_a1', token: 'mcp-token-a1' },
  permissionTool: 'permission_prompt',
};
const base = { image: 'hq-cli:abc', uid: 501, gid: 20, modelToken: 'sk-ant-oat01-hq-placeholder', name: 'hq-cli-bot_a1-1234abcd', tz: 'Europe/Madrid' };
const plan = sandboxPlan(claude, opts, base);
const flag = (name: string) => plan.args.filter((_, i) => plan.args[i - 1] === name);
const envIn = Object.fromEntries(flag('-e').map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));

test('a turn runs in a fresh container on the bot\'s own network, as the host user, with limits', () => {
  assert.equal(plan.bin, 'docker');
  assert.deepEqual(plan.args.slice(0, 4), ['run', '--rm', '-i', '--init']);
  assert.deepEqual(flag('--name'), ['hq-cli-bot_a1-1234abcd']);
  assert.deepEqual(flag('--network'), [`${SANDBOX.networkPrefix}bot_a1`]);
  assert.deepEqual(flag('--user'), ['501:20']);
  assert.deepEqual(flag('--memory'), ['2g']);
  assert.deepEqual(flag('--cpus'), ['2']);
  assert.deepEqual(flag('--pids-limit'), ['512']);
  assert.deepEqual(flag('--cap-drop'), ['ALL']);
  assert.deepEqual(flag('--security-opt'), ['no-new-privileges']);
  assert.ok(flag('--label').includes('hq.cli.turn=bot_a1'));
  assert.equal(plan.args[plan.args.indexOf('hq-cli:abc') + 1], 'claude');
});

test('a root server runs the container as the unprivileged image user, never as root', () => {
  const p = sandboxPlan(claude, opts, { ...base, uid: 0, gid: 0 });
  assert.deepEqual(p.args.filter((_, i) => p.args[i - 1] === '--user'), [`${SANDBOX.uid}:${SANDBOX.uid}`]);
  assert.equal(p.chownTo, SANDBOX.uid);
  assert.equal(plan.chownTo, null);
});

test('the container sees only the bot\'s folder: its home read-only, work and the CLI\'s own files writable', () => {
  assert.deepEqual(flag('-v'), [
    '/srv/engines/bot_a1:/hq:ro',
    '/srv/engines/bot_a1/work:/hq/work',
    '/srv/engines/bot_a1/claude:/hq/claude',
  ]);
  assert.deepEqual(flag('-w'), ['/hq/work']);
  assert.ok(flag('--tmpfs').includes('/tmp'));
});

test('no host credentials enter the container: only a placeholder token, and the gate for the app, the model and the web', () => {
  assert.deepEqual(envIn, {
    HOME: '/hq/claude',
    CLAUDE_CONFIG_DIR: '/hq/claude',
    ANTHROPIC_BASE_URL: 'http://gate:8787/cli-model/bot_a1',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-hq-placeholder',
    HTTP_PROXY: 'http://gate:3128',
    HTTPS_PROXY: 'http://gate:3128',
    http_proxy: 'http://gate:3128',
    https_proxy: 'http://gate:3128',
    NO_PROXY: 'gate',
    no_proxy: 'gate',
    GIT_CEILING_DIRECTORIES: '/hq',
    MCP_TOOL_TIMEOUT: String(30 * 60_000),
    TZ: 'Europe/Madrid',
    LANG: 'C.UTF-8',
  });
  assert.ok(!plan.args.some((a) => /ANTHROPIC_API_KEY|mcp-token-a1/.test(a)), 'no key or app token on the command line');
});

test('the CLI is pointed at container paths and the gate, and its files are written in the bot\'s home on the host', () => {
  const i = plan.args.indexOf('claude');
  const cli = plan.args.slice(i + 1);
  assert.equal(cli[cli.indexOf('--mcp-config') + 1], '/hq/mcp.json');
  assert.equal(cli[cli.indexOf('--append-system-prompt-file') + 1], '/hq/system.md');
  assert.deepEqual(plan.files.map((f) => f.path), ['/srv/engines/bot_a1/mcp.json', '/srv/engines/bot_a1/system.md']);
  const mcp = JSON.parse(plan.files[0].content);
  assert.equal(mcp.mcpServers.hq.url, 'http://gate:8787/mcp/bot_a1');
  assert.equal(mcp.mcpServers.hq.headers.Authorization, 'Bearer mcp-token-a1');
  assert.equal(plan.stdin, 'hello');
});

test('turn container names are valid docker names, unique and tied to the bot', () => {
  const a = turnContainerName('bot_a1'), b = turnContainerName('bot_a1');
  assert.notEqual(a, b);
  assert.match(a, /^hq-cli-bot_a1-[0-9a-f]{8}$/);
  assert.match(turnContainerName('we!rd id'), /^hq-cli-we-rd-id-[0-9a-f]{8}$/);
});

// Found after review (R8.2): on Linux a container on an --internal network still reached host services
// listening on all interfaces through the network's gateway address. The host must have no address there.
test('a bot network is internal and gives the host no address on it', () => {
  assert.deepEqual(botNetworkCreateArgs('bot_a1'), [
    'network', 'create', '--internal',
    '-o', 'com.docker.network.bridge.inhibit_ipv4=true',
    '--label', 'hq.cli=1',
    'hq-cli-net-bot_a1',
  ]);
});
