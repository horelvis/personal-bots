import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, emitBot, getBotRow, getLive, getRow, setLive, updateRow } from '../store.js';
import type { ActivityKind, MessageBody, ToolCallBody } from '../types.js';
import { toolkitInfo } from '../composio.js';
import { screenForWork } from '../computer.js';
import { cliHome, cliSession, engineFor, forgetCliSession, mcpToken, saveCliSession, waitForEngine } from '../engine.js';
import { env } from '../env.js';
import { instructionsFor } from './prompt.js';
import { activityFor, appToolName, humanizeSlug, policyFor } from './tools.js';
import { cliAdapter, runCli, type CliAdapter } from './cli/index.js';
import { PERMISSION_TOOL, alwaysAllowOffered, cliActivity } from './cli/tools.js';
import { afterAnswer, createAsks, type Answer } from './asks.js';
import { beginWithRetry, createTurnStore, shareWait } from './turn-store.js';

/**
 * A turn: one message handed to the bot's engine and streamed back into the conversation.
 *
 * The engine (a Hermes gateway, or a CLI such as Claude Code run as a child process) owns the agent
 * loop, the history and the tools. This file only
 *  - queues turns so a bot handles one at a time,
 *  - posts the trigger to the engine's /v1/responses endpoint and turns the event stream into
 *    rows (assistant messages, tool calls) and live state (what the bot is doing right now),
 *  - keeps the bookkeeping the app's own tools need while a turn runs (see mcp.ts): which tool-call
 *    row a call belongs to, and approvals the user has to answer before a call goes ahead.
 */

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number; /** Set when the sender is waiting for the reply (ask_bot). */ askId?: string }
  | { type: 'system'; text: string };

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

// Every queued turn is kept in the database until it ends, so a stop neither loses nor repeats it.
const turnStore = createTurnStore(db);
// After a restart, a bot's turns wait for its engine once, not once each.
const engineAfterRestart = shareWait((botId) => {
  setLive(botId, { isRunning: true, activity: { kind: 'working', since: now() }, caption: 'Waiting for its agent to come back after a restart' });
  return waitForEngine(botId);
});

/**
 * `stored` is the turn's row when it is already in the database: a turn picked up after a restart,
 * which first waits (a while) for its engine, since the gateway may still be coming up.
 */
export function enqueue(botId: string, trigger: Trigger, stored?: number) {
  // A new message from the user supersedes whatever is waiting for their approval.
  if (trigger.type === 'user') expireApprovals(botId);
  const id = stored ?? turnStore.add(botId, trigger);
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      // Still 'queued' while it waits: nothing has been sent yet, so a stop here may run it again.
      if (stored !== undefined && !(await engineAfterRestart(botId))) console.warn(`[agent] ${botId}: its engine is still not answering; running the turn picked up after the restart anyway`);
      // From here on the turn counts as started: if the server stops now, it is reported, not run again.
      if ((await beginWithRetry(turnStore, id)) === 'later') {
        // It stays queued, so the next start of the server runs it once. Not asked to be sent again:
        // that copy and this one would both run.
        try { appendRow(botId, 'notice', { type: 'notice', text: 'This could not be started because the app could not record it. It will run when the server next starts; no need to send it again.', tone: 'error' }); emitBot(botId); } catch { /* the database is the problem; the log says so */ }
        // Nothing runs: the bot must not stay shown as busy (the wait after a restart marked it so).
        // An approval card still waiting for the user keeps its "waiting for you" state, as at the end of a turn.
        try { setLive(botId, getLive(botId).awaiting ? { isRunning: false, caption: null } : { isRunning: false, activity: null, caption: null, startedAt: null }); } catch { /* the bot is gone */ }
        return;
      }
      try { await runTurn(botId, trigger); } finally { turnStore.end(id); }
    })
    .catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

/**
 * On server start: deal with the turns the last stop cut off. A turn that was running is closed in
 * its chat as interrupted and is not run again; the turns that were waiting run, in their order.
 * Call it once, before anything else can queue a turn.
 */
