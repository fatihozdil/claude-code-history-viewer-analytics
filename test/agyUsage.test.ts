import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgyServers, parseListeningPorts, readAgyUsage, quotaGroupsFromSummary } from "../src/agy/usage.js";

test("reads model quotaInfo from Antigravity monitor state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-"));
  try {
    await fs.writeFile(path.join(root, "monitor-state.json"), JSON.stringify({
      models: {
        pro: { label: "Gemini Pro", quotaInfo: { remainingFraction: 0.72, resetTime: "2026-07-12T12:00:00Z" } },
        flash: { label: "Gemini Flash", quotaInfo: { remainingFraction: "0.45" } },
      },
    }));
    const usage = await readAgyUsage(root, { live: false });
    assert.equal(usage?.remainingPct, 45);
    assert.deepEqual(usage?.limits, [
      { label: "Gemini Flash", remainingPct: 45 },
      { label: "Gemini Pro", remainingPct: 72, resetsAt: "2026-07-12T12:00:00Z" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parses grouped weekly/5-hour buckets from RetrieveUserQuotaSummary", () => {
  const groups = quotaGroupsFromSummary({
    response: {
      groups: [
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            { displayName: "Weekly Limit", window: "weekly", remainingFraction: 1, resetTime: "2026-07-19T21:45:06Z" },
            { displayName: "Five Hour Limit", window: "5h", remainingFraction: 1, resetTime: "2026-07-13T02:45:06Z" },
          ],
        },
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            { displayName: "Weekly Limit", window: "weekly", remainingFraction: 0.9088674, resetTime: "2026-07-15T18:11:44Z" },
            { displayName: "Five Hour Limit", window: "5h", remainingFraction: 1, resetTime: "2026-07-13T02:45:06Z" },
          ],
        },
      ],
    },
  });
  // Most-constrained group (Gemini, 91%) sorts first; models list is extracted.
  assert.deepEqual(groups, [
    {
      name: "Gemini Models",
      models: "Gemini Flash, Gemini Pro",
      buckets: [
        { label: "Weekly Limit", window: "weekly", remainingPct: 91, resetsAt: "2026-07-15T18:11:44Z" },
        { label: "Five Hour Limit", window: "5h", remainingPct: 100, resetsAt: "2026-07-13T02:45:06Z" },
      ],
    },
    {
      name: "Claude and GPT models",
      models: "Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        { label: "Weekly Limit", window: "weekly", remainingPct: 100, resetsAt: "2026-07-19T21:45:06Z" },
        { label: "Five Hour Limit", window: "5h", remainingPct: 100, resetsAt: "2026-07-13T02:45:06Z" },
      ],
    },
  ]);
});

test("round-trips grouped buckets through the usage cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-groups-"));
  try {
    await fs.mkdir(path.join(root, "cache"));
    await fs.writeFile(path.join(root, "cache", "claude-history-usage.json"), JSON.stringify({
      version: 1,
      capturedAt: "2026-07-12T18:00:00Z",
      limits: [{ label: "Gemini Models · Weekly Limit", remainingPct: 91, resetsAt: "2026-07-15T18:11:44Z" }],
      groups: [{
        name: "Gemini Models",
        models: "Gemini Flash, Gemini Pro",
        buckets: [
          { label: "Weekly Limit", window: "weekly", remainingPct: 91, resetsAt: "2026-07-15T18:11:44Z" },
          { label: "Five Hour Limit", window: "5h", remainingPct: 100, resetsAt: "2026-07-13T02:45:06Z" },
        ],
      }],
    }));
    const usage = await readAgyUsage(root, { live: false });
    assert.equal(usage?.source, "cache");
    assert.deepEqual(usage?.groups, [{
      name: "Gemini Models",
      models: "Gemini Flash, Gemini Pro",
      buckets: [
        { label: "Weekly Limit", window: "weekly", remainingPct: 91, resetsAt: "2026-07-15T18:11:44Z" },
        { label: "Five Hour Limit", window: "5h", remainingPct: 100, resetsAt: "2026-07-13T02:45:06Z" },
      ],
    }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discovers IDE and AGY CLI quota servers", () => {
  const servers = parseAgyServers([
    "  120 /Applications/Antigravity.app/language_server_macos_arm --csrf_token token-123 --extension_server_port 4100",
    "  240 /Users/me/.local/bin/agy --continue",
    "  360 rg agy",
  ].join("\n"));
  assert.deepEqual(servers, [
    { pid: "120", csrfToken: "token-123", portHint: 4100 },
    { pid: "240", csrfToken: "" },
  ]);
});

test("extracts unique loopback listening ports", () => {
  assert.deepEqual(parseListeningPorts([
    "agy 240 me 12u IPv4 TCP 127.0.0.1:53120 (LISTEN)",
    "agy 240 me 13u IPv6 TCP [::1]:53121 (LISTEN)",
    "agy 240 me 14u IPv4 TCP 127.0.0.1:53120 (LISTEN)",
  ].join("\n")), [53120, 53121]);
});

test("falls back to the last successful live quota cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-usage-cache-"));
  try {
    await fs.mkdir(path.join(root, "cache"));
    await fs.writeFile(path.join(root, "cache", "claude-history-usage.json"), JSON.stringify({
      version: 1,
      capturedAt: "2026-07-12T18:00:00Z",
      limits: [{ label: "Gemini 3.1 Pro", remainingPct: 64, resetsAt: "2026-07-12T22:00:00Z" }],
    }));
    const usage = await readAgyUsage(root, { live: false });
    assert.equal(usage?.source, "cache");
    assert.equal(usage?.capturedAt, "2026-07-12T18:00:00Z");
    assert.deepEqual(usage?.limits, [
      { label: "Gemini 3.1 Pro", remainingPct: 64, resetsAt: "2026-07-12T22:00:00Z" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
