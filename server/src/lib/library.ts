/**
 * Paths inside a bot's Library folder on the computer.
 */

/** A request path relative to the library: '' for the root, null when it could leave the folder. */
export function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

/**
 * Shell script for the Linux box: `sh -c SCRIPT sh <library root> <relative path>`. It follows links
 * first, then serves the file only if it is a regular file inside the library: one line with its
 * size in bytes, then the bytes. A refusal prints nothing and exits non-zero. Check and read happen
 * in one process, and the path travels as an argument, never as shell text.
 */
export const READ_FILE_SCRIPT = [
  'r=$(realpath -e -- "$1") && f=$(realpath -e -- "$1/$2") && [ -f "$f" ] || exit 3',
  'case "$f" in "$r"/*) ;; *) exit 3 ;; esac',
  'stat -c %s -- "$f" && exec cat -- "$f"',
].join('\n');
