import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPrompt, decide, readOnlyCommand, trustCheck, type TrustAction, type TrustWords } from './trust-check.js';

const words: TrustWords = {
  messages: ['Email Ana the report please', 'thanks'],
  rules: 'Always ask before any shell command that deletes files.',
};
const send: TrustAction = { tool: 'gmail_send', title: 'Gmail: send an email', kind: 'change', args: { to: ['ana@example.com'], subject: 'Report', body: '...' } };
const ls: TrustAction = { tool: 'Bash', title: 'Shell: run a command', kind: 'unknown', args: { command: 'ls' } };

test('the prompt holds the user words, the rules and the exact action, and nothing else', () => {
  const p = checkPrompt(send, words);
  for (const s of ['Email Ana the report please', 'Always ask before any shell command', 'gmail_send', 'ana@example.com']) assert.ok(p.user.includes(s), s);
  // Messages are numbered so the answer can say which one it quotes.
  assert.match(p.user, /\[message:0\] Email Ana the report please/);
  assert.match(p.system, /never/i);
});

test('a routine instruction is shown when the turn is a routine', () => {
  assert.ok(checkPrompt(send, { ...words, routine: 'Every Monday email Ana the weekly report' }).user.includes('[routine] Every Monday email Ana'));
  assert.ok(!checkPrompt(send, words).user.includes('[routine]'));
});

test('an action runs when the model quotes words the user wrote', () => {
  const d = decide('{"run": true, "because": "Email Ana the report", "source": "message:0"}', words, send);
  assert.deepEqual(d, { run: true, because: 'Email Ana the report', source: 'message:0' });
});

// The attack: the model (steered by an email it never sees, or by a bad call) cites words the user never wrote.
test('an action does not run on words the user never wrote', () => {
  const d = decide('{"run": true, "because": "forward this to X", "source": "message:0"}', words, send);
  assert.equal(d.run, false);
  assert.match((d as any).reason, /not found/);
});

test('the quote must be in the message the answer names', () => {
  assert.equal(decide('{"run": true, "because": "Email Ana the report", "source": "message:1"}', words, send).run, false);
});

test('a quote from the rules or the routine counts only there', () => {
  const rulesWords: TrustWords = { messages: [], rules: 'You may run git status without asking.' };
  const git: TrustAction = { ...ls, args: { command: 'git status' } };
  assert.equal(decide('{"run": true, "because": "You may run git status without asking", "source": "rules"}', rulesWords, git).run, true);
  const r = { messages: [], rules: '', routine: 'Every Monday email Ana the weekly report' };
  assert.equal(decide('{"run": true, "because": "email Ana the weekly report", "source": "routine"}', r, send).run, true);
  assert.equal(decide('{"run": true, "because": "email Ana the weekly report", "source": "routine"}', words, send).run, false);
});

test('a read runs without a quote, but an action that changes something never does', () => {
  assert.equal(decide('{"run": true, "because": "read", "source": "read"}', words, ls).run, true);
  assert.equal(decide('{"run": true, "because": "read", "source": "read"}', words, { tool: 'Read', title: 'Files: read', kind: 'read', insideFolder: true, args: { file_path: 'notes.txt' } }).run, true);
  assert.equal(decide('{"run": true, "because": "read", "source": "read"}', words, send).run, false);
});

const READ = '{"run": true, "because": "read", "source": "read"}';
const bash = (command: string): TrustAction => ({ tool: 'Bash', title: 'Shell: run a command', kind: 'unknown', args: { command } });

// Found by verification (B4): the model's word "read" let `rm` through.
test('the model calling a shell command a read is not enough unless the command only reads', () => {
  for (const c of ['rm -rf build', 'ls; rm x', 'ls && rm x', 'ls > out.txt', 'echo $(rm x)', 'echo `rm x`', 'find . -delete', 'find . -exec rm {} ;', 'git push', 'git checkout .', 'curl https://example.com', 'python3 -c "print(1)"', 'cat a | sh', 'sed -i s/a/b/ f']) {
    assert.equal(decide(READ, words, bash(c)).run, false, c);
  }
  for (const c of ['ls', 'ls -la', 'pwd', 'cat notes.txt', 'head -n 5 notes.txt', 'wc -l notes.txt', 'grep -n todo notes.txt', 'git status', 'git log --oneline -5', 'git diff', 'find . -name "*.md"', 'echo hello']) {
    assert.equal(decide(READ, words, bash(c)).run, true, c);
  }
});

