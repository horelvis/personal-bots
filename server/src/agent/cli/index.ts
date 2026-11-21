import type { CliAdapter } from './adapter.js';
import { claude } from './claude.js';

export type { CliAdapter, CliEvent, TurnOptions } from './adapter.js';
export { runCli, cliVersion } from './run.js';

/** Every CLI engine the app knows. Hermes is not one of them: it is a gateway, handled in engine.ts. */
export const CLI_ADAPTERS: CliAdapter[] = [claude];

/** The adapter for a value of bots.engine, or null when the bot runs on Hermes. */
export function cliAdapter(engine: unknown): CliAdapter | null {
  return CLI_ADAPTERS.find((a) => a.id === engine) ?? null;
}
