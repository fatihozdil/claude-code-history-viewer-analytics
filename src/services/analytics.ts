import { dbAll, dbGet } from "../storage/db.js";
import { computeQuota } from "./quota.js";
import { MESSAGE_COST_SQL } from "./pricing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailyRow {
  date: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

export interface ProjectRow {
  name: string;
  sessions: number;
  tokens: number;
  cost: number;
}

export interface TopFileRow {
  path: string;
  sessions: number;
  changes: number;
}
export interface ProviderRow { provider: string; sessions: number; tokens: number; cost: number }
export interface ModelRow { model: string; sessions: number; tokens: number; cost: number }

/** Live limits are optional; history totals are available for every provider. */
export interface ProviderUsageSnapshot {
  codex?: {
    primaryRemainingPct: number;
    primaryWindowMinutes?: number;
    primaryResetsAt?: number;
    secondaryRemainingPct?: number;
    secondaryWindowMinutes?: number;
    secondaryResetsAt?: number;
  };
  agy?: {
    remainingPct: number;
    resetsAt?: string;
    limits?: Array<{ label: string; remainingPct: number; resetsAt?: string }>;
    groups?: Array<{
      name: string;
      models?: string;
      buckets: Array<{ label: string; window?: string; remainingPct: number; resetsAt?: string }>;
    }>;
    source?: "live" | "cache" | "file";
    capturedAt?: string;
  };
}