export function recoverTurns() {
  const plan = turnStore.takeRecovery();
  for (const t of plan.interrupted) {
    // The chat is closed and the turn forgotten together; if that fails, the next start tries again.
    if (turnStore.closeInterrupted(t.id, () => closeInterruptedTurn(t.botId))) {
      try { emitBot(t.botId); } catch { /* the bot is gone */ }
    }
  }
  for (const t of plan.resume) {
    if (getBotRow(t.botId)) enqueue(t.botId, t.trigger, t.id);
    else turnStore.forget(t.id);
  }
  if (plan.interrupted.length || plan.resume.length) console.log(`[agent] after the restart: ${plan.interrupted.length} turn(s) interrupted, ${plan.resume.length} queued turn(s) picked up`);
}

/** Close what a cut-off turn left open in the bot's chat, and say what happened. */
function closeInterruptedTurn(botId: string) {
  const bot = getBotRow(botId);
  if (!bot) return;
  const open = db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND generation=? AND kind IN ('tool-call','message') ORDER BY seq DESC LIMIT 200").all(botId, bot.generation) as { seq: number; body: string }[];
  for (const r of open) {
    let b: any;
    try { b = JSON.parse(r.body); } catch { continue; }
    if (b?.type === 'tool-call' && (b.status === 'running' || b.status === 'awaiting-approval')) updateRow(botId, r.seq, { ...b, status: 'error', summary: 'Interrupted' });
    else if (b?.type === 'message' && b.streaming) updateRow(botId, r.seq, { ...b, streaming: false });
  }
  appendRow(botId, 'notice', { type: 'notice', text: 'Interrupted: the server restarted while this was running. It was not run again.', tone: 'info' });
}

export function interrupt(botId: string) {
  expireApprovals(botId);
  aborts.get(botId)?.abort();
}

/** Run a job in the bot's serial queue, after any running turn. */
export function runInBotQueue<T>(botId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(job);
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export const isBotBusy = (botId: string) => queues.has(botId);

export function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number, askId?: string) {
  const from = getBotRow(fromBotId);
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: fromBotId, name: from.name } });
  enqueue(toBotId, { type: 'bot', fromBotId, fromName: from.name, text, depth, ...(askId ? { askId } : {}) });
}

// ---------- one bot waiting for another's answer ----------

// Past the limit (ASK_BOT_WAIT_SECONDS, 9 minutes by default) the answer arrives later as a message.
const asks = createAsks(env.askBotWaitMs);

/**
 * Put a question in another bot's chat and wait for the reply it writes there. `circle` means the
 * other bot is itself waiting for this one, so the question was not sent.
 */
export function askBot(fromBotId: string, toBotId: string, text: string, depth: number): Promise<Answer | { status: 'circle' }> {
  return asks.ask(fromBotId, toBotId, (id) => enqueueBotMessage(fromBotId, toBotId, text, depth, id));
}

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot':
      if (t.askId) return `[Question from ${t.fromName}, another Bot on the team. They are waiting for your answer right now: write it here as your reply, plainly and complete. Do not use send_to_bot or ask_bot to answer them.]\n${t.text}`;
      return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

// ---------- the running turn, as the app's tools see it ----------

interface ToolRef { seq: number; callId: string; name: string; claimed: boolean; done: boolean }
interface Outcome { status?: ToolCallBody['status']; summary?: string }

interface Turn {
  botId: string;
  userId: string;
  /** How many bot-to-bot hops led here (send_to_bot stops a ping-pong at 3). */
  depth: number;
  /** A tool ended the conversation for now (asked the user, stayed silent): drop any closing text. */
  silent: boolean;
  tools: ToolRef[];
  /** What an app tool said about its own call; beats what we would guess from the raw output. */
  outcomes: Map<number, Outcome>;
  /** A routine started the turn: nobody is watching it. */
  unattended: boolean;
  /**
   * The routine's own instruction, as stored, when it was set through the action check. Never the
   * event that fired it (an email, say), which the turn's prompt also carries.
   */
  routine?: string;
}

const turns = new Map<string, Turn>();

export const turnDepth = (botId: string) => turns.get(botId)?.depth ?? 0;

/** The authorized instruction of the routine whose turn is running for this bot, if a routine started it. */
export const turnRoutine = (botId: string) => turns.get(botId)?.routine;

/** Whether a routine started the turn running for this bot. */
export const turnUnattended = (botId: string) => turns.get(botId)?.unattended ?? false;

