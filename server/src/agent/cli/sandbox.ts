import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../env.js';
import { docker } from '../../dockerbox.js';
import { placeholderToken } from '../../lib/model-proxy.js';
import type { CliRunner } from './adapter.js';
import { botNetwork, sandboxPlan, SANDBOX, turnContainerName } from './sandbox-plan.js';

/**
 * CLI bots in containers (R8, CLI_SANDBOX=docker). Each turn is a fresh `docker run --rm` of the
 * image in box/cli on the bot's own internal network; the gate, one container for all bots, is the
 * only way out of it (see box/cli/gate.mjs). A turn never falls back to the host.
 */

const IMAGE_DIR = fileURLToPath(new URL('../../../box/cli/', import.meta.url));
const GATE = 'hq-cli-gate';
/** The gate's way to the internet: an ordinary bridge network. */
const EGRESS = 'hq-cli-egress';
const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

/** Named after its sources, so editing them builds a new image (and replaces the gate). */
function imageTag(): string {
  const h = crypto.createHash('sha256');
  for (const f of ['Dockerfile', 'gate.mjs']) h.update(`${f}\0`).update(fs.readFileSync(path.join(IMAGE_DIR, f)));
  return `hq-cli:${h.digest('hex').slice(0, 12)}`;
}

let building: Promise<string> | null = null;

/** The image, built on first use (a minute or two). */
export function ensureImage(): Promise<string> {
  const tag = imageTag();
  building ??= (async () => {
    if ((await docker(['image', 'inspect', tag])).code === 0) return tag;
    console.log(`[cli] building ${tag} for CLI bots (first run takes a minute or two)`);
    const built = await docker(['build', '-t', tag, IMAGE_DIR], { timeoutMs: 20 * 60_000 });
    if (built.code !== 0) throw new Error(`Could not build the CLI bot image: ${lastLine(built.stderr)}`);
    return tag;
  })().finally(() => { building = null; });
  return building;
}

async function ensureNetwork(name: string, internal: boolean) {
  if ((await docker(['network', 'inspect', name])).code === 0) return;
  const made = await docker(['network', 'create', ...(internal ? ['--internal'] : []), '--label', 'hq.cli=1', name]);
  if (made.code !== 0 && !/already exists/i.test(made.stderr)) throw new Error(`Could not create network ${name}: ${lastLine(made.stderr)}`);
}

