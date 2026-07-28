import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPlanTier,
  getBudget,
  computeUsage,
  computeQuota,
  resolveQuota,
  readLiveUsageCache,
  writeLiveUsageCache,
} from "../src/services/quota.js";

/** A throwaway cache path so tests never touch the real ~/.claude file. */
function tmpCachePath(): string {
  return join(tmpdir(), `cc-usage-cache-test-${Math.random().toString(36).slice(2)}.json`);
}

// ---------------------------------------------------------------------------
// readPlanTier
// ---------------------------------------------------------------------------

test("readPlanTier returns claude_pro from config object", () => {
  const cfg = { oauthAccount: { organizationType: "claude_pro" } };
  assert.equal(readPlanTier(cfg), "claude_pro");
});

test("readPlanTier uses organizationRateLimitTier over orgType", () => {
  // rateLimitTier takes precedence when present
  const cfg = {
    oauthAccount: { organizationType: "claude_pro" },
    organizationRateLimitTier: "max_5x",
  };
  assert.equal(readPlanTier(cfg), "max_5x");
});

test("readPlanTier ignores unknown organizationRateLimitTier value, falls back to orgType", () => {
  const cfg = {
    oauthAccount: { organizationType: "max" },
    organizationRateLimitTier: "some_unknown_tier",
  };
  assert.equal(readPlanTier(cfg), "max");
});

test("readPlanTier returns free for config without tier info", () => {
  assert.equal(readPlanTier({}), "free");
});

test("readPlanTier returns free when oauthAccount exists but has no orgType", () => {
  const cfg = { oauthAccount: {} };
  assert.equal(readPlanTier(cfg), "free");
});

test("readPlanTier returns free for null config", () => {
  assert.equal(readPlanTier(null), "free");
});

// readPlanTier() without arguments reads ~/.claude.json from disk and is NOT
// tested here — result depends on the developer's actual plan tier.

// ---------------------------------------------------------------------------
// getBudget
// ---------------------------------------------------------------------------

test("getBudget returns free-tier budget by default", () => {
  const b = getBudget("free");
  assert.equal(b.fiveHour, 460000);
  assert.equal(b.weekly, 26000000);
});

test("getBudget returns pro budget for claude_pro tier", () => {
  const b = getBudget("claude_pro");
  assert.equal(b.fiveHour, 2300000);
  assert.equal(b.weekly, 130000000);
});

test("getBudget returns max budget", () => {
  const b = getBudget("max");
  assert.equal(b.fiveHour, 4600000);
  assert.equal(b.weekly, 260000000);
});

test("getBudget returns max_5x budget", () => {
  const b = getBudget("max_5x");
  assert.equal(b.fiveHour, 11500000);
  assert.equal(b.weekly, 650000000);
});

test("getBudget returns max_20x budget", () => {
  const b = getBudget("max_20x");
  assert.equal(b.fiveHour, 46000000);
  assert.equal(b.weekly, 2600000000);
});

test("getBudget returns free budget for unknown tier", () => {
  const b = getBudget("nonexistent_tier");
  assert.equal(b.fiveHour, 460000);
  assert.equal(b.weekly, 26000000);
});

test("getBudget applies configOverrides when provided", () => {
  const b = getBudget("free", { fiveHour: 999999, weekly: 888888 });
  assert.equal(b.fiveHour, 999999);
  assert.equal(b.weekly, 888888);
});

test("getBudget ignores zero overrides", () => {
  const b = getBudget("max", { fiveHour: 0, weekly: 0 });
  assert.equal(b.fiveHour, 4600000); // tier default, not 0
  assert.equal(b.weekly, 260000000);
});

test("getBudget ignores undefined overrides", () => {
  const b = getBudget("max", { fiveHour: undefined, weekly: undefined });
  assert.equal(b.fiveHour, 4600000);
  assert.equal(b.weekly, 260000000);
});

test("getBudget partially overrides only one window", () => {
  const b = getBudget("free", { fiveHour: 12345 });
  assert.equal(b.fiveHour, 12345);
  assert.equal(b.weekly, 26000000); // unchanged
});

