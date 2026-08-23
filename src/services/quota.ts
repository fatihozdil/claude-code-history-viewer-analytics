import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tier-based token budgets (estimates — exact budgets are set server-side).
 *
 * Keyed by the normalized tier string that `readPlanTier` may return.
 * Unknown tiers fall back to the `free` budget.
 */
// Budgets are token estimates (input + cache-creation + output; cache-reads
// excluded, matching computeUsage). The Pro anchor (2.3M / 130M) is calibrated
// against CCAssist's observed "% remaining" on a Pro account; other tiers scale
// by their plan multiplier. Exact server-side limits are not published, so
// these are overridable via the `claudeHistory.quota.*` settings.
const TIER_BUDGETS: Record<string, { fiveHour: number; weekly: number }> = {
  free:               { fiveHour: 460000,    weekly: 26000000 },
  default_claude_ai:  { fiveHour: 2300000,   weekly: 130000000 },
  claude_pro:         { fiveHour: 2300000,   weekly: 130000000 },
  pro:                { fiveHour: 2300000,   weekly: 130000000 },
  max:                { fiveHour: 4600000,   weekly: 260000000 },
  max_5x:             { fiveHour: 11500000,  weekly: 650000000 },
  max_20x:            { fiveHour: 46000000,  weekly: 2600000000 },
};

