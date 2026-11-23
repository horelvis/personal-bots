import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionKind, alwaysAllowOffered, cliActivity, permissionAnswer, permissionRule, permissionStep } from './tools.js';

test('a shell command asks under one key and shows the command', () => {
  const r = permissionRule('Bash', { command: 'rm -rf build', description: 'Clean' });
  assert.equal(r.key, 'cli_bash');
  assert.equal(r.title, 'Shell: run a command');
  assert.equal(r.detail, 'rm -rf build');
});

// A card must show everything it approves: a command cut short could hide what it really does.
test('a command too long to show whole cannot be approved', () => {
  const long = `echo ${'a'.repeat(3000)} ; rm -rf ~/important`;
  const r = permissionRule('Bash', { command: long });
  assert.equal(r.tooLong, true);
  assert.equal(permissionRule('Bash', { command: 'ls -la' }).tooLong, undefined);
  const fits = `echo ${'a'.repeat(1900)}`;
  assert.equal(permissionRule('Bash', { command: fits }).detail, fits);
  assert.equal(permissionRule('Write', { file_path: `/w/${'d'.repeat(3000)}` }).tooLong, true);
});

test('writing and editing files ask under their own keys and show the path', () => {
  assert.equal(permissionRule('Write', { file_path: '/w/a.txt', content: 'x' }).key, 'cli_write');
  assert.equal(permissionRule('Write', { file_path: '/w/a.txt', content: 'x' }).title, 'Files: write a file');
  assert.equal(permissionRule('Edit', { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' }).key, 'cli_edit');
});

test('a read asks under one key and shows what is read', () => {
  const r = permissionRule('Read', { file_path: '/etc/passwd' });
  assert.equal(r.key, 'cli_read');
  assert.equal(r.title, 'Files: read');
  assert.equal(r.detail, '/etc/passwd');
  assert.equal(permissionRule('Grep', { pattern: 'key', path: '/home/u' }).key, 'cli_read');
});

test('an unknown tool still gets a key and a title of its own', () => {
  const r = permissionRule('NotebookRun', { cell: 1 });
  assert.equal(r.key, 'cli_notebookrun');
  assert.equal(r.title, 'NotebookRun: use this tool');
  assert.equal(r.detail, undefined);
});

test('without a saved choice the user is asked', () => {
  assert.equal(permissionStep('Bash', undefined), 'ask');
  assert.equal(permissionStep('Bash', 'needs_approval'), 'ask');
  assert.equal(permissionStep('Write', undefined), 'ask');
});

test('a saved choice is followed', () => {
  assert.equal(permissionStep('Write', 'always_allow'), 'allow');
  assert.equal(permissionStep('Bash', 'blocked'), 'deny');
});

test("the app's own tools pass: they carry their own approvals", () => {
  assert.equal(permissionStep('mcp__hq__gmail_send', undefined), 'allow');
  // Only our server, by its exact prefix.
  assert.equal(permissionStep('mcp__hqx__gmail_send', undefined), 'ask');
  assert.equal(permissionStep('mcp__other__thing', undefined), 'ask');
});

test('a request without a tool name is refused', () => {
  assert.equal(permissionStep('', undefined), 'deny');
  assert.equal(permissionStep('', 'always_allow'), 'deny');
});

test('the answer is the JSON the CLI expects', () => {
  assert.deepEqual(JSON.parse(permissionAnswer('allow', { command: 'ls' })), { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.deepEqual(JSON.parse(permissionAnswer('allow', undefined)), { behavior: 'allow', updatedInput: {} });
  assert.deepEqual(JSON.parse(permissionAnswer('deny', { command: 'ls' }, 'No.')), { behavior: 'deny', message: 'No.' });
});

test('what a bot is doing is named for the CLI tools', () => {
  assert.deepEqual(cliActivity('Bash'), { kind: 'running_commands', label: 'Running commands' });
  assert.deepEqual(cliActivity('Edit'), { kind: 'drafting_file', label: 'Writing a file' });
  assert.deepEqual(cliActivity('Grep'), { kind: 'working', label: 'Reading files' });
  assert.deepEqual(cliActivity('WebSearch'), { kind: 'searching_web', label: 'Searching the web' });
  assert.deepEqual(cliActivity('WebFetch'), { kind: 'reading_web', label: 'Reading a page' });
  assert.deepEqual(cliActivity('mcp__hq__remember'), { kind: 'remembering', label: 'Saving notes' });
  // The app's other tools keep the labels they already have.
  assert.equal(cliActivity('mcp__hq__create_routine'), null);
});

// R6 (S12): one click must not open every shell command or every read outside the folder for good.
test('"Always allow" no longer applies to shell commands and reads outside the folder', () => {
  assert.equal(permissionStep('Bash', 'always_allow'), 'ask');
  for (const t of ['Read', 'Glob', 'Grep']) assert.equal(permissionStep(t, 'always_allow'), 'ask', t);
  // It still applies to writing and editing files, and "never" still applies to everything.
  assert.equal(permissionStep('Write', 'always_allow'), 'allow');
  assert.equal(permissionStep('Bash', 'blocked'), 'deny');
  assert.equal(alwaysAllowOffered('cli_bash'), false);
  assert.equal(alwaysAllowOffered('cli_read'), false);
  assert.equal(alwaysAllowOffered('cli_write'), true);
  assert.equal(alwaysAllowOffered('gmail_send'), true);
});

// R6 (S5, K5): the card says what will be written, not only where.
test('a file-write card shows what will be written', () => {
  const r = permissionRule('Write', { file_path: '/w/notes.txt', content: 'line one\nline two' });
  assert.equal(r.detail, '/w/notes.txt\n\nline one\nline two');
  const big = permissionRule('Write', { file_path: '/w/big.txt', content: 'x'.repeat(5000) });
  assert.match(big.detail!, /^\/w\/big\.txt\n\nx{1500}…\n\(3500 more characters\)$/);
  const edit = permissionRule('Edit', { file_path: '/w/a.ts', old_string: 'foo()', new_string: 'bar()' });
  assert.equal(edit.detail, '/w/a.ts\n\nReplace:\nfoo()\nWith:\nbar()');
});

test('the check is told what kind of action it is', () => {
  assert.equal(actionKind('Bash'), 'unknown');
  for (const t of ['Read', 'Glob', 'Grep']) assert.equal(actionKind(t), 'read');
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'Something']) assert.equal(actionKind(t), 'change');
});

// Found by verification (B3): one "Always allow" on routines removed the check for good.
test("routine changes and self notes never offer \"Always allow\"", () => {
  for (const t of ['create_routine', 'create_event_routine', 'update_routine', 'delete_routine', 'set_checkins', 'memory_note']) assert.equal(alwaysAllowOffered(t), false, t);
});