export function markSilent(botId: string) {
  const t = turns.get(botId);
  if (t) t.silent = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An app tool was called through MCP: find the tool-call row the event stream made for it.
 * The stream announces a call just before the engine runs it, so wait a moment for the row.
 * Returns null when the call did not come from a turn started here (e.g. the agent used the tool
 * while talking to its owner somewhere else).
 */
export async function claimToolRow(botId: string, name: string): Promise<number | null> {
  const deadline = Date.now() + 600;
  for (;;) {
    const t = turns.get(botId);
    if (!t) return null;
    const ref = t.tools.find((r) => !r.claimed && !r.done && r.name === name);
    if (ref) { ref.claimed = true; return ref.seq; }
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

/**
 * The tool-call row of a call the engine names by id (a CLI asking permission for it). The stream
 * announces the call just before the engine asks, so wait a moment for the row.
 */
export async function toolRowByCallId(botId: string, callId: string): Promise<number | null> {
  if (!callId) return null;
  const deadline = Date.now() + 1500;
  for (;;) {
    const t = turns.get(botId);
    if (!t) return null;
    const ref = t.tools.find((r) => r.callId === callId);
    if (ref) return ref.seq;
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

export function noteToolOutcome(botId: string, seq: number | null, outcome: Outcome) {
  if (seq === null) return;
  turns.get(botId)?.outcomes.set(seq, outcome);
  patchToolRow(botId, seq, outcome);
}

function patchToolRow(botId: string, seq: number, patch: Partial<ToolCallBody>) {
  const row = getRow(botId, seq);
  if (row && row.body.type === 'tool-call') updateRow(botId, seq, { ...row.body, ...patch });
}

// ---------- approvals ----------

export type ApprovalDecision = 'allow' | 'deny' | 'expired';

/** Longest a tool call waits for the user. Kept under the engines' 30 minute tool timeout. */
const APPROVAL_WAIT_MS = 25 * 60_000;

const waiters = new Map<string, { botId: string; resolve: (d: ApprovalDecision) => void }>();

function setApprovalCard(botId: string, rowSeq: number, approvalId: string, status: string) {
  const card = getRow(botId, rowSeq);
  if (card && card.body.type === 'card' && card.body.card === 'approval' && card.body.approvalId === approvalId) {
    updateRow(botId, rowSeq, { ...card.body, status } as any);
  }
}

const pendingApprovals = (botId: string) => db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[];

/** Put an approval card in the conversation and wait for the user's answer. */
export async function requestApproval(
  who: { userId: string; botId: string },
  pol: { key: string; toolkit?: string; title: string; detail?: string; why?: string },
  args: any,
  rowSeq: number | null,
): Promise<ApprovalDecision> {
  const { userId, botId } = who;
  const approvalId = newId('apr');
  const tk = pol.toolkit ? await toolkitInfo(pol.toolkit).catch(() => undefined) : undefined;
  const card = appendRow(botId, 'card', {
    type: 'card', card: 'approval', approvalId, title: `Allow ${getBotRow(botId).name} to ${pol.title.split(': ')[1] ?? pol.title}?`,
    detail: [pol.detail ?? describeArgs(args), pol.why ? `Why you are asked: ${pol.why}` : ''].filter(Boolean).join('\n\n'), tool: pol.key, toolkit: pol.toolkit, toolkitName: tk?.name, logo: tk?.logo, args, status: 'pending',
  });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, '', pol.key, 'pending', now());
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
  if (rowSeq !== null) patchToolRow(botId, rowSeq, { status: 'awaiting-approval' });
  setLive(botId, { isRunning: false, activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: humanizeSlug(pol.key), since: now() } });
  hub.emit(userId, { type: 'tasks', botId });
  emitBot(botId);

  let timer: NodeJS.Timeout | undefined;
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approvalId, { botId, resolve });
    timer = setTimeout(() => expireApproval(approvalId), APPROVAL_WAIT_MS);
  });
  clearTimeout(timer);
  waiters.delete(approvalId);

  if (rowSeq !== null) {
    if (decision === 'allow') patchToolRow(botId, rowSeq, { status: 'running' });
    else noteToolOutcome(botId, rowSeq, { status: 'denied', summary: decision === 'deny' ? 'Not allowed' : 'Skipped' });
  }
  if (!pendingApprovals(botId).length) {
    if (turns.has(botId)) setLive(botId, { isRunning: true, activity: { kind: decision === 'allow' ? 'connecting_service' : 'thinking', detail: decision === 'allow' ? tk?.name : undefined, since: now() }, awaiting: null });
    else setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
  }
  hub.emit(userId, { type: 'tasks', botId });
  return decision;
}

