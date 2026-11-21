/**
 * A CLI engine: a coding-agent command line that runs one bot's turns as a child process.
 *
 * An adapter knows one CLI. It builds the command for a turn and maps the JSON lines the CLI prints
 * to the few events the loop understands. It keeps no state and starts nothing itself (see run.ts).
 * To add a CLI: write one file like claude.ts and list it in index.ts.
 */

export interface TurnOptions {
  /** The bot's private folder, beside its work folder: files only this bot's engine may read go here. */
  home: string;
  /** The bot's own folder; the CLI works there. */
  cwd: string;
  prompt: string;
  /** Persona, memory and how the app's tools fit in; sent on every turn. */
  system: string;
  /** The conversation on the CLI's side: started with this id, or resumed when `resume` is set. */
  sessionId: string;
  resume: boolean;
  model: string | null;
  effort: string | null;
  /** The app's MCP endpoint for this bot. */
  mcp: { url: string; token: string };
  /** The app tool that answers the CLI's permission prompts (name without the server prefix). */
  permissionTool: string;
}

export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  /** A finished piece of assistant text (the whole block, also when it was streamed as deltas). */
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string; name: string; args: any }
  | { type: 'tool-result'; callId: string; text: string; isError: boolean }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface CliAdapter {
  /** Stored in bots.engine. */
  id: string;
  /** Shown to the user. */
  name: string;
  /** The executable to run. */
  bin: string;
  /**
   * The command for one turn. Its arguments must hold nothing private: any process on the machine
   * can read a command line. The prompt goes to the CLI's stdin, and `files` (persona, credentials)
   * are written for the owner only before the CLI starts.
   */
  command(o: TurnOptions): { args: string[]; files: { path: string; content: string }[]; stdin: string };
  /** What the child process may see of the server's environment. */
  environment(from: Record<string, string | undefined>): Record<string, string>;
  /** One parsed JSON line of the CLI's output. */
  parse(line: any): CliEvent[];
}
