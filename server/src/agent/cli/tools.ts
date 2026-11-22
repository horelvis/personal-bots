import type { ActivityKind } from '../../types.js';

/**
 * What the app adds for bots on a CLI engine, kept free of the database so it can be tested alone:
 * how a CLI's built-in tools map to approval cards and to "what the bot is doing", and the two app
 * tools only these bots get (served by mcp.ts).
 */

/** Answers the CLI's permission prompts. The CLI calls it itself; the model never sees it. */
export const PERMISSION_TOOL = 'permission_prompt';
/** Saves a note to the bot's memory files (a Hermes agent has a memory tool of its own). */
export const MEMORY_TOOL = 'remember';

export const CLI_TOOL_DEFS = [
  {
    name: PERMISSION_TOOL,
    description: 'Asks the user whether a tool call may go ahead. Called by the agent runtime, not by the agent.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
  },
  {
    name: MEMORY_TOOL,
    description: 'Save one lasting note of your own, so you still know it in later conversations: something about your job, a rule you were given, or what you learned doing it (about "self"). Facts about the user go through remember_about_user instead. One short entry per call; do not save secrets or things that only matter today.',
    inputSchema: { type: 'object', properties: { about: { type: 'string', enum: ['self'] }, text: { type: 'string' } }, required: ['about', 'text'] },
  },
];

const OURS = /^mcp__hq__(.+)$/;

/** The most a card shows of a command or path. Longer ones are refused, never shown cut short. */
export const CARD_DETAIL_LIMIT = 2000;

export interface PermissionRule {
  /** What "Always allow" remembers. */
  key: string;
  title: string;
  /** What the card shows the user: the whole command or path. */
  detail?: string;
  /** The command or path does not fit on a card, so the user cannot see all of what they would approve. */
  tooLong?: true;
}

/** The card for a built-in tool call the CLI wants permission for. */
export function permissionRule(tool: string, input: any): PermissionRule {
  const rule = (key: string, title: string, shown: unknown): PermissionRule => {
    if (typeof shown !== 'string' || !shown.trim()) return { key, title, detail: undefined };
    return shown.length > CARD_DETAIL_LIMIT ? { key, title, tooLong: true } : { key, title, detail: shown };
  };
  switch (tool) {
    case 'Bash':
      return rule('cli_bash', 'Shell: run a command', input?.command);
    case 'Write':
      return rule('cli_write', 'Files: write a file', input?.file_path);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return rule('cli_edit', 'Files: edit a file', input?.file_path ?? input?.notebook_path);
    case 'Read':
    case 'Glob':
    case 'Grep':
      // Reading inside its own folder never reaches the prompt; this is a read somewhere else.
      return rule('cli_read', 'Files: read outside its folder', input?.file_path ?? input?.path ?? input?.pattern);
  }
  return { key: `cli_${tool.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, title: `${tool}: use this tool` };
}

/**
 * What to do with a permission request, given the user's saved choice for its key (policies.mode).
 * Anything not explicitly settled is asked; a request we cannot name is refused.
 */
export function permissionStep(tool: string, mode: string | undefined): 'allow' | 'ask' | 'deny' {
  if (!tool) return 'deny';
  // The app's own tools decide for themselves when they run (mcp.ts), with their own cards.
  if (OURS.test(tool)) return 'allow';
  if (mode === 'blocked') return 'deny';
  if (mode === 'always_allow') return 'allow';
  return 'ask';
}

/** The reply the CLI expects from its permission tool. */
export function permissionAnswer(behavior: 'allow' | 'deny', input: unknown, message = 'Not allowed.'): string {
  return JSON.stringify(behavior === 'allow' ? { behavior, updatedInput: input && typeof input === 'object' ? input : {} } : { behavior, message });
}

/** What to show while a CLI tool runs; null for the app's tools that already have a label. */
export function cliActivity(raw: string): { kind: ActivityKind; label: string; detail?: string } | null {
  if (OURS.exec(raw)?.[1] === MEMORY_TOOL) return { kind: 'remembering', label: 'Saving notes' };
  switch (raw) {
    case 'Bash': return { kind: 'running_commands', label: 'Running commands' };
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return { kind: 'drafting_file', label: 'Writing a file' };
    case 'Read':
    case 'Glob':
    case 'Grep': return { kind: 'working', label: 'Reading files' };
    case 'WebSearch': return { kind: 'searching_web', label: 'Searching the web' };
    case 'WebFetch': return { kind: 'reading_web', label: 'Reading a page' };
  }
  return null;
}
