// ============================================================================
// Next.js instrumentation hook (runs once per server process on boot). Boots
// the signal scheduler so activated strategies keep their scheduled checks
// without waiting for a route to be touched. The import stays dynamic and
// runtime-guarded so the edge bundle never pulls in node-only APIs.
// ============================================================================

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    (await import('./lib/server/signals/scheduler')).getSignalScheduler().init();
  }
}
