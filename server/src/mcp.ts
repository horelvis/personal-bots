import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { appendRow, emitBot, getBotRow } from './store.js';
import { connectedServices } from './oauth/connections.js';
import { composioTools } from './composio.js';
import { cliHome, mcpToken, primaryBotId } from './engine.js';
import { askBot, claimToolRow, enqueueBotMessage, markSilent, noteToolOutcome, requestApproval, toolRowByCallId, turnDepth } from './agent/loop.js';
import { policyFor, runComposioTool, toolMap, TOOLS, type ToolCtx } from './agent/tools.js';
import { cliAdapter } from './agent/cli/index.js';
import { CLI_TOOL_DEFS, MEMORY_TOOL, PERMISSION_TOOL, actionKind, permissionAnswer, permissionRule, permissionStep } from './agent/cli/tools.js';
import { checkAction, unattended } from './trust.js';
import type { TrustAction } from './lib/trust-check.js';
import { addMemory } from './engine-memory.js';
import { toolOutput } from './lib/untrusted.js';
import { db } from './db.js';

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *   POST /mcp/primary     the primary engine, whichever bot it is bound to (so that agent's config
 *                         can be written before the bot exists)
 *
 * Every call is stateless: the URL says which bot is calling. Besides the app's own tools the list
 * carries the user's Composio tools, so connected apps (and the approvals around them) work the
 * same for every engine.
 *
 * A bot on a CLI engine (Claude Code) gets two more tools: the one its CLI asks for permission
 * through, which turns the CLI's own prompts into approval cards, and one to save memory notes.
 */

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. `botId` is null for /mcp/primary before a bot is bound to it. */
function caller(slug: string, auth: string | undefined): { botId: string | null } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  if (slug === 'primary') return { botId: primaryBotId() };
  return getBotRow(slug) ? { botId: slug } : null;
}

async function listTools(botId: string | null) {
  const own = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  const bot = botId ? getBotRow(botId) : null;
  if (!bot) return own;
  if (cliAdapter(bot.engine)) own.push(...CLI_TOOL_DEFS);
  const apps = (await composioTools(bot.user_id))
    .filter((t: any) => t?.type === 'function' && typeof t.name === 'string' && !toolMap.has(t.name))
    .map((t: any) => ({ name: t.name as string, description: String(t.description ?? ''), inputSchema: t.parameters ?? { type: 'object', properties: {} } }));
  return [...own, ...apps];
}

/** Whether a CLI file read (Read, Glob, Grep) stays inside the bot's own folder. */
function readsInsideFolder(botId: string, input: any): boolean {
  const work = path.resolve(cliHome(botId).work);
  const wanted = [input?.file_path, input?.path, input?.notebook_path, input?.pattern].filter((p) => typeof p === 'string' && p.trim());
  return wanted.every((p: string) => {
    const abs = path.resolve(work, p.replace(/^~(?=\/|$)/, os.homedir()));
    return abs === work || abs.startsWith(work + path.sep);
  });
}

const UNATTENDED = "This needs the user's approval, and this routine runs while nobody is watching, so it was not done. Say in your report what you would have done, so the user can do it or ask for it.";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The action check (R6) in front of an approval card. The user's own words may cover the action:
 * then it runs without a card. Otherwise the user gets the card, with the reason; in a routine's
 * turn, which nobody watches, the action is not done and the user is told in the chat instead.
 */
async function gate(
  who: { userId: string; botId: string; rowSeq: number | null },
  action: TrustAction,
  card: { key: string; toolkit?: string; title: string; detail?: string },
  args: any,
): Promise<'allow' | 'deny' | 'skip' | 'unattended'> {
  const { userId, botId, rowSeq } = who;
  const verdict = await checkAction(userId, botId, action);
  if (verdict.run) {
    if (verdict.source !== 'read') noteToolOutcome(botId, rowSeq, { status: 'running', summary: `Your words: “${clip(verdict.because, 80)}”` });
    return 'allow';
  }
  if (unattended(botId)) {
    noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Needs your approval' });
    appendRow(botId, 'notice', { type: 'notice', tone: 'info', text: `A routine wanted to ${card.title.split(': ')[1] ?? card.title} and needs your approval, so it was not done.${card.detail ? `\n${clip(card.detail, 600)}` : ''}` });
    emitBot(botId);
    return 'unattended';
  }
  const answer = await requestApproval({ userId, botId }, { ...card, why: verdict.reason }, args, rowSeq);
  return answer === 'allow' ? 'allow' : answer === 'deny' ? 'deny' : 'skip';
}

/**
 * A CLI engine asks whether one of its built-in tool calls (a shell command, a file write, a read
 * outside the bot's folder) may go ahead. The user's saved choice decides; without one they get the
 * same approval card as for a connected app. Anything that goes wrong is a refusal, never a pass.
 */
