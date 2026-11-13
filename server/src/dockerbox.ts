import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { DEFAULT_DISPLAY, displayFor, displayNumber, parseDisplayList, vncPortFor, type Screen } from './lib/screens.js';

/**
 * The local box (HQ_BOX=docker): one Linux container on this machine that stands in for the Orgo
 * computer. It runs under any Docker-compatible runtime (Colima, OrbStack, Docker Desktop). Each bot
 * gets its own X display in it; `hq-display` (server/box/docker/) starts the X server, window
 * manager, VNC server and DevTools forwarder of a display.
 *
 * Ports are published on 127.0.0.1 only: VNC on 5900+display, DevTools on 9200+display. The bots'
 * browser profiles and Library files live in a volume, so a rebuilt container keeps them.
 */

/** Displays the box can run, the default one first (the same four screens Orgo allows). */
export const BOX_DISPLAYS = [DEFAULT_DISPLAY, 100, 101, 102];

const IMAGE_DIR = fileURLToPath(new URL('../box/docker/', import.meta.url));
const first = BOX_DISPLAYS[0];
const last = BOX_DISPLAYS[BOX_DISPLAYS.length - 1];

interface Out { code: number; stdout: Buffer; stderr: string }

/** One docker CLI call. Never rejects: a missing binary or a timeout comes back as a non-zero code. */
function docker(args: string[], opts: { input?: Buffer; timeoutMs?: number } = {}): Promise<Out> {
  return new Promise((resolve) => {
    const child = spawn(env.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout: Buffer.alloc(0), stderr: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: Buffer.concat(out), stderr: timedOut ? 'timed out' : Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => { /* the command ended before reading its input */ });
    child.stdin.end(opts.input);
  });
}

/** The image is named after its sources, so editing them rebuilds it and replaces the container. */
function imageTag(): string {
  const h = crypto.createHash('sha256');
  for (const f of ['Dockerfile', 'hq-display']) h.update(`${f}\0`).update(fs.readFileSync(`${IMAGE_DIR}${f}`));
  return `${env.dockerContainer}:${h.digest('hex').slice(0, 12)}`;
}

/** VNC passwords are eight characters at most. Derived from SESSION_SECRET, so nothing new to store. */
const vncPassword = () => crypto.createHmac('sha256', env.sessionSecret).update('box-vnc').digest('hex').slice(0, 8);

const lastLine = (s: string) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