/** The gate: unprivileged, no secrets, on the egress network and joined to each bot's network as `gate`. */
async function ensureGate(tag: string) {
  const args = [
    '--restart', 'unless-stopped', '--init',
    '--network', EGRESS,
    '--add-host', 'host.docker.internal:host-gateway',
    '--user', `${SANDBOX.uid}:${SANDBOX.uid}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '256m', '--pids-limit', '256',
    '-e', `GATE_APP=host.docker.internal:${env.port}`,
    '-e', `GATE_APP_PORT=${SANDBOX.appPort}`,
    '-e', `GATE_PROXY_PORT=${SANDBOX.proxyPort}`,
    tag, 'node', '/opt/hq/gate.mjs',
  ];
  const spec = crypto.createHash('sha256').update(args.join('\0')).digest('hex').slice(0, 12);
  const info = await docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "hq.spec"}}', GATE]);
  const [running, had] = info.code === 0 ? info.stdout.toString().trim().split(' ') : [];
  if (info.code === 0 && had !== spec) await docker(['rm', '-f', GATE]);
  if (info.code !== 0 || had !== spec) {
    const run = await docker(['run', '-d', '--name', GATE, '--label', `hq.spec=${spec}`, '--label', 'hq.cli=1', ...args]);
    if (run.code !== 0) throw new Error(`Could not start the CLI gate: ${lastLine(run.stderr)}`);
  } else if (running !== 'true') {
    const started = await docker(['start', GATE]);
    if (started.code !== 0) throw new Error(`Could not start the CLI gate: ${lastLine(started.stderr)}`);
  }
}

async function joinGate(botId: string) {
  const net = botNetwork(botId);
  await ensureNetwork(net, true);
  const joined = await docker(['network', 'connect', '--alias', SANDBOX.gateAlias, net, GATE]);
  if (joined.code !== 0 && !/already exists|already attached|endpoint with name/i.test(joined.stderr)) {
    throw new Error(`Could not connect the CLI gate to ${net}: ${lastLine(joined.stderr)}`);
  }
}

let ready: { at: number; tag: string } | null = null;

/** Image, networks and gate for one bot's turn. Checked at most every 30 seconds, the bot's network every time. */
async function ensureFor(botId: string): Promise<string> {
  if (!ready || Date.now() - ready.at > 30_000 || ready.tag !== imageTag()) {
    const tag = await ensureImage();
    await ensureNetwork(EGRESS, false);
    await ensureGate(tag);
    ready = { at: Date.now(), tag };
  }
  await joinGate(botId);
  return ready.tag;
}

function chownTree(dir: string, uid: number) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (fs.statSync(p).uid !== uid) fs.chownSync(p, uid, uid);
    if (entry.isDirectory()) chownTree(p, uid);
  }
}

/** Runs each turn in its own container. Stopping the turn kills the container, so nothing it started lives on. */
export const sandboxRunner: CliRunner = {
  async prepare(adapter, opts) {
    if (!opts.botId) throw new Error('A sandboxed turn needs the bot id.');
    const image = await ensureFor(opts.botId);
    fs.mkdirSync(path.join(opts.home, 'claude'), { recursive: true });
    const name = turnContainerName(opts.botId);
    const plan = sandboxPlan(adapter, opts, {
      image,
      uid: process.getuid?.() ?? SANDBOX.uid,
      gid: process.getgid?.() ?? SANDBOX.uid,
      modelToken: placeholderToken(env.sessionSecret, opts.botId),
      name,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    if (plan.chownTo !== null) {
      // The server runs as root, the container as the image's user: the bot's files must be theirs.
      for (const f of plan.files) { fs.writeFileSync(f.path, f.content, { mode: 0o600 }); fs.chownSync(f.path, plan.chownTo, plan.chownTo); }
      fs.chownSync(opts.home, plan.chownTo, plan.chownTo);
      chownTree(opts.home, plan.chownTo);
    }
    return {
      bin: env.dockerBin,
      args: plan.args,
      // The docker client only needs to find its daemon; nothing of the server's secrets.
      env: Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'].filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])),
      files: plan.files,
      stdin: plan.stdin,
      // Killing the docker client alone would leave the container running.
      stop: () => { spawn(env.dockerBin, ['rm', '-f', name], { stdio: 'ignore' }).on('error', () => {}).unref(); },
    };
  },
};

const versions = { at: 0, version: null as string | null };

/** The CLI's version in the image, or null while the image is not built (asking starts the build). */
export function sandboxVersion(): string | null {
  if (Date.now() - versions.at < 60_000) return versions.version;
  let version: string | null = null;
  try {
    const r = spawnSync(env.dockerBin, ['image', 'inspect', '-f', '{{index .Config.Labels "hq.claude-version"}}', imageTag()], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) version = `${String(r.stdout).trim() || 'installed'} (Claude Code, in a container)`;
  } catch { /* docker missing */ }
  if (version === null) ensureImage().catch((e) => console.error('[cli]', e.message));
  versions.at = Date.now();
  versions.version = version;
  return version;
}

/** On server start: turns that were running when the server stopped are gone; so must their containers be. */
export async function removeStaleTurns(): Promise<void> {
  const list = await docker(['ps', '-aq', '--filter', 'label=hq.cli.turn']);
  const ids = list.stdout.toString().split('\n').map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
}

/** The bot is gone: its network goes too. */
export async function removeBotSandbox(botId: string): Promise<void> {
  const net = botNetwork(botId);
  await docker(['network', 'disconnect', '-f', net, GATE]);
  await docker(['network', 'rm', net]);
}
