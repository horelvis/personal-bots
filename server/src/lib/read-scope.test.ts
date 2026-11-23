import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readsInside } from './read-scope.js';

test('on the host, reads are judged against the host work folder', () => {
  const o = { folder: '/srv/engines/b1/work', home: '/home/srv' };
  assert.equal(readsInside(['notes.md'], o), true);
  assert.equal(readsInside(['/srv/engines/b1/work/a/b.md'], o), true);
  assert.equal(readsInside(['/srv/engines/b1/work'], o), true);
  assert.equal(readsInside(['../mcp.json'], o), false);
  assert.equal(readsInside(['~/.ssh/id_rsa'], o), false);
  assert.equal(readsInside(['/srv/engines/b1/work2/x'], o), false);
});

// Found by verification (R8): inside a container the CLI names files under /hq/work, never the host path.
test('in a container, reads are judged against the folder as the container sees it', () => {
  const o = { folder: '/hq/work', home: '/hq/claude' };
  assert.equal(readsInside(['/hq/work/notes.md'], o), true);
  assert.equal(readsInside(['notes.md'], o), true);
  assert.equal(readsInside(['/hq/mcp.json'], o), false);
  assert.equal(readsInside(['/hq/work/../system.md'], o), false);
  assert.equal(readsInside(['~/.claude.json'], o), false);
  assert.equal(readsInside(['/etc/passwd'], o), false);
});

test('a read naming no path stays inside, as before', () => {
  assert.equal(readsInside([], { folder: '/hq/work', home: '/hq/claude' }), true);
});
