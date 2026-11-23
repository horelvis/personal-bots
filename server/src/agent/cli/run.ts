import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { CliAdapter, CliEvent, CliRunner, PreparedProcess, TurnOptions } from './adapter.js';

/**
 * Run one turn of a CLI engine and yield what it says, in order.
 *
 * Ends after the CLI's own result. A CLI that dies without one is an error carrying what it wrote
 * to stderr. Aborting stops the process and throws, like an aborted request to a Hermes engine.
 */
/** The CLI on this host, as the server's user. */
export const hostRunner: CliRunner = {
  async prepare(adapter, opts) {
    const { args, files, stdin } = adapter.command(opts);
    const env = {
      ...adapter.environment(process.env),
      // The bot's folder may sit inside a repository (ours, by default). Without this, read-only git
      // commands run from there would read that whole repository without asking.
      GIT_CEILING_DIRECTORIES: opts.home,
    };
    return { bin: adapter.bin, args, cwd: opts.cwd, env, files, stdin };
  },
};

export async function* runCli(adapter: CliAdapter, opts: TurnOptions, signal: AbortSignal, runner: CliRunner = hostRunner): AsyncGenerator<CliEvent> {
  if (signal.aborted) throw new Error('interrupted');
  const p: PreparedProcess = await runner.prepare(adapter, opts);
  if (signal.aborted) throw new Error('interrupted');
  for (const f of p.files) {
    fs.writeFileSync(f.path, f.content, { mode: 0o600 });
    fs.chmodSync(f.path, 0o600); // the mode above only applies to a new file
  }
  const { stdin } = p;
  const child = spawn(p.bin, p.args, { cwd: p.cwd, env: p.env, stdio: ['pipe', 'pipe', 'pipe'] });
  // The prompt goes in through stdin, then stdin closes so the CLI does not wait for more.
  child.stdin.on('error', () => {}); // the CLI may exit before reading it
  child.stdin.end(stdin);

  let stderr = '';
  child.stderr.on('data', (c) => { stderr = (stderr + String(c)).slice(-2000); });
  let spawnError: Error | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => { spawnError = e; resolve(null); });
    child.on('close', (code) => resolve(code));
  });
  let stopped = false;
  const stop = () => {
    if (!stopped) { stopped = true; try { p.stop?.(); } catch { /* best effort */ } }
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000).unref();
  };
  signal.addEventListener('abort', stop, { once: true });

  let finished = false;
  try {
    for await (const raw of readline.createInterface({ input: child.stdout })) {
      if (signal.aborted) break;
      let line: any;
      try { line = JSON.parse(raw); } catch { continue; } // not a JSON line: nothing for us
      for (const ev of adapter.parse(line)) {
        if (ev.type === 'done' || ev.type === 'error') finished = true;
        yield ev;
      }
    }
    const code = await exited;
    if (signal.aborted) throw new Error('interrupted');
    if (spawnError) {
      const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT';
      yield { type: 'error', message: missing ? `${adapter.name} is not installed on this machine (${p.bin} was not found).` : `${adapter.name} could not start: ${(spawnError as Error).message}` };
    } else if (!finished) {
      yield { type: 'error', message: stderr.trim().split('\n').pop()?.slice(0, 300) || `${adapter.name} stopped without an answer (exit code ${code}).` };
    }
  } finally {
    signal.removeEventListener('abort', stop);
    // The consumer gave up early (it threw, or the turn ended): do not leave the process behind.
    if (child.exitCode === null && child.signalCode === null) stop();
  }
}

const versions = new Map<string, { at: number; version: string | null }>();

/** The CLI's version line, or null when it is not installed. Asked at most once a minute. */
export function cliVersion(adapter: CliAdapter): string | null {
  const hit = versions.get(adapter.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.version;
  let version: string | null = null;
  try {
    const r = spawnSync(adapter.bin, ['--version'], { encoding: 'utf8', timeout: 8000, env: adapter.environment(process.env) });
    if (r.status === 0) version = String(r.stdout).trim().split('\n')[0].slice(0, 80) || 'installed';
  } catch { /* not there */ }
  versions.set(adapter.id, { at: Date.now(), version });
  return version;
}
