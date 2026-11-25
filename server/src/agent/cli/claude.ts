import path from 'node:path';
import type { CliAdapter, CliEvent } from './adapter.js';

/**
 * Claude Code (`claude -p`), as observed on 2.1.325.
 *
 * The CLI is the one installed and signed in on this machine; the app holds no credentials for it.
 * Each turn is one process: the first starts a session with an id we choose, later ones resume it.
 */

/** Built-in tools a bot may use. What they may do without asking is decided by the CLI and the app's permission tool. */
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Server variables the CLI needs to run and to reach its own model credentials. Nothing else is passed on. */
const ENV_PASS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM', 'TZ',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
];

const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The usage and cost on a result line, if it has any. */
function usageOf(line: any): CliEvent[] {
  const u = line.usage;
  if (!u || typeof u !== 'object') return [];
  const models = line.modelUsage && typeof line.modelUsage === 'object' ? Object.keys(line.modelUsage) : [];
  const cost = typeof line.total_cost_usd === 'number' && Number.isFinite(line.total_cost_usd) ? line.total_cost_usd : null;
  return [{
    type: 'usage',
    model: models.length ? models.join('+') : null,
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    costUsd: cost,
  }];
}

export const claude: CliAdapter = {
  id: 'claude',
  name: 'Claude Code',
  bin: process.env.CLAUDE_BIN || 'claude',

  command(o) {
    // The token for the app's tools and the persona (the user's email, the bot's memory) stay out of
    // the command line; so does the prompt, which the CLI reads from stdin.
    const mcpFile = path.join(o.home, 'mcp.json');
    const systemFile = path.join(o.home, 'system.md');
    const files = [
      { path: mcpFile, content: JSON.stringify({ mcpServers: { hq: { type: 'http', url: o.mcp.url, headers: { Authorization: `Bearer ${o.mcp.token}` } } } }) },
      { path: systemFile, content: o.system },
    ];
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Nothing of the host user's own setup reaches a bot: no settings, hooks, plugins or memory files, and no MCP servers but ours.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--mcp-config', mcpFile,
      // Whatever the CLI would ask a person, it asks the app, which shows an approval card.
      '--permission-prompt-tool', `mcp__hq__${o.permissionTool}`,
      '--tools', TOOLS.join(','),
      // The app's tools carry their own approvals; reading the web needs none.
      '--allowedTools', ['mcp__hq', 'WebSearch', 'WebFetch'].join(','),
      // Every shell command and read goes to the app too, not only what the CLI deems risky: the
      // app's check decides (it lets reads through and asks about what the user's words do not cover).
      '--settings', JSON.stringify({ permissions: { ask: ['Bash', 'Read', 'Glob', 'Grep'] } }),
      '--append-system-prompt-file', systemFile,
      ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
    ];
    return { args, files, stdin: o.prompt };
  },

  environment(from) {
    const env: Record<string, string> = {};
    for (const k of ENV_PASS) if (from[k]) env[k] = from[k] as string;
    // An approval card may wait for the user for a long time; the tool call must outlast it.
    env.MCP_TOOL_TIMEOUT = String(30 * 60_000);
    return env;
  },

  parse(line): CliEvent[] {
    if (!line || typeof line !== 'object') return [];
    switch (line.type) {
      case 'system':
        return line.subtype === 'init' && typeof line.session_id === 'string' ? [{ type: 'session', id: line.session_id }] : [];

      case 'stream_event': {
        // A sub-agent's stream is not this bot talking.
        if (line.parent_tool_use_id) return [];
        const d = line.event?.type === 'content_block_delta' ? line.event.delta : null;
        if (d?.type === 'text_delta' && typeof d.text === 'string') return [{ type: 'delta', text: d.text }];
        if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') return [{ type: 'reasoning', text: d.thinking }];
        return [];
      }

      case 'assistant': {
        if (line.parent_tool_use_id) return [];
        const out: CliEvent[] = [];
        for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
          if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
          else if (b?.type === 'tool_use' && b.id) out.push({ type: 'tool', callId: String(b.id), name: String(b.name ?? ''), args: b.input });
        }
        return out;
      }

      case 'user': {
        const out: CliEvent[] = [];
        for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
          if (b?.type === 'tool_result' && b.tool_use_id) out.push({ type: 'tool-result', callId: String(b.tool_use_id), text: resultText(b.content), isError: !!b.is_error });
        }
        return out;
      }

      case 'result': {
        const used = usageOf(line);
        if (!line.is_error && line.subtype === 'success') return [...used, { type: 'done' }];
        const said = typeof line.result === 'string' && line.result.trim() ? line.result.trim() : String(line.subtype ?? 'the run failed').replace(/_/g, ' ');
        return [...used, { type: 'error', message: said.slice(0, 500) }];
      }
    }
    return [];
  },
};
