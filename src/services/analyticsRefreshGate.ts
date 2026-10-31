/**
 * Decides whether a background (silent) analytics refresh must rebuild the
 * dashboard. Pure and vscode-free so it can be unit tested directly.
 *
 * buildAnalytics() runs synchronous aggregation over the whole database, which
 * measured ~3.8 s of CPU per call on a 33 MB copy. Every watcher pass used to
 * trigger one while the panel was open, so the rule here is: rebuild only when
 * the data could have changed, and never more often than the minimum gap.
 */

/** Silent rebuilds while data keeps changing run at most this often. */
export const ANALYTICS_MIN_SILENT_GAP_MS = 60 * 1000;

/**
 * Longest a silent pass may reuse the last result, even with no data change.
 * Kept under the 5-minute poll so each poll tick still rebuilds: the quota
 * shown on the dashboard comes from that rebuild, not from the database.
 */
export const ANALYTICS_MAX_REUSE_MS = 4 * 60 * 1000;

export interface BuildRecord {
  /** dbDataVersion() captured before the build started. */
  version: string;
  /** Local calendar day; the queries use date('now'). */
  day: string;
  /** Monotonic time of the build, in ms. */
  at: number;
}

export type RefreshDecision = "build" | "skip" | "defer";

export interface RefreshInput {
  force: boolean;
  silent: boolean;
  now: number;
  last: BuildRecord | undefined;
  version: string;
  day: string;
}

/**
 * - "build": rebuild now.
 * - "skip":  the last result is still current; do nothing.
 * - "defer": data changed too recently; rebuild once the minimum gap has passed.
 *
 * Forced and non-silent refreshes always build. A silent pass with no previous
 * build builds too, so a dashboard with nothing painted is never left empty.
 */
export function decideRefresh(input: RefreshInput): RefreshDecision {
  if (input.force || !input.silent || !input.last) return "build";
  const age = input.now - input.last.at;
  const unchanged = input.last.version === input.version && input.last.day === input.day;
  if (unchanged && age < ANALYTICS_MAX_REUSE_MS) return "skip";
  if (age < ANALYTICS_MIN_SILENT_GAP_MS) return "defer";
  return "build";
}

/** Milliseconds until a deferred silent rebuild may run. */
export function deferDelayMs(last: BuildRecord, now: number): number {
  return Math.max(0, last.at + ANALYTICS_MIN_SILENT_GAP_MS - now);
}