// ---------------------------------------------------------------------------
// computeUsage
// ---------------------------------------------------------------------------

test("computeUsage returns 0 when queryDb returns undefined", () => {
  const mockDb = (_sql: string, _params: unknown[]) => undefined;
  const result = computeUsage(new Date("2026-06-18T12:00:00Z"), 60_000, mockDb);
  assert.equal(result, 0);
});

test("computeUsage returns the sum from the query result", () => {
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 12345 });
  const result = computeUsage(new Date("2026-06-18T12:00:00Z"), 60_000, mockDb);
  assert.equal(result, 12345);
});

test("computeUsage returns 0 when total is null", () => {
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: null });
  const result = computeUsage(new Date("2026-06-18T12:00:00Z"), 60_000, mockDb);
  assert.equal(result, 0);
});

test("computeUsage passes the cutoff to the query as ISO string", () => {
  let capturedCutoff: unknown = null;
  const mockDb = (sql: string, params: unknown[]) => {
    capturedCutoff = params[0];
    return { total: 0 };
  };
  const now = new Date("2026-06-18T12:00:00.000Z");
  computeUsage(now, 5 * 60 * 60 * 1000, mockDb);
  // Verify it's an ISO string and in the past relative to now
  assert.equal(typeof capturedCutoff, "string");
  assert.ok((capturedCutoff as string).endsWith("Z"));
  assert.ok((capturedCutoff as string) < "2026-06-18T12:00:00.000Z");
});

test("computeUsage isolates Claude quota from Codex messages", () => {
  let capturedSql = "";
  computeUsage(new Date("2026-06-18T12:00:00Z"), 60_000, (sql) => {
    capturedSql = sql;
    return { total: 0 };
  });
  assert.match(capturedSql, /JOIN sessions/);
  assert.match(capturedSql, /provider = 'claude'/);
});

// ---------------------------------------------------------------------------
// computeQuota
// ---------------------------------------------------------------------------

test("computeQuota returns full quota view with mocked dependencies", () => {
  // Use a time that does NOT fall on a 5h or weekly boundary
  const now = new Date("2026-06-18T12:00:01.000Z");

  // Mock dbGet so computeUsage returns 45000 for every window
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 45000 });

  // Pro tier → budget: 400k / 800k
  const result = computeQuota({
    now,
    claudeConfig: { oauthAccount: { organizationType: "claude_pro" } },
    queryDb: mockDb,
  });

  assert.equal(result.tier, "claude_pro");

  // 5h: used=45000, budget=2300000, pct=Math.round(1.956)=2, remaining=2255000
  assert.equal(result.fiveHour.used, 45000);
  assert.equal(result.fiveHour.budget, 2300000);
  assert.equal(result.fiveHour.pct, 2);
  assert.equal(result.fiveHour.remaining, 2255000);

  // 7d: used=45000, budget=130000000, pct=Math.round(0.0346)=0, remaining=129955000
  assert.equal(result.weekly.used, 45000);
  assert.equal(result.weekly.budget, 130000000);
  assert.equal(result.weekly.pct, 0);
  assert.equal(result.weekly.remaining, 129955000);

  // resetsIn should be positive when not at a boundary
  assert.ok(result.fiveHour.resetsIn > 0);
  assert.ok(result.weekly.resetsIn > 0);
});

test("computeQuota returns 0% for zero usage", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 0 });

  const result = computeQuota({
    now,
    claudeConfig: { oauthAccount: { organizationType: "free" } },
    queryDb: mockDb,
  });

  assert.equal(result.fiveHour.pct, 0);
  assert.equal(result.weekly.pct, 0);
  assert.equal(result.fiveHour.remaining, 460000);
  assert.equal(result.weekly.remaining, 26000000);
});

test("computeQuota returns 100% when usage equals budget", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 460000 });

  const result = computeQuota({
    now,
    claudeConfig: { oauthAccount: { organizationType: "free" } },
    queryDb: mockDb,
  });

  assert.equal(result.fiveHour.pct, 100);
  assert.equal(result.fiveHour.remaining, 0);
});