async function start(): Promise<void> {
  const name = env.dockerContainer;
  const tag = imageTag();
  const info = await docker(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', name]);
  if (info.code === 127) throw new Error(`The docker command was not found (${env.dockerBin}). Install a Docker-compatible runtime, for example Colima.`);
  if (info.code !== 0 && /cannot connect|failed to connect|is the docker daemon running/i.test(info.stderr)) {
    throw new Error('Docker is not running. Start it (for example: colima start) and try again.');
  }
  let state = info.code === 0 ? info.stdout.toString().trim().split(' ') : null;
  if (state && state[1] !== tag) {
    // Built from older sources: replace it. The volume keeps profiles and files.
    await docker(['rm', '-f', name]);
    state = null;
  }
  if (!state) {
    if ((await docker(['image', 'inspect', tag])).code !== 0) {
      console.log(`[box] building ${tag} (first run takes a few minutes)`);
      const built = await docker(['build', '-t', tag, IMAGE_DIR], { timeoutMs: 20 * 60_000 });
      if (built.code !== 0) throw new Error(`Could not build the box image: ${lastLine(built.stderr)}`);
    }
    const run = await docker([
      'run', '-d', '--name', name, '--init', '--shm-size=1g', '--restart', 'unless-stopped',
      '-e', `HQ_VNC_PASSWORD=${vncPassword()}`, '-e', `HQ_SCREEN_SIZE=${env.dockerScreenSize}`,
      // The clock on a bot's home screen should read like the one on this machine.
      '-e', `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}`,
      '-v', `${name}-data:/root/grokbot`,
      '-p', `127.0.0.1:${5900 + first}-${5900 + last}:${5900 + first}-${5900 + last}`,
      '-p', `127.0.0.1:${9200 + first}-${9200 + last}:${19200 + first}-${19200 + last}`,
      tag,
    ]);
    if (run.code !== 0) throw new Error(`Could not start the box: ${lastLine(run.stderr)}`);
  } else if (state[0] !== 'true') {
    const started = await docker(['start', name]);
    if (started.code !== 0) throw new Error(`Could not start the box: ${lastLine(started.stderr)}`);
  }
  for (let i = 0; i < 40; i++) {
    if ((await listScreens()).some((s) => s.default)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The box started but its first screen did not come up.');
}

let starting: Promise<void> | null = null;
let checkedAt = 0;

async function exec(command: string, timeoutSec: number, screenId?: string | null, input?: Buffer): Promise<Out> {
  return docker(['exec', '-i', '-e', `DISPLAY=${displayFor(screenId)}`, env.dockerContainer, 'bash', '-c', command], { timeoutMs: timeoutSec * 1000, input });
}

async function listScreens(): Promise<Screen[]> {
  const r = await docker(['exec', env.dockerContainer, 'hq-display', 'list'], { timeoutMs: 15_000 });
  return r.code === 0 ? parseDisplayList(r.stdout.toString()) : [];
}

export const dockerBox = {
  /** Make sure the container runs (building the image the first time). Cheap when it was checked recently. */
  ensure(): Promise<void> {
    if (Date.now() - checkedAt < 30_000) return Promise.resolve();
    if (!starting) {
      starting = start().then(() => { checkedAt = Date.now(); }).finally(() => { starting = null; });
    }
    return starting;
  },

  /** Whether the container is up right now, without starting anything. */
  async running(): Promise<boolean> {
    const r = await docker(['inspect', '-f', '{{.State.Running}}', env.dockerContainer], { timeoutMs: 10_000 });
    return r.code === 0 && r.stdout.toString().trim() === 'true';
  },

  async bash(command: string, timeoutSec: number, screenId?: string | null): Promise<{ output: string; exit_code: number }> {
    const r = await exec(command, timeoutSec, screenId);
    return { output: `${r.stdout.toString('utf8')}${r.stderr}`, exit_code: r.code };
  },

  async writeFile(file: string, content: Buffer, mode: string): Promise<void> {
    // The path and mode travel as arguments, so nothing in them is read as shell.
    const r = await docker(
      ['exec', '-i', env.dockerContainer, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"', 'sh', file, mode],
      { input: content, timeoutMs: 60_000 },
    );
    if (r.code !== 0) throw new Error(`could not write ${file}: ${lastLine(r.stderr)}`);
  },

  async readFile(file: string): Promise<Buffer | null> {
    const r = await docker(['exec', env.dockerContainer, 'cat', '--', file], { timeoutMs: 60_000 });
    return r.code === 0 ? r.stdout : null;
  },

  listScreens,

  async getScreen(screenId: string): Promise<Screen> {
    const s = (await listScreens()).find((x) => x.id === screenId);
    if (!s) throw new Error(`screen ${screenId} is not running`);
    return s;
  },

  /** Start the next free display. */
  async createScreen(): Promise<Screen> {
    const used = new Set((await listScreens()).map((s) => displayNumber(s.id)));
    const n = BOX_DISPLAYS.find((d) => d !== DEFAULT_DISPLAY && !used.has(d));
    if (n === undefined) throw new Error(`Every screen in the box is in use (${BOX_DISPLAYS.length} at most).`);
    const r = await docker(['exec', env.dockerContainer, 'hq-display', 'start', String(n)], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`could not start display ${n}: ${lastLine(r.stderr || r.stdout.toString())}`);
    const s = (await listScreens()).find((x) => displayNumber(x.id) === n);
    if (!s) throw new Error(`display ${n} did not come up`);
    return s;
  },

  /** A JPEG of the whole screen. */
  async screenshot(screenId: string): Promise<Buffer> {
    const r = await exec('maim -f jpg -m 8', 20, screenId);
    if (r.code !== 0 || !r.stdout.length) throw new Error(`screenshot failed: ${lastLine(r.stderr)}`);
    return r.stdout;
  },

  /** Where the viewer relay finds a screen's VNC server. */
  vnc(screenId: string): { host: string; port: number; password: string } {
    return { host: '127.0.0.1', port: vncPortFor(screenId), password: vncPassword() };
  },
};
