/**
 * A repeating timer with no vscode dependency, so it can be unit tested
 * directly — same rationale as src/watch/refireGate.ts.
 *
 * Used for the analytics panel's background refresh. A throwing callback is
 * swallowed rather than allowed to kill the interval: one failed refresh must
 * not stop every later one.
 */

/**
 * Background refresh cadence for the analytics panel, matching the quota
 * status bar's own 5-minute timer in src/extension.ts.
 */
export const ANALYTICS_REFRESH_MS = 5 * 60 * 1000;

export interface PollTimer {
  /** Stop ticking. Safe to call more than once. */
  dispose(): void;
}

export function createPollTimer(onTick: () => void, intervalMs: number): PollTimer {
  let handle: ReturnType<typeof setInterval> | null = setInterval(() => {
    try {
      onTick();
    } catch {
      // A failed tick must not cancel the interval.
    }
  }, intervalMs);

  return {
    dispose(): void {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
  };
}
