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

export const claude: CliAdapter = {
  id: 'claude',
  name: 'Claude Code',
  bin: process.env.CLAUDE_BIN || 'claude',

  command(o) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Nothing of the host user's own setup reaches a bot: no settings, hooks, plugins or memory files, and no MCP servers but ours.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify({ mcpServers: { hq: { type: 'http', url: o.mcp.url, headers: { Authorization: `Bearer ${o.mcp.token}` } } } }),
      // Whatever the CLI would ask a person, it asks the app, which shows an approval card.
      '--permission-prompt-tool', `mcp__hq__${o.permissionTool}`,
      '--tools', TOOLS.join(','),
      // The app's tools carry their own approvals; reading the web needs none.
      '--allowedTools', ['mcp__hq', 'WebSearch', 'WebFetch'].join(','),
      '--append-system-prompt', o.system,
      ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
      '--', o.prompt,
    ];
    return { args };
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
        if (!line.is_error && line.subtype === 'success') return [{ type: 'done' }];
        const said = typeof line.result === 'string' && line.result.trim() ? line.result.trim() : String(line.subtype ?? 'the run failed').replace(/_/g, ' ');
        return [{ type: 'error', message: said.slice(0, 500) }];
      }
    }
    return [];
  },
};