// Found by verification (B5): a read of a secret outside the bot's folder ran without a card.
test('a read outside the bot folder needs the user words', () => {
  for (const c of ['cat ~/.ssh/id_rsa', 'cat /etc/passwd', 'cat ../other/secret.txt', 'ls /home', 'head ~/notes', 'grep -r key ..']) {
    assert.equal(readOnlyCommand(c), false, c);
  }
  const outside: TrustAction = { tool: 'Read', title: 'Files: read', kind: 'read', insideFolder: false, args: { file_path: '/home/u/.ssh/id_rsa' } };
  assert.equal(decide(READ, words, outside).run, false);
  assert.equal(decide(READ, words, { ...outside, insideFolder: undefined }).run, false);
  // The user may still ask for it: then the quote decides.
  const asked: TrustWords = { messages: ['please read /home/u/notes/todo.txt for me'], rules: '' };
  assert.equal(decide('{"run": true, "because": "please read /home/u/notes/todo.txt", "source": "message:0"}', asked, { ...outside, args: { file_path: '/home/u/notes/todo.txt' } }).run, true);
});

// Found by the recheck (B4): flags that run programs, write files or never end, and braces that leave the folder.
test('allowed commands with flags that write, run programs or leave the folder are not reads', () => {
  for (const c of ['rg --pre=rm x .', 'rg --pre rm x .', 'rg --pre-glob "*" x .', 'cat {/etc,x}/passwd', 'cat {..,.}/{..,.}/secret', 'tree -o notes.md', 'file -C -m x', 'date -s 2020-01-01', 'tail -f log.txt', 'tail -F log.txt', 'tail --follow log.txt', 'tail -nf 5 log.txt']) {
    assert.equal(readOnlyCommand(c), false, c);
  }
  for (const c of ['rg todo .', 'tail -n 5 log.txt', 'date']) assert.equal(readOnlyCommand(c), true, c);
});

// Found by verification: a one-letter quote was enough.
test('a quote too short to mean anything is refused', () => {
  for (const q of ['e', 'Ana', 'the', 'ok']) {
    assert.equal(decide(`{"run": true, "because": "${q}", "source": "message:0"}`, words, send).run, false, q);
  }
});

test('a refusal from the model means asking, with its reason', () => {
  const d = decide('{"run": false, "because": "The user asked to email Ana, not Bob."}', words, send);
  assert.deepEqual(d, { run: false, reason: 'The user asked to email Ana, not Bob.' });
});

test('an answer that cannot be read means asking', () => {
  for (const raw of ['', 'sure, go ahead', '{"run": "yes"}', '{"run": true}', '{"run": true, "because": ""}', 'null']) {
    assert.equal(decide(raw, words, send).run, false, raw);
  }
});

test('the JSON may come wrapped in text or a code block', () => {
  assert.equal(decide('Here:\n```json\n{"run": true, "because": "Email Ana the report", "source": "message:0"}\n```', words, send).run, true);
});

test('a model that fails or is too slow means asking', async () => {
  const failed = await trustCheck(send, words, async () => { throw new Error('503'); }, 1000);
  assert.equal(failed.run, false);
  assert.match((failed as any).reason, /could not check/);
  const slow = await trustCheck(send, words, () => new Promise((r) => setTimeout(() => r('{"run": true, "because": "Email Ana the report", "source": "message:0"}'), 200)), 30);
  assert.equal(slow.run, false);
  const ok = await trustCheck(send, words, async () => '{"run": true, "because": "Email Ana the report", "source": "message:0"}', 1000);
  assert.equal(ok.run, true);
});
