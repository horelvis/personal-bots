import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliActivity, permissionAnswer, permissionRule, permissionStep } from './tools.js';

test('a shell command asks under one key and shows the command', () => {
  const r = permissionRule('Bash', { command: 'rm -rf build', description: 'Clean' });
  assert.equal(r.key, 'cli_bash');
  assert.equal(r.title, 'Shell: run a command');
  assert.equal(r.detail, 'rm -rf build');
});

test('writing and editing files ask under their own keys and show the path', () => {
  assert.deepEqual(permissionRule('Write', { file_path: '/w/a.txt', content: 'x' }), { key: 'cli_write', title: 'Files: write a file', detail: '/w/a.txt' });
  assert.deepEqual(permissionRule('Edit', { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' }), { key: 'cli_edit', title: 'Files: edit a file', detail: '/w/a.txt' });
});

test('a read that reaches the prompt is a read outside the bot folder', () => {
  const r = permissionRule('Read', { file_path: '/etc/passwd' });
  assert.equal(r.key, 'cli_read');
  assert.equal(r.title, 'Files: read outside its folder');
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
  assert.equal(permissionStep('Bash', 'always_allow'), 'allow');
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
