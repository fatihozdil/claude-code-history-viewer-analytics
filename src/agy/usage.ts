import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";

export interface AgyUsageLimit {
  label: string;
  remainingPct: number;
  resetsAt?: string;
}

/** A single window within a model group (e.g. "Weekly Limit", "Five Hour Limit"). */
export interface AgyUsageBucket {
  label: string;
  /** Raw window key from the API ("weekly", "5h"), when present. */
  window?: string;
  remainingPct: number;
  resetsAt?: string;
}

/** A model group as Antigravity presents it, with its per-window buckets. */
export interface AgyUsageGroup {
  name: string;
  /** Human list of member models ("Gemini Flash, Gemini Pro"), when known. */
  models?: string;
  buckets: AgyUsageBucket[];
}

export interface AgyUsage {
  remainingPct: number;
  resetsAt?: string;
  sourcePath: string;
  limits?: AgyUsageLimit[];
  /** Grouped weekly/5-hour windows from RetrieveUserQuotaSummary, when available. */
  groups?: AgyUsageGroup[];
  source?: "live" | "cache" | "file";
  capturedAt?: string;
}

const execFileAsync = promisify(execFile);
const USAGE_CACHE_NAME = "claude-history-usage.json";

interface AgyServer {
  pid: string;
  csrfToken: string;
  portHint?: number;
}

export interface ReadAgyUsageOptions {
  /** Tests and callers reading only exported state can disable process probing. */
  live?: boolean;
}

/** Read Antigravity's quota snapshots from monitor state and RPC cache. */
export async function readAgyUsage(agyDir: string, options: ReadAgyUsageOptions = {}): Promise<AgyUsage | null> {
  if (options.live !== false) {
    const live = await readLiveAgyUsage();
    if (live) {
      await writeUsageCache(agyDir, live);
      return live;
    }
  }
  // Antigravity has used both `antigravity` and `antigravity-cli` roots. The
  // monitor-state files sit at the root; RPC exports are a fallback only.
  const roots = [...new Set([
    agyDir,
    path.join(path.dirname(agyDir), "antigravity"),
    ...await discoverExternalMonitorRoots(),
  ])];
  const candidates: Array<AgyUsage & { label: string }> = [];
  for (const root of roots) {
    const stateFiles = await monitorStateFiles(root);
    const rpcRoot = path.join(root, ".token-monitor", "rpc-cache", "v1");
    let rpcFiles: string[] = [];
    try { rpcFiles = await walkJsonFiles(rpcRoot); } catch { /* no RPC export yet */ }
    for (const file of [...stateFiles, ...rpcFiles]) {
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        for (const candidate of findUsages(value)) candidates.push({ ...candidate, sourcePath: file });
      } catch { /* tolerate active/partial cache writes */ }
    }
  }
  if (candidates.length === 0) return readUsageCache(agyDir);
  const byLabel = new Map<string, AgyUsage & { label: string }>();
  for (const candidate of candidates) {
    const previous = byLabel.get(candidate.label);
    // Prefer the lowest remaining value for a model while a window is active.
    if (!previous || candidate.remainingPct < previous.remainingPct) byLabel.set(candidate.label, candidate);
  }
  const limits = [...byLabel.values()].sort((a, b) => a.remainingPct - b.remainingPct);
  const primary = limits[0];
  return {
    remainingPct: primary.remainingPct,
    ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
    sourcePath: primary.sourcePath,
    source: "file",
    limits: limits.map(({ label, remainingPct, resetsAt }) => ({ label, remainingPct, ...(resetsAt ? { resetsAt } : {}) })),
  };
}

/**
 * Antigravity's active language server exposes the authoritative quota state
 * on localhost. Prefer it over exported monitor files, which only contain
 * session-token history and may not include current limits.
 */
