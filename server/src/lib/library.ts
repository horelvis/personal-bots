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
 * size in bytes, then the bytes. A refusal prints nothing and exits non-zero. The path travels as an
 * argument, never as shell text.
 *
 * The file is opened once and every check is made on that open file, so swapping the path for a link
 * after the check changes nothing: what was checked is what is read. The test before opening only
 * keeps a pipe or device from blocking the open.
 */
export const READ_FILE_SCRIPT = [
  'r=$(realpath -e -- "$1") && [ -f "$1/$2" ] || exit 3',
  'exec 3<"$1/$2" || exit 3',
  'f=$(readlink -f "/proc/$$/fd/3") && [ -f "/proc/$$/fd/3" ] || exit 3',
  'case "$f" in "$r"/*) ;; *) exit 3 ;; esac',
  'stat -L -c %s "/proc/$$/fd/3" && exec cat <&3',
].join('\n');