export interface AnalyticsData {
  provider?: string;
  totals: {
    sessions: number;
    messages: number;
    totalTokens: number;
    totalCost: number;
    activeDays: number;
  };
  today: {
    tokens: number;
    cost: number;
    sessions: number;
  };
  daily: DailyRow[];
  byProject: ProjectRow[];
  byProvider: ProviderRow[];
  byModel: ModelRow[];
  providerUsage?: ProviderUsageSnapshot;
  topFiles: TopFileRow[];
  quota: ReturnType<typeof computeQuota>;
  sessionsByHour: number[];
  sessionsByWeekday: number[];
  avgMessagesPerSession: number;
  avgTokensPerMessage: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely convert a DB value to a number. */
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// deepseekUsageSummary
// ---------------------------------------------------------------------------

/**
 * Lightweight, single-aggregate equivalent of buildAnalytics's `byProvider`
 * "deepseek" row — used by the status bar so it doesn't have to pay for a
 * full buildAnalytics() run just to show DeepSeek token/cost totals.
 *
 * A session is classified "deepseek" in buildAnalytics only when it is a
 * `claude`-provider session containing at least one message whose model
 * matches `%deepseek%`, and only messages matching that same model pattern
 * are summed into its tokens/cost. Because the model match itself implies
 * the EXISTS check, this reduces to a single filtered SUM with no need to
 * classify sessions first.
 */
export function deepseekUsageSummary(): { tokens: number; cost: number } {
  const row =
    dbGet(`
      SELECT
        COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)), 0) AS tokens,
        COALESCE(SUM(${MESSAGE_COST_SQL}), 0) AS cost
      FROM messages m
      JOIN sessions s ON s.session_id = m.session_id
      WHERE s.provider = 'claude' AND LOWER(COALESCE(m.model, '')) LIKE '%deepseek%'
    `) ?? {};
  return { tokens: toNum(row.tokens), cost: toNum(row.cost) };
}

// ---------------------------------------------------------------------------
// buildAnalytics
// ---------------------------------------------------------------------------

/**
 * Run all analytics aggregation queries against the local sql.js DB.
 *
 * All queries are synchronous — no async, no streaming, just the DB handle.
 */
export function buildAnalytics(
  quota?: ReturnType<typeof computeQuota>,
  provider?: string,
  providerUsage?: ProviderUsageSnapshot,
): AnalyticsData {
  const selectedProvider = provider && /^[a-z0-9_-]+$/i.test(provider) ? provider : undefined;
  const isDeepSeekModel = (alias: string) => `LOWER(COALESCE(${alias}.model, '')) LIKE '%deepseek%'`;
  const sessionFilter = (alias: string) => {
    if (!selectedProvider) return "";
    if (selectedProvider === "deepseek") {
      return ` AND ${alias}.provider = 'claude' AND EXISTS (
        SELECT 1 FROM messages provider_model
        WHERE provider_model.session_id = ${alias}.session_id
          AND LOWER(COALESCE(provider_model.model, '')) LIKE '%deepseek%'
      )`;
    }
    if (selectedProvider === "claude") {
      return ` AND ${alias}.provider = 'claude' AND NOT EXISTS (
        SELECT 1 FROM messages provider_model
        WHERE provider_model.session_id = ${alias}.session_id
          AND LOWER(COALESCE(provider_model.model, '')) LIKE '%deepseek%'
      )`;
    }
    return ` AND ${alias}.provider = '${selectedProvider}'`;
  };
  // A session can contain messages from more than one routed model. Scope
  // token and cost aggregates at the message level so DeepSeek never absorbs
  // the full cost of a Claude session just because it appeared once.
  const messageFilter = (alias: string) => {
    if (selectedProvider === "deepseek") return ` AND ${isDeepSeekModel(alias)}`;
    if (selectedProvider === "claude") return ` AND NOT ${isDeepSeekModel(alias)}`;
    return "";
  };
  // -- Totals --
  const totalsRow =
    dbGet(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE 1=1${sessionFilter("sessions")}) AS sessions,
        (SELECT COUNT(*) FROM messages m JOIN sessions s ON s.session_id = m.session_id WHERE 1=1${sessionFilter("s")}${messageFilter("m")}) AS messages,
        (SELECT COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)), 0)
           FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE 1=1${sessionFilter("s")}${messageFilter("m")}
        ) AS totalTokens,
        (SELECT COALESCE(SUM(${MESSAGE_COST_SQL}), 0)
           FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE 1=1${sessionFilter("s")}${messageFilter("m")}
        ) AS totalCost,
        (SELECT COUNT(*) FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE 1=1${sessionFilter("s")}${messageFilter("m")}
            AND (m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL
              OR m.cache_creation_tokens IS NOT NULL OR m.cache_read_tokens IS NOT NULL)) AS tokenizedMessages,
        (SELECT COUNT(DISTINCT date(m.ts)) FROM messages m JOIN sessions s ON s.session_id = m.session_id WHERE m.ts IS NOT NULL${sessionFilter("s")}${messageFilter("m")}) AS activeDays
    `) ?? {};

  const totals = {
    sessions: toNum(totalsRow.sessions),
    messages: toNum(totalsRow.messages),
    totalTokens: toNum(totalsRow.totalTokens),
    totalCost: toNum(totalsRow.totalCost),
    activeDays: toNum(totalsRow.activeDays),
  };

  // -- Today --
  const todayRow =
    dbGet(`
      SELECT
        (SELECT COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)), 0)
           FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE date(m.ts) = date('now')${sessionFilter("s")}${messageFilter("m")}) AS tokens,
        (SELECT COALESCE(SUM(${MESSAGE_COST_SQL}), 0)
           FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE date(m.ts) = date('now')${sessionFilter("s")}${messageFilter("m")}) AS cost,
        (SELECT COUNT(*) FROM sessions WHERE date(created_at) = date('now')${sessionFilter("sessions")}) AS sessions
    `) ?? {};

  const today = {
    tokens: toNum(todayRow.tokens),
    cost: toNum(todayRow.cost),
    sessions: toNum(todayRow.sessions),
  };

  // -- Daily breakdown (left-join so days match on date string) --
  const dailyRows = dbAll(`
    SELECT
      date(m.ts) AS date,
      COUNT(DISTINCT m.session_id) AS sessions,
      COUNT(*) AS messages,
      COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)), 0) AS tokens,
      COALESCE(SUM(${MESSAGE_COST_SQL}), 0) AS cost
    FROM messages m
    JOIN sessions s ON s.session_id = m.session_id
    WHERE m.ts IS NOT NULL${sessionFilter("s")}${messageFilter("m")}
    GROUP BY date(m.ts)
    ORDER BY date DESC
  `);

  const daily: DailyRow[] = dailyRows.map((r) => ({
    date: String(r.date ?? ""),
    sessions: toNum(r.sessions),
    messages: toNum(r.messages),
    tokens: toNum(r.tokens),
    cost: toNum(r.cost),
  }));

  // -- By project (top 10) --
  const projectRows = dbAll(`
    SELECT
      COALESCE(s.project_name, '') AS name,
      COUNT(DISTINCT s.session_id) AS sessions,
      COALESCE(SUM(m.tokens), 0) AS tokens,
      COALESCE(SUM(m.cost), 0) AS cost
    FROM sessions s
    LEFT JOIN (
      SELECT
        m.session_id,
        SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)) AS tokens,
        SUM(${MESSAGE_COST_SQL}) AS cost
      FROM messages m
      JOIN sessions sf ON sf.session_id = m.session_id
      WHERE 1=1${sessionFilter("sf")}${messageFilter("m")}
      GROUP BY m.session_id
    ) m ON s.session_id = m.session_id
    WHERE 1=1${sessionFilter("s")}
    GROUP BY s.project_name
    ORDER BY sessions DESC
    LIMIT 10
  `);

  const byProject: ProjectRow[] = projectRows.map((r) => ({
    name: String(r.name ?? ""),
    sessions: toNum(r.sessions),
    tokens: toNum(r.tokens),
    cost: toNum(r.cost),
  }));

  const providerRows = dbAll(`
    SELECT
      CASE
        WHEN s.provider = 'claude' AND EXISTS (
          SELECT 1 FROM messages dm
          WHERE dm.session_id = s.session_id
            AND LOWER(COALESCE(dm.model, '')) LIKE '%deepseek%'
        ) THEN 'deepseek'
        ELSE s.provider
      END AS provider,
      COUNT(DISTINCT s.session_id) AS sessions,
      COALESCE(SUM(CASE WHEN s.provider = 'claude' AND EXISTS (
        SELECT 1 FROM messages dm WHERE dm.session_id = s.session_id AND ${isDeepSeekModel("dm")}
      ) THEN CASE WHEN ${isDeepSeekModel("m")} THEN COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0) ELSE 0 END
      ELSE COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0) END), 0) AS tokens,
      COALESCE(SUM(CASE WHEN s.provider = 'claude' AND EXISTS (
        SELECT 1 FROM messages dm WHERE dm.session_id = s.session_id AND ${isDeepSeekModel("dm")}
      ) THEN CASE WHEN ${isDeepSeekModel("m")} THEN ${MESSAGE_COST_SQL} ELSE 0 END
      ELSE ${MESSAGE_COST_SQL} END), 0) AS cost
    FROM sessions s LEFT JOIN messages m ON m.session_id = s.session_id
    GROUP BY CASE
      WHEN s.provider = 'claude' AND EXISTS (
        SELECT 1 FROM messages dm
        WHERE dm.session_id = s.session_id
          AND LOWER(COALESCE(dm.model, '')) LIKE '%deepseek%'
      ) THEN 'deepseek'
      ELSE s.provider
    END
    ORDER BY cost DESC
  `);
  const byProvider: ProviderRow[] = providerRows.map((r) => ({ provider: String(r.provider ?? "unknown"), sessions: toNum(r.sessions), tokens: toNum(r.tokens), cost: toNum(r.cost) }));

  const modelRows = dbAll(`
    SELECT COALESCE(NULLIF(m.model, ''), '(unspecified)') AS model, COUNT(DISTINCT m.session_id) AS sessions,
      COALESCE(SUM(COALESCE(m.input_tokens,0) + COALESCE(m.output_tokens,0) + COALESCE(m.cache_creation_tokens,0) + COALESCE(m.cache_read_tokens,0)), 0) AS tokens,
      COALESCE(SUM(${MESSAGE_COST_SQL}), 0) AS cost
    FROM messages m JOIN sessions s ON s.session_id = m.session_id
    WHERE 1=1${sessionFilter("s")}${messageFilter("m")}
    GROUP BY COALESCE(NULLIF(m.model, ''), '(unspecified)') ORDER BY cost DESC LIMIT 50
  `);
  const byModel: ModelRow[] = modelRows.map((r) => ({ model: String(r.model ?? "(unspecified)"), sessions: toNum(r.sessions), tokens: toNum(r.tokens), cost: toNum(r.cost) }));

  // -- Top modified files (top 10) --
  const fileRows = dbAll(`
    SELECT
      f.file_path AS path,
      COUNT(DISTINCT f.session_id) AS sessions,
      COUNT(*) AS changes
    FROM file_changes f JOIN sessions s ON s.session_id = f.session_id
    WHERE 1=1${sessionFilter("s")}
    GROUP BY f.file_path
    ORDER BY changes DESC
    LIMIT 10
  `);

  const topFiles: TopFileRow[] = fileRows.map((r) => ({
    path: String(r.path ?? ""),
    sessions: toNum(r.sessions),
    changes: toNum(r.changes),
  }));

  // -- Sessions by hour of day (0-23) --
  const hourRows = dbAll(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS n
    FROM sessions s
    WHERE s.created_at IS NOT NULL AND s.created_at != ''${sessionFilter("s")}
    GROUP BY hour
  `);
  const sessionsByHour = new Array(24).fill(0);
  for (const r of hourRows) {
    const h = toNum(r.hour);
    if (h >= 0 && h < 24) sessionsByHour[h] = toNum(r.n);
  }

  // -- Sessions by weekday (0=Sunday .. 6=Saturday) --
  const weekdayRows = dbAll(`
    SELECT CAST(strftime('%w', created_at) AS INTEGER) AS weekday, COUNT(*) AS n
    FROM sessions s
    WHERE s.created_at IS NOT NULL AND s.created_at != ''${sessionFilter("s")}
    GROUP BY weekday
  `);
  const sessionsByWeekday = new Array(7).fill(0);
  for (const r of weekdayRows) {
    const w = toNum(r.weekday);
    if (w >= 0 && w < 7) sessionsByWeekday[w] = toNum(r.n);
  }

  const avgMessagesPerSession = totals.sessions > 0 ? totals.messages / totals.sessions : 0;
  const tokenizedMessages = toNum(totalsRow.tokenizedMessages);
  const avgTokensPerMessage = tokenizedMessages > 0 ? totals.totalTokens / tokenizedMessages : 0;

  // -- Quota -- (live data injected by the panel when available)
  const quotaView = quota ?? computeQuota();

  return {
    provider: selectedProvider,
    totals,
    today,
    daily,
    byProject,
    byProvider,
    byModel,
    providerUsage,
    topFiles,
    quota: quotaView,
    sessionsByHour,
    sessionsByWeekday,
    avgMessagesPerSession,
    avgTokensPerMessage,
  };
}
