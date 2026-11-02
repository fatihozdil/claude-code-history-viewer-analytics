import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRefresh, deferDelayMs, ANALYTICS_MIN_SILENT_GAP_MS, ANALYTICS_MAX_REUSE_MS,
  type BuildRecord,
} from "../src/services/analyticsRefreshGate.js";

const DAY = "Sat Oct 31 2026";
const last: BuildRecord = { version: "1:100", day: DAY, at: 1_000_000 };

function input(over: Partial<Parameters<typeof decideRefresh>[0]> = {}) {
  return {
    force: false,
    silent: true,
    now: last.at + 10_000,
    last,
    version: last.version,
    day: DAY,
    ...over,
  };
}

test("a forced refresh always builds, even with nothing changed", () => {
  assert.equal(decideRefresh(input({ force: true })), "build");
});

test("a non-silent refresh always builds", () => {
  assert.equal(decideRefresh(input({ silent: false })), "build");
});

test("a silent pass with no previous build builds, so an empty dashboard is never left behind", () => {
  assert.equal(decideRefresh(input({ last: undefined })), "build");
});

test("a silent pass skips when the data and the day are unchanged", () => {
  assert.equal(decideRefresh(input()), "skip");
});

test("a silent pass rebuilds once the reuse window has passed, even with no change", () => {
  assert.equal(
    decideRefresh(input({ now: last.at + ANALYTICS_MAX_REUSE_MS + 1 })),
    "build",
  );
});

test("a silent pass rebuilds when the calendar day changed, because the queries use date('now')", () => {
  assert.equal(
    decideRefresh(input({ day: "Sun Nov 01 2026", now: last.at + ANALYTICS_MIN_SILENT_GAP_MS })),
    "build",
  );
});

test("a day change inside the minimum gap is deferred, not rebuilt on every pass", () => {
  assert.equal(decideRefresh(input({ day: "Sun Nov 01 2026" })), "defer");
});

test("a silent pass after a data change is deferred inside the minimum gap", () => {
  assert.equal(decideRefresh(input({ version: "1:101", now: last.at + 5_000 })), "defer");
});

test("a silent pass after a data change builds once the minimum gap has passed", () => {
  assert.equal(
    decideRefresh(input({ version: "1:101", now: last.at + ANALYTICS_MIN_SILENT_GAP_MS })),
    "build",
  );
});

test("the deferred delay ends exactly at the minimum gap and never goes negative", () => {
  assert.equal(deferDelayMs(last, last.at + 5_000), ANALYTICS_MIN_SILENT_GAP_MS - 5_000);
  assert.equal(deferDelayMs(last, last.at + ANALYTICS_MIN_SILENT_GAP_MS + 1), 0);
});

test("the reuse window stays under the 5-minute poll so each poll tick still rebuilds the quota", () => {
  assert.ok(ANALYTICS_MAX_REUSE_MS < 5 * 60 * 1000);
});
