import path from 'node:path';

/**
 * Whether the paths a CLI file read names (Read, Glob, Grep) all stay inside the bot's folder.
 * `folder` and `home` are as the CLI sees them: the host paths, or /hq/work and /hq/claude in a container (R8).
 * Both are POSIX paths on every host the CLI runs on.
 */
export function readsInside(paths: string[], o: { folder: string; home: string }): boolean {
  const folder = path.posix.resolve(o.folder);
  return paths.every((p) => {
    const abs = path.posix.resolve(folder, p.replace(/^~(?=\/|$)/, o.home));
    return abs === folder || abs.startsWith(folder + '/');
  });
}
