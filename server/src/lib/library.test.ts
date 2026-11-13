import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { READ_FILE_SCRIPT, safeRel } from './library.js';

test('safeRel accepts paths inside the library and rejects anything that could leave it', () => {
  assert.equal(safeRel(undefined), '');
  assert.equal(safeRel('/notes/a.txt/'), 'notes/a.txt');
  assert.equal(safeRel("odd 'name $(id).txt"), "odd 'name $(id).txt");
  for (const bad of ['../x', 'a/../b', 'a/./b', 'a//b', 'a\nb', 'a\rb', 'a\0b']) assert.equal(safeRel(bad), null, bad);
});

// The containment check runs inside the Linux box (GNU realpath and stat), so it is exercised in a
// throwaway container. Without a Docker runtime or the base image this test is skipped.
const docker = process.env.HQ_DOCKER_BIN ?? 'docker';
const image = 'debian:bookworm-slim';
const haveImage = spawnSync(docker, ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

test('the library read script serves only regular files inside the library', { skip: !haveImage && 'no Docker runtime with debian:bookworm-slim' }, () => {
  const cases = ['a.txt', 'sub/b.txt', 'inside-link', "odd 'name.txt", 'outside-link', 'dir-link/hostname', 'sibling-link/secret.txt', 'sub', 'missing.txt', 'pipe'];
  const setup = [
    'set -e',
    'mkdir -p /lib/bot/sub /lib/other',
    'printf hello > /lib/bot/a.txt',
    'printf nested > /lib/bot/sub/b.txt',
    'printf secret > /lib/other/secret.txt',
    `printf odd > "/lib/bot/odd 'name.txt"`,
    'ln -s a.txt /lib/bot/inside-link',
    'ln -s /etc/hostname /lib/bot/outside-link',
    'ln -s /etc /lib/bot/dir-link',
    'ln -s /lib/other /lib/bot/sibling-link',
    'mkfifo /lib/bot/pipe',
    'set +e',
    `cat > /read.sh <<'HQ_EOF'\n${READ_FILE_SCRIPT}\nHQ_EOF`,
    ...cases.map((rel) => `printf '<<%s>>' "$(sh /read.sh /lib/bot ${JSON.stringify(rel).replace(/\$/g, '\\$')} 2>/dev/null | tr '\\n' '|')"; echo " rc=$?"`),
  ].join('\n');
  const r = spawnSync(docker, ['run', '--rm', '-i', image, 'sh', '-s'], { input: setup, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  // Served: "<size>|<bytes>". Refused: nothing at all on stdout.
  assert.deepEqual(lines.map((l) => l.replace(/ rc=\d+$/, '')), [
    '<<5|hello>>', '<<6|nested>>', '<<5|hello>>', '<<3|odd>>',
    '<<>>', '<<>>', '<<>>', '<<>>', '<<>>', '<<>>',
  ]);
});