async function readLiveAgyUsage(): Promise<AgyUsage | null> {
  if (process.platform === "win32") return null;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["ax", "-o", "pid=,command="], { maxBuffer: 2 * 1024 * 1024 }));
  } catch { return null; }
  for (const server of parseAgyServers(stdout)) {
    const ports = new Set<number>();
    if (server.portHint) ports.add(server.portHint);
    try {
      const { stdout: lsofOutput } = await execFileAsync(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", server.pid],
        { maxBuffer: 512 * 1024 },
      );
      for (const port of parseListeningPorts(lsofOutput)) ports.add(port);
    } catch { /* the process may have exited, or lsof may be unavailable */ }
    for (const port of ports) {
      // Prefer RetrieveUserQuotaSummary: it returns the same grouped weekly /
      // 5-hour buckets the Antigravity CLI shows. GetUserStatus only exposes a
      // single per-model window, so it is a fallback.
      const summary = await callAgyRpc(port, server.csrfToken, "RetrieveUserQuotaSummary");
      const groups = quotaGroupsFromSummary(summary);
      if (groups.length > 0) {
        const limits = limitsFromGroups(groups);
        const primary = limits[0];
        return {
          remainingPct: primary.remainingPct,
          ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
          sourcePath: "Antigravity local quota server",
          source: "live",
          capturedAt: new Date().toISOString(),
          groups,
          limits,
        };
      }
      const payload = await callAgyRpc(port, server.csrfToken, "GetUserStatus");
      const limits = quotaLimitsFromStatus(payload);
      if (limits.length === 0) continue;
      const primary = limits[0];
      return {
        remainingPct: primary.remainingPct,
        ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
        sourcePath: "Antigravity local quota server",
        source: "live",
        capturedAt: new Date().toISOString(),
        limits,
      };
    }
  }
  return null;
}

/** Discover both the IDE language server and the newer AGY CLI quota server. */
export function parseAgyServers(psOutput: string): AgyServer[] {
  const servers: AgyServer[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const process = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!process) continue;
    const [, pid, command] = process;
    const isLanguageServer = command.includes("language_server_") && command.includes("--csrf_token");
    const isAgyCli = /^(?:\S+\/)?agy(?:\s|$)/.test(command);
    if (!isLanguageServer && !isAgyCli) continue;
    const csrfToken = /--csrf_token(?:=|\s+)([a-z0-9-]+)/i.exec(command)?.[1] ?? "";
    if (isLanguageServer && !csrfToken) continue;
    const port = /--extension_server_port(?:=|\s+)(\d+)/.exec(command)?.[1];
    servers.push({ pid, csrfToken, ...(port ? { portHint: Number(port) } : {}) });
  }
  return servers;
}

export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) continue;
    const match = /(?:127\.0\.0\.1|localhost|\*|\[::1\]):(\d+)\b/.exec(line);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

async function callAgyRpc(port: number, csrfToken: string, method: string): Promise<unknown> {
  // AGY accepts an empty Connect request; the IDE server additionally checks
  // the CSRF header. Current AGY builds serve TLS, older IDE builds use HTTP.
  const secure = await requestAgyRpc(https, port, csrfToken, true, method);
  if (secure) return secure;
  return requestAgyRpc(http, port, csrfToken, false, method);
}