/** Human-friendly label for a normalized tier string. */
export function tierLabel(tier: string): string {
  switch (tier) {
    case "free": return "Free";
    case "default_claude_ai":
    case "claude_pro":
    case "pro": return "Pro";
    case "max": return "Max";
    case "max_5x": return "Max 5×";
    case "max_20x": return "Max 20×";
    default: return tier;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  used: number;
  budget: number;
  pct: number; // percent used (0–100+, not clamped)
  remainingPct: number; // percent remaining (0–100, clamped)
  remaining: number;
  resetsIn: number; // milliseconds until this window resets
}

export interface QuotaView {
  tier: string;
  tierLabel: string;
  /** "live" = real server utilization; "estimate" = local token-budget guess. */
  source: "live" | "estimate";
  /**
   * When the live data came from the on-disk cache (because a fresh fetch was
   * rate-limited or offline), this is the epoch-ms timestamp it was captured.
   * Absent for a fresh fetch or for the local estimate.
   */
  cachedAtMs?: number;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
}

// ---------------------------------------------------------------------------
// readPlanTier
// ---------------------------------------------------------------------------

/**
 * Read the Claude plan tier from `~/.claude.json`.
 *
 * If `claudeConfig` is provided (test-friendly) it is used directly instead
 * of reading the file from disk.  Returns `"free"` on any error.
 *
 * Resolution order:
 * 1. `organizationRateLimitTier` (if it matches a known budget key)
 * 2. `oauthAccount.organizationType` (if it matches a known budget key)
 * 3. `"free"` fallback
 */
export function readPlanTier(claudeConfig?: unknown): string {
  try {
    let config: Record<string, unknown>;
    if (claudeConfig !== undefined) {
      config = claudeConfig as Record<string, unknown>;
    } else {
      const raw = readFileSync(join(homedir(), ".claude.json"), "utf8");
      config = JSON.parse(raw) as Record<string, unknown>;
    }

    // 1. organizationRateLimitTier is the most specific indicator
    const rateLimitTier = config.organizationRateLimitTier;
    if (typeof rateLimitTier === "string" && TIER_BUDGETS[rateLimitTier]) {
      return rateLimitTier;
    }

    // 2. oauthAccount.organizationType
    const oauth = config.oauthAccount;
    if (oauth && typeof oauth === "object") {
      const orgType = (oauth as Record<string, unknown>).organizationType;
      if (typeof orgType === "string" && TIER_BUDGETS[orgType]) {
        return orgType;
      }
    }

    return "free";
  } catch {
    return "free";
  }
}

// ---------------------------------------------------------------------------
// getBudget
// ---------------------------------------------------------------------------

/**
 * Read VS Code config overrides for the token budget.
 * Returns an empty object when called outside the VS Code extension host
 * (e.g. during tests).
 */
function readSettingsOverrides(): { fiveHour?: number; weekly?: number } {
  try {
    // Lazy-require vscode so this module can be loaded in tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode");
    const config: { get: (key: string, def: number) => number } =
      vscode.workspace.getConfiguration("claudeHistory");
    const fh = config.get("quota.fiveHourTokenBudget", 0);
    const wk = config.get("quota.weeklyTokenBudget", 0);
    return {
      fiveHour: fh > 0 ? fh : undefined,
      weekly: wk > 0 ? wk : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Return the 5-hour and 7-day token budgets for `tier`.
 *
 * When `tier` is omitted the tier is auto-detected via `readPlanTier()`.
 * When `configOverrides` is provided (test-friendly) it is used instead of
 * reading VS Code settings.  Non-zero overrides replace the tier default.
 */
export function getBudget(
  tier?: string,
  configOverrides?: { fiveHour?: number; weekly?: number },
): { fiveHour: number; weekly: number } {
  const t = tier ?? readPlanTier();
  const base = TIER_BUDGETS[t] ?? TIER_BUDGETS.free;
  const overrides = configOverrides === undefined ? readSettingsOverrides() : configOverrides;

  return {
    fiveHour: (overrides.fiveHour ?? 0) > 0 ? overrides.fiveHour! : base.fiveHour,
    weekly: (overrides.weekly ?? 0) > 0 ? overrides.weekly! : base.weekly,
  };
}

// ---------------------------------------------------------------------------
// computeUsage
// ---------------------------------------------------------------------------

/**
 * Lazy-loaded reference to the real `dbGet`.
 *
 * Falls back to a no-op that returns `undefined` when the module cannot be
 * loaded (e.g. vscode unavailable during tests).  This avoids a static
 * import of `../storage/db.js` which cascades to the `vscode` module not
 * present in the test runner.
 */
function lazyDbGet(
  sql: string,
  params: unknown[],
): Record<string, unknown> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const db = require("../storage/db.js");
    return db.dbGet(sql, params);
  } catch {
    return undefined;
  }
}

/**
 * Compute total token usage within a rolling time window.
 *
 * @param now  The reference point (usually `new Date()`).
 * @param windowMs  Width of the rolling window in milliseconds.
 * @param queryDb  Test-only: inject a mock dbGet implementation.
 */
export function computeUsage(
  now: Date,
  windowMs: number,
  queryDb?: (sql: string, params: unknown[]) => Record<string, unknown> | undefined,
): number {
  const q = queryDb ?? lazyDbGet;
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  // Cache-read tokens are excluded: they are billed at a tiny fraction and do
  // not reflect real rate-limit consumption, and including them inflates the
  // number by 10–100×, making "usage" look nonsensical.
  const row = q(
    `SELECT COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.output_tokens,0)), 0) AS total
       FROM messages m
       JOIN sessions s ON s.session_id = m.session_id
      WHERE m.ts > ? AND s.provider = 'claude'`,
    [cutoff],
  );
  if (!row) return 0;
  const val = (row as Record<string, unknown>).total;
  return typeof val === "number" ? val : Number(val ?? 0);
}

/**
 * Find the epoch-ms timestamp of the oldest message still inside the rolling
 * window. Returns `null` when there is no usage in the window (or the query
 * yields no usable timestamp). Used to compute when the window frees up.
 */
export function computeOldestInWindow(
  now: Date,
  windowMs: number,
  queryDb?: (sql: string, params: unknown[]) => Record<string, unknown> | undefined,
): number | null {
  const q = queryDb ?? lazyDbGet;
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const row = q(
    `SELECT MIN(m.ts) AS oldest
       FROM messages m
       JOIN sessions s ON s.session_id = m.session_id
      WHERE m.ts > ? AND s.provider = 'claude'`,
    [cutoff],
  );
  const raw = row ? (row as Record<string, unknown>).oldest : undefined;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// computeQuota
// ---------------------------------------------------------------------------

/** Compute the next 5-hour boundary in epoch ms. */
function next5hBoundary(nowMs: number): number {
  return Math.ceil(nowMs / FIVE_HOUR_MS) * FIVE_HOUR_MS;
}

/** Compute the next weekly boundary in epoch ms. */
function nextWeeklyBoundary(nowMs: number): number {
  return Math.ceil(nowMs / SEVEN_DAY_MS) * SEVEN_DAY_MS;
}

/**
 * Compute the full quota view for the status bar and analytics dashboard.
 *
 * All parameters are optional; in production call `computeQuota()`.  Pass
 * test-only fields (claudeConfig, settingsOverrides, queryDb) to control
 * dependencies in unit tests.
 */
export function computeQuota(opts?: {
  now?: Date;
  claudeConfig?: unknown;
  settingsOverrides?: { fiveHour?: number; weekly?: number };
  /** Test-only: inject a mock dbGet. */
  queryDb?: (sql: string, params: unknown[]) => Record<string, unknown> | undefined;
}): QuotaView {
  const now = opts?.now ?? new Date();
  const nowMs = now.getTime();

  const tier = readPlanTier(opts?.claudeConfig);
  const budget = getBudget(tier, opts?.settingsOverrides);

  const buildWindow = (used: number, windowBudget: number, windowMs: number): QuotaWindow => {
    const pct = windowBudget > 0 ? Math.round((used / windowBudget) * 100) : 0;
    const remainingPct = Math.max(0, Math.min(100, 100 - pct));

    // Rolling reset: the window frees up when the oldest message in it ages
    // out (oldest + windowMs). Falls back to an aligned boundary when no
    // usage timestamp is available.
    const oldest = computeOldestInWindow(now, windowMs, opts?.queryDb);
    const resetsIn = oldest !== null
      ? Math.max(0, oldest + windowMs - nowMs)
      : (windowMs === FIVE_HOUR_MS ? next5hBoundary(nowMs) : nextWeeklyBoundary(nowMs)) - nowMs;

    return {
      used,
      budget: windowBudget,
      pct,
      remainingPct,
      remaining: Math.max(0, windowBudget - used),
      resetsIn,
    };
  };

  const fiveHourUsed = computeUsage(now, FIVE_HOUR_MS, opts?.queryDb);
  const weeklyUsed = computeUsage(now, SEVEN_DAY_MS, opts?.queryDb);

  return {
    tier,
    tierLabel: tierLabel(tier),
    source: "estimate",
    fiveHour: buildWindow(fiveHourUsed, budget.fiveHour, FIVE_HOUR_MS),
    weekly: buildWindow(weeklyUsed, budget.weekly, SEVEN_DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// Live usage — real server-side utilization (matches the official Claude Code
// extension's "Account & Usage" panel exactly).
//
// The official extension calls GET https://api.anthropic.com/api/oauth/usage
// with the Claude AI OAuth bearer token and reads `utilization` (% used) and
// `resets_at` per window. We replicate that here, and fall back to the local
// token-budget estimate when unauthenticated or offline.
// ---------------------------------------------------------------------------

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

interface RawUsageWindow {
  utilization: number | null;
  resets_at?: string | null;
}
interface RawUsageResponse {
  five_hour?: RawUsageWindow;
  seven_day?: RawUsageWindow;
  seven_day_sonnet?: RawUsageWindow;
}

/**
 * Read the Claude AI OAuth access token from the same secure store the CLI and
 * official extension use. macOS: the "Claude Code-credentials" keychain item;
 * other platforms: `~/.claude/.credentials.json`. Returns null on any failure.
 */
export function readOAuthAccessToken(): string | null {
  const parse = (raw: string): string | null => {
    try {
      const json = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      return json.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  };
  try {
    if (process.platform === "darwin") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require("node:child_process");
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 4000 },
      );
      return parse(out);
    }
  } catch {
    /* fall through to file-based store */
  }
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    return parse(raw);
  } catch {
    return null;
  }
}

/**
 * Fetch the live usage payload. Returns null when there is no token, the
 * request fails, or it times out — callers should fall back to the estimate.
 */
export async function fetchLiveUsage(
  token?: string | null,
): Promise<RawUsageResponse | null> {
  const accessToken = token ?? readOAuthAccessToken();
  if (!accessToken) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as RawUsageResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live-usage cache
//
// The /api/oauth/usage endpoint is strictly rate-limited *per account* and is
// shared across every Claude client on the machine (the official extension, the
// CLI status line, other viewers). Whichever client fetches first wins; the
// rest get HTTP 429. Without a cache, a 429 makes us fall straight back to the
// (inaccurate) local token estimate — so the panel flips between the real value
// and a wrong guess. We persist the last successful live reading and keep
// serving it (clearly labelled "cached") until the window resets, matching what
// the official extension and other viewers do.
// ---------------------------------------------------------------------------

interface LiveUsageCache {
  capturedAtMs: number;
  five_hour: RawUsageWindow;
  seven_day: RawUsageWindow;
}

/** Default on-disk location for the cached live-usage snapshot. */
function defaultCachePath(): string {
  return join(homedir(), ".claude", ".cc-history-usage-cache.json");
}

/** Read the cached live-usage snapshot. Returns null when missing/unparsable. */
export function readLiveUsageCache(path?: string): LiveUsageCache | null {
  try {
    const raw = readFileSync(path ?? defaultCachePath(), "utf8");
    const j = JSON.parse(raw) as Partial<LiveUsageCache>;
    if (typeof j.capturedAtMs === "number" && j.five_hour && j.seven_day) {
      return j as LiveUsageCache;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a successful live-usage snapshot. Best-effort; failures are ignored. */
export function writeLiveUsageCache(cache: LiveUsageCache, path?: string): void {
  try {
    writeFileSync(path ?? defaultCachePath(), JSON.stringify(cache), "utf8");
  } catch {
    /* ignore — caching is a nicety, not a requirement */
  }
}

/**
 * A cached snapshot is only meaningful while its windows have not reset: once a
 * window's `resets_at` passes, the stored utilization no longer reflects
 * reality. We also impose a hard ceiling so a very old snapshot never lingers.
 */
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

// Within this window of a successful capture, serve the cache without a network
// call. This value, not any timer, is what decides how often we actually hit
// the endpoint: the status bar refreshes on every file-watcher event and on
// most user commands, so anything shorter turns into a poll at that rate.
//
// The endpoint enforces its rate budget per account and shares it with every
// other Claude client signed in as the same user, so a short interval starves
// those clients out. 300s is the floor we allow; users running other usage
// tools can raise it further.
export const MIN_USAGE_POLL_SECONDS = 300;
export const DEFAULT_USAGE_POLL_SECONDS = 300;
const CACHE_SOFT_TTL_MS = DEFAULT_USAGE_POLL_SECONDS * 1000;

/**
 * Turn the configured `claudeHistory.quota.claudeUsagePollSeconds` value into a
 * usable interval. Returns null when the user disabled live polling, and a
 * millisecond value clamped to `MIN_USAGE_POLL_SECONDS` otherwise. Anything
 * that is not a finite number falls back to the default.
 */
export function resolveUsagePollMs(configured: unknown): number | null {
  const seconds =
    typeof configured === "number" && Number.isFinite(configured)
      ? configured
      : DEFAULT_USAGE_POLL_SECONDS;
  if (seconds <= 0) return null;
  return Math.max(seconds, MIN_USAGE_POLL_SECONDS) * 1000;
}

function cacheIsUsable(now: Date, cache: LiveUsageCache): boolean {
  if (now.getTime() - cache.capturedAtMs > CACHE_MAX_AGE_MS) return false;
  const fhReset = cache.five_hour?.resets_at ? Date.parse(cache.five_hour.resets_at) : NaN;
  const wkReset = cache.seven_day?.resets_at ? Date.parse(cache.seven_day.resets_at) : NaN;
  // If a reset timestamp is present and already in the past, the snapshot is stale.
  if (!Number.isNaN(fhReset) && fhReset <= now.getTime()) return false;
  if (!Number.isNaN(wkReset) && wkReset <= now.getTime()) return false;
  return true;
}

/** Build a QuotaWindow from a raw server window (utilization % + resets_at). */
function liveWindow(now: Date, raw: RawUsageWindow | undefined): QuotaWindow | null {
  if (!raw || raw.utilization === null || raw.utilization === undefined) return null;
  const pct = Math.round(raw.utilization);
  const resetsAt = raw.resets_at ? Date.parse(raw.resets_at) : NaN;
  const resetsIn = Number.isNaN(resetsAt) ? 0 : Math.max(0, resetsAt - now.getTime());
  return {
    used: 0,
    budget: 0,
    pct,
    remainingPct: Math.max(0, Math.min(100, 100 - pct)),
    remaining: 0,
    resetsIn,
  };
}

/**
 * Resolve the quota view, preferring real server utilization and falling back
 * to the local token-budget estimate. This is the function callers should use.
 */
export async function resolveQuota(opts?: {
  now?: Date;
  claudeConfig?: unknown;
  settingsOverrides?: { fiveHour?: number; weekly?: number };
  queryDb?: (sql: string, params: unknown[]) => Record<string, unknown> | undefined;
  /** Test-only: inject a usage payload instead of calling the network. */
  liveUsage?: RawUsageResponse | null;
  /** Test-only: inject the on-disk cache instead of reading the file. */
  liveCache?: LiveUsageCache | null;
  /** Override the cache file location (defaults to ~/.claude). */
  cachePath?: string;
  /** Skip the short-TTL cache fast-path and force a fresh network fetch. */
  force?: boolean;
  /**
   * How long a captured snapshot is served without a network call, in
   * milliseconds. Defaults to `CACHE_SOFT_TTL_MS`. Callers pass the user's
   * configured poll interval here; see `resolveUsagePollMs`.
   */
  softTtlMs?: number;
  /**
   * Whether a network call to the usage endpoint is allowed at all. Pass false
   * when nothing on screen shows the Claude quota, or when the user turned
   * live polling off: the call then resolves from the cache and finally from
   * the local estimate, exactly as a failed fetch does.
   */
  allowLive?: boolean;
}): Promise<QuotaView> {
  const now = opts?.now ?? new Date();
  const estimate = computeQuota(opts);

  // Read the on-disk cache once; reused for both the fast-path and the
  // post-fetch fallback.
  const cache = opts?.liveCache !== undefined ? opts.liveCache : readLiveUsageCache(opts?.cachePath);

  const buildLive = (
    raw: { five_hour?: RawUsageWindow; seven_day?: RawUsageWindow },
    cachedAtMs?: number,
  ): QuotaView | null => {
    const fiveHour = liveWindow(now, raw.five_hour);
    const weekly = liveWindow(now, raw.seven_day);
    if (!fiveHour || !weekly) return null;
    // Keep the local token figures as supplementary context, but drive the
    // headline %, bar, and reset timer from the authoritative server values.
    return {
      tier: estimate.tier,
      tierLabel: estimate.tierLabel,
      source: "live",
      cachedAtMs,
      fiveHour: { ...fiveHour, used: estimate.fiveHour.used },
      weekly: { ...weekly, used: estimate.weekly.used },
    };
  };

  // 0. Fast path: a very fresh cache is served without touching the network,
  //    which throttles repeated calls (status-bar poll + panel opens) and keeps
  //    us from piling onto the shared per-account rate limit. The explicit
  //    refresh button passes `force` to bypass this.
  if (
    !opts?.force &&
    opts?.liveUsage === undefined &&
    cache &&
    cacheIsUsable(now, cache) &&
    now.getTime() - cache.capturedAtMs < (opts?.softTtlMs ?? CACHE_SOFT_TTL_MS)
  ) {
    const fast = buildLive(cache, cache.capturedAtMs);
    if (fast) return fast;
  }

  // 1. Try a fresh fetch. On success, persist it and serve it. A caller that
  //    displays nothing live passes allowLive:false and skips straight to the
  //    cache and the estimate below, so a hidden panel never spends a request
  //    from the shared per-account rate budget.
  const allowLive = opts?.allowLive ?? true;
  const raw =
    opts?.liveUsage !== undefined ? opts.liveUsage : allowLive ? await fetchLiveUsage() : null;
  if (raw) {
    const fresh = buildLive(raw);
    if (fresh) {
      if (raw.five_hour && raw.seven_day) {
        writeLiveUsageCache(
          { capturedAtMs: now.getTime(), five_hour: raw.five_hour, seven_day: raw.seven_day },
          opts?.cachePath,
        );
      }
      return fresh;
    }
  }

  // 2. Fetch failed (rate-limited/offline). Serve the last good cached reading
  //    while its windows are still valid.
  if (cache && cacheIsUsable(now, cache)) {
    const cached = buildLive(cache, cache.capturedAtMs);
    if (cached) return cached;
  }

  // 3. Nothing live available — fall back to the local token-budget estimate.
  return estimate;
}
