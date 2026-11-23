import crypto from 'node:crypto';
import path from 'node:path';
import type { CliAdapter, TurnOptions } from './adapter.js';

/**
 * The `docker run` command for one CLI turn in a container (R8). Pure: no Docker, no environment.
 *
 * The container sees the bot's home at /hq (read-only), its work folder and the CLI's own files
 * (sessions) writable, and nothing else of the host. Its only network is the bot's own internal one,
 * whose only other member is the gate: the app (MCP), the model (through the server's proxy, which
 * adds the real token) and the public web all go through it. No credential of the host enters.
 */

export const SANDBOX = {
  /** Where the bot's home is mounted inside. */
  mount: '/hq',
  /** The image's unprivileged user, used when the server itself runs as root. */
  uid: 10001,
  networkPrefix: 'hq-cli-net-',
  gateAlias: 'gate',
  appPort: 8787,
  proxyPort: 3128,
  memory: '2g',
  cpus: '2',
  pids: '512',
};

export interface SandboxOptions {
  image: string;
  /** The server's user and group: the container runs as them, so the bot's files stay theirs. */
  uid: number;
  gid: number;
  /** The bot's placeholder model token (lib/model-proxy.ts). */
  modelToken: string;
  /** The turn's container name (turnContainerName). */
  name: string;
  tz: string;
}

export interface SandboxPlan {
  bin: 'docker';
  args: string[];
  /** Written on the host, in the bot's home, before the container starts. */
  files: { path: string; content: string }[];
  stdin: string;
  /** Owner to give the bot's files when the server runs as root (the container runs as SANDBOX.uid then). */
  chownTo: number | null;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');

/** A fresh, valid container name for one turn of a bot. */
export function turnContainerName(botId: string): string {
  return `hq-cli-${safe(botId)}-${crypto.randomBytes(4).toString('hex')}`;
}

export const botNetwork = (botId: string) => `${SANDBOX.networkPrefix}${safe(botId)}`;

export function sandboxPlan(adapter: CliAdapter, opts: TurnOptions, o: SandboxOptions): SandboxPlan {
  if (!opts.botId) throw new Error('A sandboxed turn needs the bot id.');
  const hostHome = opts.home;
  const gate = `http://${SANDBOX.gateAlias}`;
  // The adapter builds its command as if the bot's home were at /hq and the app behind the gate.
  const inner = adapter.command({
    ...opts,
    home: SANDBOX.mount,
    cwd: `${SANDBOX.mount}/work`,
    mcp: { url: `${gate}:${SANDBOX.appPort}/mcp/${opts.botId}`, token: opts.mcp.token },
  });
  const files = inner.files.map((f) => {
    if (!f.path.startsWith(`${SANDBOX.mount}/`)) throw new Error(`The CLI wants a file outside the bot's home: ${f.path}`);
    return { path: path.join(hostHome, f.path.slice(SANDBOX.mount.length + 1)), content: f.content };
  });
  const root = o.uid === 0;
  const user = root ? `${SANDBOX.uid}:${SANDBOX.uid}` : `${o.uid}:${o.gid}`;
  const proxy = `${gate}:${SANDBOX.proxyPort}`;
  const config = `${SANDBOX.mount}/claude`;
  const inside: Record<string, string> = {
    HOME: config,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `${gate}:${SANDBOX.appPort}/cli-model/${opts.botId}`,
    CLAUDE_CODE_OAUTH_TOKEN: o.modelToken,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: SANDBOX.gateAlias,
    no_proxy: SANDBOX.gateAlias,
    GIT_CEILING_DIRECTORIES: SANDBOX.mount,
    MCP_TOOL_TIMEOUT: String(30 * 60_000),
    TZ: o.tz,
    LANG: 'C.UTF-8',
  };
  const args = [
    'run', '--rm', '-i', '--init',
    '--name', o.name,
    '--label', `hq.cli.turn=${opts.botId}`,
    '--network', botNetwork(opts.botId),
    '--user', user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', SANDBOX.memory,
    '--cpus', SANDBOX.cpus,
    '--pids-limit', SANDBOX.pids,
    '--tmpfs', '/tmp',
    '-v', `${hostHome}:${SANDBOX.mount}:ro`,
    '-v', `${path.join(hostHome, 'work')}:${SANDBOX.mount}/work`,
    '-v', `${path.join(hostHome, 'claude')}:${config}`,
    '-w', `${SANDBOX.mount}/work`,
    ...Object.entries(inside).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    o.image,
    'claude',
    ...inner.args,
  ];
  return { bin: 'docker', args, files, stdin: inner.stdin, chownTo: root ? SANDBOX.uid : null };
}