function requestAgyRpc(
  transport: typeof http | typeof https,
  port: number,
  csrfToken: string,
  secure: boolean,
  method: string,
): Promise<unknown> {
  const body = "{}";
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Connect-Protocol-Version": "1",
    };
    if (csrfToken) headers["X-Codeium-Csrf-Token"] = csrfToken;
    const req = transport.request({
      host: "127.0.0.1", port, method: "POST",
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      headers,
      ...(secure ? { rejectUnauthorized: false } : {}),
      timeout: 2_500,
    }, (res) => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { response += chunk; });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
        try { resolve(JSON.parse(response)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function quotaLimitsFromStatus(value: unknown): AgyUsageLimit[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const status = root.userStatus && typeof root.userStatus === "object" ? root.userStatus as Record<string, unknown> : root;
  const cascade = status.cascadeModelConfigData;
  if (!cascade || typeof cascade !== "object") return [];
  const configs = (cascade as Record<string, unknown>).clientModelConfigs;
  if (!Array.isArray(configs)) return [];
  return configs.flatMap((config) => {
    if (!config || typeof config !== "object") return [];
    const row = config as Record<string, unknown>;
    const quota = row.quotaInfo;
    if (!quota || typeof quota !== "object") return [];
    const remainingFraction = firstNumber(quota as Record<string, unknown>, ["remainingFraction"]);
    if (remainingFraction === undefined) return [];
    const label = firstString(row, ["label", "displayName", "model", "name"]) ?? "Antigravity model";
    const resetsAt = firstString(quota as Record<string, unknown>, ["resetTime", "reset_time"]);
    return [{ label, remainingPct: Math.round(Math.max(0, Math.min(1, remainingFraction)) * 100), ...(resetsAt ? { resetsAt } : {}) }];
  }).sort((a, b) => a.remainingPct - b.remainingPct);
}

/**
 * Parse RetrieveUserQuotaSummary into model groups with their weekly / 5-hour
 * buckets. Shape: `{ response: { groups: [{ displayName, description, buckets:
 * [{ displayName, window, remainingFraction, resetTime }] }] } }`.
 */
export function quotaGroupsFromSummary(value: unknown): AgyUsageGroup[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const response = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : root;
  const groups = response.groups;
  if (!Array.isArray(groups)) return [];
  const parsed: AgyUsageGroup[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const row = group as Record<string, unknown>;
    const rawBuckets = Array.isArray(row.buckets) ? row.buckets : [];
    const buckets: AgyUsageBucket[] = [];
    for (const bucket of rawBuckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const b = bucket as Record<string, unknown>;
      const fraction = firstNumber(b, ["remainingFraction", "remaining_fraction"]);
      if (fraction === undefined) continue;
      const label = firstString(b, ["displayName", "display_name"]) ?? firstString(b, ["window"]) ?? "Limit";
      const window = firstString(b, ["window"]);
      const resetsAt = firstString(b, ["resetTime", "reset_time"]);
      buckets.push({
        label,
        ...(window ? { window } : {}),
        remainingPct: Math.round(Math.max(0, Math.min(1, fraction)) * 100),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
    if (buckets.length === 0) continue;
    const name = firstString(row, ["displayName", "display_name"]) ?? "Antigravity models";
    const models = modelsFromDescription(firstString(row, ["description"]));
    parsed.push({ name, ...(models ? { models } : {}), buckets });
  }
  // Most-constrained group first.
  return parsed.sort((a, b) => minBucket(a) - minBucket(b));
}

/** Extract "Gemini Flash, Gemini Pro" from "Models within this group: Gemini Flash, Gemini Pro". */
function modelsFromDescription(description?: string): string | undefined {
  if (!description) return undefined;
  const match = /group:\s*(.+)$/i.exec(description.trim());
  return match ? match[1].trim() : undefined;
}

function minBucket(group: AgyUsageGroup): number {
  return group.buckets.reduce((min, b) => Math.min(min, b.remainingPct), 100);
}

/** Flatten groups into the legacy flat `limits[]` (drives the status bar %). */
function limitsFromGroups(groups: AgyUsageGroup[]): AgyUsageLimit[] {
  const limits: AgyUsageLimit[] = [];
  for (const group of groups) {
    for (const bucket of group.buckets) {
      limits.push({ label: `${group.name} · ${bucket.label}`, remainingPct: bucket.remainingPct, ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}) });
    }
  }
  return limits.sort((a, b) => a.remainingPct - b.remainingPct);
}

async function writeUsageCache(agyDir: string, usage: AgyUsage): Promise<void> {
  const cachePath = path.join(agyDir, "cache", USAGE_CACHE_NAME);
  const value = {
    version: 1,
    capturedAt: usage.capturedAt ?? new Date().toISOString(),
    limits: usage.limits ?? [{
      label: "Antigravity plan",
      remainingPct: usage.remainingPct,
      ...(usage.resetsAt ? { resetsAt: usage.resetsAt } : {}),
    }],
    ...(usage.groups ? { groups: usage.groups } : {}),
  };
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(value), "utf8");
  } catch { /* live data is still usable when the cache directory is read-only */ }
}

async function readUsageCache(agyDir: string): Promise<AgyUsage | null> {
  const cachePath = path.join(agyDir, "cache", USAGE_CACHE_NAME);
  try {
    const value = JSON.parse(await fs.readFile(cachePath, "utf8")) as Record<string, unknown>;
    if (!Array.isArray(value.limits)) return null;
    const limits = value.limits.flatMap((item): AgyUsageLimit[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const label = firstString(row, ["label"]);
      const remainingPct = firstNumber(row, ["remainingPct"]);
      const resetsAt = firstString(row, ["resetsAt"]);
      if (!label || remainingPct === undefined || remainingPct < 0 || remainingPct > 100) return [];
      return [{ label, remainingPct, ...(resetsAt ? { resetsAt } : {}) }];
    }).sort((a, b) => a.remainingPct - b.remainingPct);
    if (limits.length === 0) return null;
    const primary = limits[0];
    const capturedAt = firstString(value, ["capturedAt"]);
    const groups = groupsFromCache(value.groups);
    return {
      remainingPct: primary.remainingPct,
      ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
      sourcePath: cachePath,
      source: "cache",
      ...(capturedAt ? { capturedAt } : {}),
      ...(groups.length ? { groups } : {}),
      limits,
    };
  } catch { return null; }
}

/** Rebuild grouped buckets persisted in the cache (best-effort; ignores malformed entries). */
function groupsFromCache(raw: unknown): AgyUsageGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: AgyUsageGroup[] = [];
  for (const group of raw) {
    if (!group || typeof group !== "object") continue;
    const row = group as Record<string, unknown>;
    const name = firstString(row, ["name"]);
    if (!name || !Array.isArray(row.buckets)) continue;
    const buckets: AgyUsageBucket[] = [];
    for (const bucket of row.buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const b = bucket as Record<string, unknown>;
      const label = firstString(b, ["label"]);
      const remainingPct = firstNumber(b, ["remainingPct"]);
      if (!label || remainingPct === undefined || remainingPct < 0 || remainingPct > 100) continue;
      const window = firstString(b, ["window"]);
      const resetsAt = firstString(b, ["resetsAt"]);
      buckets.push({ label, ...(window ? { window } : {}), remainingPct, ...(resetsAt ? { resetsAt } : {}) });
    }
    if (buckets.length === 0) continue;
    const models = firstString(row, ["models"]);
    groups.push({ name, ...(models ? { models } : {}), buckets });
  }
  return groups;
}

