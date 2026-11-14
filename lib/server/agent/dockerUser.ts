// ============================================================================
// Who the agent container runs as.
//
// The container writes the session's work directory (strategy.py, result.json,
// data/), and the server rewrites those same files before the next run. On
// Linux a container's default user is root, so everything it wrote came back
// root-owned and the server — an ordinary user — could not replace it: a
// refinement failed with EACCES before it started. Running the container as
// the server's own uid:gid keeps one owner on both sides.
//
// Docker Desktop (macOS, Windows) already maps bind-mounted files to the host
// user, so there the container keeps its default; and a server that itself
// runs as root needs no mapping either.
// ============================================================================

/** `['--user', 'uid:gid']` on Linux for a non-root server, else `[]`. */
export function dockerUserArgs(): string[] {
  if (process.platform !== 'linux') return [];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) return [];
  return ['--user', `${uid}:${gid}`];
}