function expireApproval(approvalId: string) {
  const ap = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
  if (ap?.status === 'pending') {
    db.prepare("UPDATE approvals SET status='expired', resolved_at=? WHERE id=?").run(now(), approvalId);
    setApprovalCard(ap.bot_id, ap.row_seq, approvalId, 'expired');
  }
  waiters.get(approvalId)?.resolve('expired');
}

export function expireApprovals(botId: string) {
  for (const ap of pendingApprovals(botId)) expireApproval(ap.id);
}

/** After a restart nothing is waiting on old approval cards any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE status='pending'").all() as any[]) expireApproval(ap.id);
}

/** Resolve an approval card from the UI. */
export function resolveApproval(userId: string, approvalId: string, decision: 'allow' | 'always' | 'deny') {
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(approvalId) as any;
  if (!ap || ap.user_id !== userId) throw new Error('not found');
  if (ap.status !== 'pending') return;
  const waiter = waiters.get(approvalId);
  if (!waiter) return expireApproval(approvalId);
  // Shell commands and reads are never allowed for good (R6): "always" counts as this once.
  if (decision === 'always' && !alwaysAllowOffered(ap.tool)) decision = 'allow';
  const status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), approvalId);
  if (decision === 'always') db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, ap.tool);
  setApprovalCard(ap.bot_id, ap.row_seq, approvalId, status);
  waiter.resolve(decision === 'deny' ? 'deny' : 'allow');
}

function describeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  const inner = Array.isArray(args.tools) ? args.tools.map((t: any) => t.arguments ?? t.args ?? t) : [args];
  const flat = inner.map((a: any) => Object.entries(a ?? {}).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 6).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join('\n'));
  return flat.join('\n\n').slice(0, 1200);
}

// ---------- the engine's event stream ----------

interface StreamEvent { type: string; data: any }

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue; // a keepalive comment
      const raw = data.join('\n');
      if (raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        yield { type: event || json?.type || '', data: json };
      } catch { /* not ours to understand */ }
    }
  }
}

async function failureText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m;
  } catch { /* plain text */ }
  if (res.status === 401 || res.status === 403) return 'the engine did not accept our key';
  return raw.slice(0, 300) || `the engine answered ${res.status}`;
}

/** What a tool's raw result says about how it went. */
function readOutcome(item: any): Outcome {
  const text = Array.isArray(item?.output) ? item.output.map((p: any) => p?.text ?? '').join('') : String(item?.output ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return { status: 'error', summary: String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 200) };
      if (typeof j.exit_code === 'number' && j.exit_code !== 0) return { status: 'error', summary: `Exit code ${j.exit_code}` };
      if (j.success === false) return { status: 'error', summary: String(j.message ?? 'Failed').slice(0, 200) };
    }
  } catch { /* not JSON */ }
  if (/^(tool )?error\b/i.test(text.trim())) return { status: 'error', summary: text.trim().slice(0, 200) };
  return { status: 'done' };
}

/** A short line for the "thinking" chip out of the model's running reasoning. */
function captionFrom(reasoning: string): string | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) return titles[titles.length - 1][1].trim();
  const para = reasoning.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  if (!para) return null;
  const sentence = para.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  if (sentence.length < 4) return null;
  return sentence.length > 84 ? `${sentence.slice(0, 81).trimEnd()}…` : sentence;
}

// ---------- the turn ----------

/** Hermes' own tool lookup (it loads rarely used tools on demand). */
const TOOLBOX = new Set(['tool_search', 'tool_describe']);

/** A routine's stored instruction, if it was set through the action check; otherwise nothing counts as the user's words. */
function authorizedInstruction(routineId: string): string | undefined {
  const r = db.prepare('SELECT prompt, authorized FROM routines WHERE id=?').get(routineId) as any;
  return r?.authorized ? String(r.prompt) : undefined;
}