/** Match Antigravity's external VS Code storage layout when it is not in ~/.gemini. */
async function discoverExternalMonitorRoots(): Promise<string[]> {
  const globalStorage = path.join(os.homedir(), "Library", "Application Support");
  let apps: Dirent[];
  try { apps = await fs.readdir(globalStorage, { withFileTypes: true }); } catch { return []; }
  const roots: string[] = [];
  for (const app of apps) {
    if (!app.isDirectory()) continue;
    const storageRoot = path.join(globalStorage, app.name, "User", "globalStorage");
    let entries: Dirent[];
    try { entries = await fs.readdir(storageRoot, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(storageRoot, entry.name);
      try {
        await fs.access(path.join(candidate, "monitor-state.json"));
        roots.push(candidate);
      } catch { /* not an Antigravity token-monitor storage directory */ }
    }
  }
  return roots;
}

async function monitorStateFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^monitor-state(?:\.archive-[^.]+)?\.json$/i.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  } catch { return []; }
}

interface AgyCandidate extends Omit<AgyUsage, "sourcePath" | "limits"> { label: string }

function findUsages(value: unknown, label = "Antigravity plan"): AgyCandidate[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const candidateLabel = firstString(row, ["displayName", "display_name", "label", "model", "name"]) ?? label;
  const quota = row.quotaInfo && typeof row.quotaInfo === "object" ? row.quotaInfo as Record<string, unknown> : row;
  const fraction = firstNumber(quota, ["remainingFraction", "remaining_fraction"]);
  const remaining = fraction !== undefined ? fraction * 100 : firstNumber(quota, ["remainingPct", "remaining_percent", "remainingPercentage", "percentRemaining"]);
  const utilization = firstNumber(quota, ["utilization", "utilizationPct", "usedPct", "percentUsed"]);
  const pct = remaining ?? (utilization !== undefined ? 100 - utilization : undefined);
  const reset = firstString(quota, ["resetTime", "reset_time", "resets_at", "reset_at", "resetAt"]);
  const found: AgyCandidate[] = pct !== undefined && pct >= 0 && pct <= 100
    ? [{ label: candidateLabel, remainingPct: Math.round(pct), ...(reset ? { resetsAt: reset } : {}) }]
    : [];
  for (const child of Object.values(row)) found.push(...findUsages(child, candidateLabel));
  return found;
}

/*
 * `usage.jsonl` contains token events rather than quota, while monitor state
 * contains model quotaInfo. JSON-only recursion intentionally skips JSONL.
 */
async function walkJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkJsonFiles(file));
    else if (entry.isFile() && /\.json$/.test(entry.name)) out.push(file);
  }
  return out;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}
function firstString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof row[key] === "string" && row[key].trim()) return row[key] as string;
  return undefined;
}