async function answerPermission(userId: string, botId: string, args: any): Promise<CallResult> {
  const input = args?.input;
  try {
    const tool = typeof args?.tool_name === 'string' ? args.tool_name : '';
    const rule = permissionRule(tool, input);
    const mode = (db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, rule.key) as any)?.mode as string | undefined;
    const step = permissionStep(tool, mode);
    if (step === 'allow') return text(permissionAnswer('allow', input));
    const rowSeq = await toolRowByCallId(botId, typeof args?.tool_use_id === 'string' ? args.tool_use_id : '');
    if (step === 'deny') {
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
      return text(permissionAnswer('deny', input, DECLINED));
    }
    if (rule.tooLong) {
      // The user would approve something they cannot read in full.
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Too long to show for approval' });
      return text(permissionAnswer('deny', input, 'This is too long to show the user for approval, so it was not run. Do it in shorter steps (for a long script, write it to a file first, then run the file).'));
    }
    const kind = actionKind(tool);
    const answer = await gate({ userId, botId, rowSeq }, { tool, title: rule.title, kind, args: input ?? {}, ...(kind === 'read' ? { insideFolder: readsInsideFolder(botId, input) } : {}) }, rule, input ?? {});
    if (answer === 'allow') return text(permissionAnswer('allow', input));
    return text(permissionAnswer('deny', input, answer === 'deny' ? DECLINED : answer === 'unattended' ? UNATTENDED : SKIPPED));
  } catch (e: any) {
    console.error('[mcp] permission check failed', botId, e?.message ?? e);
    return text(permissionAnswer('deny', input, 'The app could not check this action, so it was not allowed.'));
  }
}

async function callTool(botId: string | null, rawName: string, args: any): Promise<CallResult> {
  const bot = botId ? getBotRow(botId) : null;
  if (!botId || !bot) return text('The team app has no bot for this agent yet. Ask the user to open the app once, then try again.', true);
  const userId: string = bot.user_id;
  if (rawName === PERMISSION_TOOL) {
    // Only a CLI engine has prompts to answer; for any other caller this tool does not exist.
    if (!cliAdapter(bot.engine)) return text(permissionAnswer('deny', args?.input, 'Not allowed.'), true);
    return answerPermission(userId, botId, args);
  }
  const name = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase()) ?? rawName;
  const rowSeq = await claimToolRow(botId, name);
  const ctx: ToolCtx = { userId, botId, enqueueBotMessage, askBot, depth: turnDepth(botId) };
  try {
    const own = toolMap.get(name);
    const needs = own?.approval?.needs;
    // No point asking the user to approve what cannot run: without its connection the tool just says so.
    const runnable = !needs || connectedServices(userId, needs.provider).includes(needs.service);
    if (own?.approval && runnable) {
      // One of our tools that sends or changes something for the user: it waits for the same card.
      const pol = policyFor(userId, name, args);
      if (pol.decision === 'block') {
        noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
        return text(DECLINED);
      }
      if (pol.decision === 'ask') {
        // The card must say what will happen. A description that fails falls back to the plain arguments.
        const detail = own.approval.describe ? await Promise.resolve(own.approval.describe(args, ctx)).catch(() => undefined) : undefined;
        const answer = await gate({ userId, botId, rowSeq }, { tool: name, title: pol.title, kind: 'change', args }, { ...pol, detail }, args);
        if (answer !== 'allow') return text(answer === 'deny' ? DECLINED : answer === 'unattended' ? UNATTENDED : SKIPPED);
      }
    }
    if (name === MEMORY_TOOL && cliAdapter(bot.engine) && args?.about === 'self') {
      // A note of the bot's own is a change to its memory (R6): checked like any other change.
      const answer = await gate({ userId, botId, rowSeq }, { tool: name, title: 'Memory: save a note', kind: 'change', args }, { key: 'memory_note', title: 'Memory: save a note', detail: String(args?.text ?? '').slice(0, 1500) }, args);
      if (answer !== 'allow') return text(answer === 'deny' ? DECLINED : answer === 'unattended' ? UNATTENDED : SKIPPED);
    }
    if (name === MEMORY_TOOL && cliAdapter(bot.engine)) {
      // Facts about the user go through remember_about_user, which checks the user said them.
      if (args?.about === 'user') return text('Facts about the user are saved with remember_about_user, with the user\'s own words as quote. remember keeps your own notes (about "self").', true);
      if (args?.about !== 'self' || typeof args?.text !== 'string' || !args.text.trim()) return text('Give about "self" and the text to remember.', true);
      const added = addMemory(botId, 'm', args.text);
      noteToolOutcome(botId, rowSeq, { status: 'done', summary: added ? 'Saved' : 'Already known' });
      return text(added ? 'Saved to your memory.' : 'That was already in your memory.');
    }
    if (own) {
      const r = await own.impl(args, ctx);
      if (r.endTurn) markSilent(botId);
      noteToolOutcome(botId, rowSeq, { status: 'done', summary: r.summary });
      return text(toolOutput(r));
    }

    const pol = policyFor(userId, name, args);
    if (pol.decision === 'block') {
      noteToolOutcome(botId, rowSeq, { status: 'denied', summary: 'Not allowed' });
      return text(DECLINED);
    }
    if (pol.decision === 'ask') {
      const answer = await gate({ userId, botId, rowSeq }, { tool: name, title: pol.title, kind: 'change', args }, pol, args);
      if (answer !== 'allow') return text(answer === 'deny' ? DECLINED : answer === 'unattended' ? UNATTENDED : SKIPPED);
    }
    const r = await runComposioTool(ctx, name, args);
    noteToolOutcome(botId, rowSeq, { status: r.summary === 'failed' ? 'error' : 'done', summary: r.summary === 'failed' ? 'Failed' : undefined });
    return text(toolOutput(r));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    noteToolOutcome(botId, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    return text(`Tool error: ${msg}`, true);
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: any, botId: string | null): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A response to something we never asked; nothing to do with it.
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hq', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: connected apps, files for the user, tasks, routines, other agents on the team.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: await listTools(botId) } };
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Missing tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      return { jsonrpc: '2.0', id, result: await callTool(botId, name, args) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpApi = new Hono();

mcpApi.post('/:bot', async (c) => {
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(body, who.botId);
  return answer ? c.json(answer) : c.body(null, 202);
});

// No server-to-client stream and no sessions to end.
mcpApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'POST' }));