async function runTurn(botId: string, trigger: Trigger) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') {
    // The bot was removed while this turn sat in its queue: whoever asked it is told there is no answer.
    if (trigger.type === 'bot' && trigger.askId) asks.settle(trigger.askId, null);
    return;
  }
  const userId: string = bot.user_id;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const turn: Turn = { botId, userId, depth: trigger.type === 'bot' ? trigger.depth : 0, silent: false, tools: [], outcomes: new Map(), unattended: trigger.type === 'routine', ...(trigger.type === 'routine' ? { routine: authorizedInstruction(trigger.routineId) } : {}) };
  turns.set(botId, turn);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now(), caption: null, steps: 0 });

  // The assistant message being written right now.
  let msgSeq: number | null = null;
  let text = '';
  let lastFlush = 0;
  let wroteText = false;
  const flush = (streaming: boolean) => {
    const b: MessageBody = { type: 'message', role: 'assistant', text, streaming };
    if (msgSeq === null) msgSeq = appendRow(botId, 'message', b).seq;
    else updateRow(botId, msgSeq, b);
    lastFlush = Date.now();
  };
  // Everything the bot said in this turn, for a bot that is waiting for the answer (ask_bot).
  const said: string[] = [];
  const closeMessage = () => {
    if (msgSeq === null) return;
    if (text.trim()) {
      said.push(text.trim());
      flush(false);
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    } else updateRow(botId, msgSeq, { type: 'message', role: 'assistant', text: '', streaming: false });
    msgSeq = null;
    text = '';
  };
  const say = (t: string) => {
    if (turn.silent || !t.trim()) return;
    closeMessage();
    said.push(t.trim());
    appendRow(botId, 'message', { type: 'message', role: 'assistant', text: t.trim(), streaming: false });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    wroteText = true;
  };

  let reasoning = '';
  let lastCaption = 0;
  const caption = (c: string | null, force = false) => {
    if (!c || c === getLive(botId).caption) return;
    if (!force && Date.now() - lastCaption < 300) return;
    lastCaption = Date.now();
    setLive(botId, { caption: c });
  };
  const outputsSeen = new Set<string>();
  let steps = 0;
  let failed = false;

  // A bot on a CLI engine: the same turn, read from a child process instead of a Hermes gateway.
  const cliTurn = async (cli: CliAdapter) => {
    const session = cliSession(botId);
    // The whole block of text being streamed arrives again when it is complete.
    let streamed = false;
    const { home, work } = cliHome(botId);
    const events = runCli(cli, {
      home,
      cwd: work,
      prompt: triggerText(trigger),
      system: await instructionsFor(userId, botId),
      sessionId: session.id,
      resume: session.resume,
      model: bot.model || null,
      effort: bot.effort ?? null,
      mcp: { url: `${env.mcpBaseUrl}/mcp/${botId}`, token: mcpToken(botId) },
      permissionTool: PERMISSION_TOOL,
    }, ctrl.signal);

    for await (const ev of events) {
      switch (ev.type) {
        case 'session':
          saveCliSession(botId, bot.generation, ev.id);
          break;

        case 'delta': {
          if (turn.silent) break;
          const piece = text ? ev.text : ev.text.trimStart();
          if (!piece) break;
          text += piece;
          wroteText = true;
          streamed = true;
          if (msgSeq === null) setLive(botId, { activity: { kind: 'working', since: now() } });
          if (msgSeq === null || Date.now() - lastFlush > 120) flush(true);
          break;
        }

        case 'reasoning':
          reasoning = (reasoning + ev.text).slice(-4000);
          caption(captionFrom(reasoning));
          break;

        case 'text': {
          if (streamed) {
            if (msgSeq !== null) { text = ev.text.trimStart(); closeMessage(); }
          } else say(ev.text);
          streamed = false;
          break;
        }

        case 'tool': {
          closeMessage();
          streamed = false;
          const { name } = appToolName(ev.name);
          const act = cliActivity(ev.name) ?? activityFor(ev.name);
          const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: ev.callId, name, label: act.label, status: 'running', args: ev.args } satisfies ToolCallBody);
          turn.tools.push({ seq: row.seq, callId: ev.callId, name, claimed: false, done: false });
          steps++;
          const toBot = name === 'send_to_bot' || name === 'ask_bot';
          const kind: ActivityKind = toBot ? 'messaging_named' : act.kind;
          const detail = toBot ? String(ev.args?.bot_name ?? '') || undefined : act.detail;
          if (!getLive(botId).awaiting) setLive(botId, { isRunning: true, activity: { kind, detail, since: now() }, steps, caption: null });
          else setLive(botId, { steps });
          reasoning = '';
          break;
        }

        case 'tool-result': {
          const ref = turn.tools.find((r) => r.callId === ev.callId);
          if (!ref || ref.done) break;
          ref.done = true;
          const told = turn.outcomes.get(ref.seq);
          const guess: Outcome = ev.isError ? { status: 'error', summary: ev.text.trim().slice(0, 200) || 'Failed' } : readOutcome({ output: ev.text });
          patchToolRow(botId, ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
          if (!getLive(botId).awaiting) setLive(botId, { activity: { kind: 'thinking', since: now() } });
          break;
        }

        case 'error':
          // The CLI lost the conversation (its files are gone): start a fresh one next time.
          if (session.resume && /no conversation found/i.test(ev.message)) forgetCliSession(botId);
          throw new Error(ev.message);
      }
    }
  };

  try {
    const cli = cliAdapter(bot.engine);
    if (cli) {
      await cliTurn(cli);
      return;
    }

    // The screen first: the engine's browser and computer tools point at it.
    await screenForWork(userId, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    const engine = await engineFor(botId);
    if (ctrl.signal.aborted) throw new Error('interrupted');

    let input = triggerText(trigger);
    if (bot.handback_at) {
      input = `[Note: the user took control of your screen for a while and has just handed it back. Look at the screen before you rely on what was there.]\n\n${input}`;
      db.prepare('UPDATE bots SET handback_at=NULL WHERE id=?').run(botId);
    }

    const res = await fetch(`${engine.url}/v1/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
      body: JSON.stringify({
        model: bot.model || 'hermes-agent',
        ...(bot.provider ? { provider: bot.provider } : {}),
        input,
        instructions: await instructionsFor(userId, botId),
        // One engine-side thread per conversation; "New chat" bumps the generation and starts another.
        conversation: `hq-${botId}-g${bot.generation}`,
        stream: true,
        store: true,
        model_options: { reasoning_effort: bot.effort ?? 'medium' },
      }),
    });
    if (!res.ok || !res.body) throw new Error(await failureText(res));

    for await (const ev of sseEvents(res.body)) {
      const d = ev.data;
      switch (ev.type) {
        case 'response.output_text.delta': {
          if (turn.silent || typeof d.delta !== 'string') break;
          // Models often open with blank lines; a message never starts with them.
          const piece = text ? d.delta : d.delta.trimStart();
          if (!piece) break;
          text += piece;
          wroteText = true;
          if (msgSeq === null) setLive(botId, { activity: { kind: 'working', since: now() } });
          if (msgSeq === null || Date.now() - lastFlush > 120) flush(true);
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof d.delta === 'string') {
            reasoning = (reasoning + d.delta).slice(-4000);
            caption(captionFrom(reasoning));
          }
          break;
        }

        case 'hermes.status': {
          if (typeof d?.text === 'string' && d.text.trim()) caption(d.text.trim().slice(0, 84), true);
          break;
        }

        case 'response.output_item.added': {
          const item = d.item;
          if (item?.type === 'reasoning') {
            reasoning = '';
            if (getLive(botId).activity?.kind !== 'thinking') setLive(botId, { activity: { kind: 'thinking', since: now() } });
          }
          if (item?.type === 'function_call') {
            // Text written before this call is its own message; what follows starts a new one.
            closeMessage();
            const { name, ours } = appToolName(String(item.name ?? ''));
            // The agent looking through its own toolbox is not a step worth showing.
            if (!ours && TOOLBOX.has(name)) {
              caption('Finding the right tool', true);
              break;
            }
            const act = activityFor(String(item.name ?? ''));
            let args: any;
            try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments; } catch { args = undefined; }
            const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: String(item.call_id ?? item.id ?? ''), name, label: act.label, status: 'running', args } satisfies ToolCallBody);
            turn.tools.push({ seq: row.seq, callId: String(item.call_id ?? item.id ?? ''), name, claimed: false, done: false });
            steps++;
            const toBot = name === 'send_to_bot' || name === 'ask_bot';
            const kind: ActivityKind = toBot ? 'messaging_named' : act.kind;
            const detail = toBot ? String(args?.bot_name ?? '') || undefined : act.detail;
            // A call that is waiting for the user keeps its "waiting for you" state.
            if (!getLive(botId).awaiting) setLive(botId, { isRunning: true, activity: { kind, detail, since: now() }, steps, caption: null });
            else setLive(botId, { steps });
            reasoning = '';
            if (ours && name.startsWith('COMPOSIO_')) {
              const tk = policyFor(userId, name, args ?? {}).toolkit;
              if (tk) {
                void toolkitInfo(tk).then((info) => {
                  const live = getLive(botId);
                  if (info?.name && turns.get(botId) === turn && live.activity?.kind === kind && !live.awaiting) setLive(botId, { activity: { ...live.activity, detail: info.name } });
                }).catch(() => {});
              }
            }
          }
          break;
        }

        case 'response.output_item.done': {
          const item = d.item;
          if (item?.type === 'message') {
            const full = (item.content ?? []).map((c: any) => c?.text ?? '').join('');
            if (item.phase === 'commentary') say(full);
            else if (msgSeq !== null) closeMessage();
            else if (!wroteText) say(full);
          }
          break;
        }

        case 'response.failed':
        case 'error':
          throw new Error(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the agent run failed');
      }

      // A tool result arrives as an item of its own (announced twice: added and done).
      const item = d?.item;
      if (item?.type === 'function_call_output' && item.call_id && !outputsSeen.has(item.call_id)) {
        outputsSeen.add(item.call_id);
        const ref = turn.tools.find((r) => r.callId === item.call_id);
        if (ref) {
          ref.done = true;
          const told = turn.outcomes.get(ref.seq);
          const guess = readOutcome(item);
          patchToolRow(botId, ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
          if (!getLive(botId).awaiting) setLive(botId, { activity: { kind: 'thinking', since: now() } });
        }
      }
    }
  } catch (e: any) {
    failed = true;
    const stopped = ctrl.signal.aborted;
    closeMessage();
    appendRow(botId, 'notice', { type: 'notice', text: stopped ? 'Stopped.' : `Something went wrong: ${e?.message ?? e}`, tone: stopped ? 'info' : 'error' });
    if (!stopped) console.error('[agent]', botId, e);
  } finally {
    closeMessage();
    for (const ref of turn.tools) {
      if (ref.done) continue;
      const row = getRow(botId, ref.seq);
      if (row?.body.type !== 'tool-call' || (row.body.status !== 'running' && row.body.status !== 'awaiting-approval')) continue;
      patchToolRow(botId, ref.seq, failed ? { status: 'error', summary: ctrl.signal.aborted ? 'Stopped' : 'Did not finish' } : { status: 'done' });
    }
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
    if (turns.get(botId) === turn) turns.delete(botId);
    // This bot's turn is over: it waits for nobody any more, and whoever asked it gets its reply.
    asks.release(botId);
    if (trigger.type === 'bot' && trigger.askId) {
      const reply = said.join('\n\n');
      // An asker that stopped waiting (the limit passed, or its turn ended) was told the answer would
      // come later. This is cleanup: a failure here must not skip what follows.
      try {
        const next = afterAnswer(asks.settle(trigger.askId, reply), reply);
        // Either bot may have been removed in the meantime; then there is nobody to tell, or nobody to tell it from.
        if (next !== 'nothing' && getBotRow(trigger.fromBotId) && getBotRow(botId)) {
          if (next === 'send_reply') enqueueBotMessage(botId, trigger.fromBotId, reply.slice(0, 12000), trigger.depth + 1);
          else enqueue(trigger.fromBotId, { type: 'system', text: `${bot.name} finished without an answer to the question you asked with ask_bot. No answer will arrive; go on without it or tell the user.` });
        }
      } catch (e: any) {
        console.warn(`[agent] ${botId}: could not pass a late answer on: ${e?.message ?? e}`);
      }
    }
    // An approval asked for outside this turn may still be waiting; leave its state alone.
    if (!pendingApprovals(botId).length) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null, caption: null });
    else setLive(botId, { isRunning: false, caption: null });
    emitBot(botId);
  }
}