test("computeQuota caps remaining at 0 when over budget", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 27000000 });

  const result = computeQuota({
    now,
    claudeConfig: { oauthAccount: { organizationType: "free" } },
    queryDb: mockDb,
  });

  assert.equal(result.fiveHour.remaining, 0);
  assert.equal(result.weekly.remaining, 0);
});

test("computeQuota applies settingsOverrides", () => {
  const now = new Date("2026-06-18T12:00:00.000Z");
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 5000 });

  const result = computeQuota({
    now,
    claudeConfig: { oauthAccount: { organizationType: "free" } },
    settingsOverrides: { fiveHour: 10000, weekly: 20000 },
    queryDb: mockDb,
  });

  assert.equal(result.fiveHour.budget, 10000);
  assert.equal(result.fiveHour.used, 5000);
  assert.equal(result.fiveHour.pct, 50); // 5000/10000 * 100

  assert.equal(result.weekly.budget, 20000);
  assert.equal(result.weekly.pct, 25); // 5000/20000 * 100
});

test("computeQuota resetsIn values are correct", () => {
  // 1 ms after a 5h boundary.  Next boundary is 5h - 1ms ahead.
  const afterBoundary = new Date(18000001);
  const mockDb = (_sql: string, _params: unknown[]) => ({ total: 0 });

  const result = computeQuota({
    now: afterBoundary,
    claudeConfig: {},
    queryDb: mockDb,
  });

  // next 5h boundary = ceil(18000001/18000000)*18000000 = 36000000
  // resetsIn = 36000000 - 18000001 = 17999999 = 18000000 - 1
  assert.equal(result.fiveHour.resetsIn, 17999999);

  // next weekly boundary = ceil(18000001/604800000)*604800000 = 604800000
  // resetsIn = 604800000 - 18000001 = 586799999
  assert.equal(result.weekly.resetsIn, 604800000 - 18000001);
});

// ---------------------------------------------------------------------------
// resolveQuota — live server utilization (injected, no network)
// ---------------------------------------------------------------------------

test("resolveQuota uses live server utilization when available", async () => {
  const now = new Date("2026-06-19T14:32:00.000Z");
  const cachePath = tmpCachePath();
  const result = await resolveQuota({
    now,
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    cachePath,
    liveUsage: {
      five_hour: { utilization: 33, resets_at: new Date(now.getTime() + 3 * 3600_000).toISOString() },
      seven_day: { utilization: 22, resets_at: new Date(now.getTime() + 5 * 86400_000).toISOString() },
    },
  });

  assert.equal(result.source, "live");
  assert.equal(result.cachedAtMs, undefined); // a fresh fetch is not "cached"
  // utilization 33% used → 67% remaining (matches official extension)
  assert.equal(result.fiveHour.pct, 33);
  assert.equal(result.fiveHour.remainingPct, 67);
  assert.equal(result.weekly.pct, 22);
  assert.equal(result.weekly.remainingPct, 78);
  // reset timers come from resets_at
  assert.ok(result.fiveHour.resetsIn > 0 && result.fiveHour.resetsIn <= 3 * 3600_000);

  // A successful fetch persists the snapshot to disk.
  const persisted = readLiveUsageCache(cachePath);
  assert.ok(persisted);
  assert.equal(persisted!.five_hour.utilization, 33);
  rmSync(cachePath, { force: true });
});

test("resolveQuota falls back to estimate when no live data", async () => {
  const result = await resolveQuota({
    now: new Date("2026-06-19T14:32:00.000Z"),
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    liveUsage: null,
    liveCache: null, // no cached fallback available
  });

  assert.equal(result.source, "estimate");
  assert.equal(result.fiveHour.budget, 2300000); // local budget present in estimate mode
});

test("resolveQuota falls back to estimate when a window utilization is null", async () => {
  const result = await resolveQuota({
    now: new Date("2026-06-19T14:32:00.000Z"),
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    liveUsage: {
      five_hour: { utilization: null },
      seven_day: { utilization: 22 },
    },
    liveCache: null,
  });

  assert.equal(result.source, "estimate");
});

// ---------------------------------------------------------------------------
// resolveQuota — live-usage cache fallback (the 429 case)
// ---------------------------------------------------------------------------

