/**
 * Coalesces bursts of trigger() calls into a single debounced fire, then
 * suppresses further fires for a minimum interval. Events arriving during
 * the suppression window schedule exactly one trailing fire once it ends.
 *
 * Pure timer logic with no vscode dependency, so it can be unit tested
 * directly.
 */

/** Minimum interval between watcher-triggered index passes. */
export const MIN_REFIRE_MS = 5000;

export interface RefireGate {
  /** Call on every watched-file event. */
  trigger(): void;
  /** Cancel any pending timers. */
  dispose(): void;
}

export function createRefireGate(
  onFire: () => void,
  debounceMs: number,
  minRefireMs: number = MIN_REFIRE_MS,
): RefireGate {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressed = false;
  let pendingFire = false;

  function fire(): void {
    onFire();
    pendingFire = false;
    suppressed = true;
    suppressTimer = setTimeout(() => {
      suppressTimer = null;
      suppressed = false;
      if (pendingFire) {
        fire();
      }
    }, minRefireMs);
  }

  function trigger(): void {
    if (suppressed) {
      // Coalesce events during the suppression window into a single
      // trailing fire once it ends — no separate debounce needed here.
      pendingFire = true;
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      fire();
    }, debounceMs);
  }

  function dispose(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  return { trigger, dispose };
}