test("resolveQuota serves cached live data when a fresh fetch fails (429)", async () => {
  const now = new Date("2026-06-19T14:32:00.000Z");
  const result = await resolveQuota({
    now,
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    liveUsage: null, // simulate a rate-limited / failed fetch
    liveCache: {
      capturedAtMs: now.getTime() - 5 * 60_000, // captured 5 min ago
      five_hour: { utilization: 74, resets_at: new Date(now.getTime() + 40 * 60_000).toISOString() },
      seven_day: { utilization: 25, resets_at: new Date(now.getTime() + 4 * 86400_000).toISOString() },
    },
  });

  assert.equal(result.source, "live");
  assert.equal(result.cachedAtMs, now.getTime() - 5 * 60_000);
  assert.equal(result.fiveHour.pct, 74);
  assert.equal(result.fiveHour.remainingPct, 26); // the value the user expected
  assert.equal(result.weekly.remainingPct, 75);
});

test("resolveQuota ignores a cached snapshot whose window has already reset", async () => {
  const now = new Date("2026-06-19T14:32:00.000Z");
  const result = await resolveQuota({
    now,
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    liveUsage: null,
    liveCache: {
      capturedAtMs: now.getTime() - 10 * 60_000,
      // 5h window reset 1 minute ago → snapshot is stale and must not be used
      five_hour: { utilization: 74, resets_at: new Date(now.getTime() - 60_000).toISOString() },
      seven_day: { utilization: 25, resets_at: new Date(now.getTime() + 4 * 86400_000).toISOString() },
    },
  });

  assert.equal(result.source, "estimate");
});

test("resolveQuota fast-path serves a very fresh cache without a network call", async () => {
  const now = new Date("2026-06-19T14:32:00.000Z");
  // liveUsage is omitted, so without the fast-path this would invoke the real
  // fetchLiveUsage() (a network call). The fresh cache (10s old, < 90s TTL)
  // must short-circuit and return immediately.
  const result = await resolveQuota({
    now,
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    liveCache: {
      capturedAtMs: now.getTime() - 10_000,
      five_hour: { utilization: 50, resets_at: new Date(now.getTime() + 60 * 60_000).toISOString() },
      seven_day: { utilization: 10, resets_at: new Date(now.getTime() + 6 * 86400_000).toISOString() },
    },
  });

  assert.equal(result.source, "live");
  assert.equal(result.cachedAtMs, now.getTime() - 10_000);
  assert.equal(result.fiveHour.remainingPct, 50);
});

test("resolveQuota force-refresh bypasses the fast-path cache", async () => {
  const now = new Date("2026-06-19T14:32:00.000Z");
  // With force=true and an injected failed fetch, the fresh cache is still used
  // as a fallback (step 2) rather than the fast-path — same value, but proves
  // force does not error and still yields the cached reading.
  const result = await resolveQuota({
    now,
    claudeConfig: { organizationRateLimitTier: "default_claude_ai" },
    queryDb: () => ({ total: 0 }),
    force: true,
    liveUsage: null,
    liveCache: {
      capturedAtMs: now.getTime() - 10_000,
      five_hour: { utilization: 50, resets_at: new Date(now.getTime() + 60 * 60_000).toISOString() },
      seven_day: { utilization: 10, resets_at: new Date(now.getTime() + 6 * 86400_000).toISOString() },
    },
  });

  assert.equal(result.source, "live");
  assert.equal(result.cachedAtMs, now.getTime() - 10_000);
});

test("writeLiveUsageCache + readLiveUsageCache round-trip", () => {
  const path = tmpCachePath();
  writeLiveUsageCache(
    {
      capturedAtMs: 1_700_000_000_000,
      five_hour: { utilization: 60, resets_at: "2026-06-19T20:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-06-24T20:00:00.000Z" },
    },
    path,
  );
  const back = readLiveUsageCache(path);
  assert.ok(back);
  assert.equal(back!.capturedAtMs, 1_700_000_000_000);
  assert.equal(back!.five_hour.utilization, 60);
  // sanity: it really wrote JSON
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
  rmSync(path, { force: true });
});
