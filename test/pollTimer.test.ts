import { test } from "node:test";
import assert from "node:assert/strict";
import { createPollTimer, ANALYTICS_REFRESH_MS } from "../src/services/pollTimer.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ANALYTICS_REFRESH_MS matches the quota status bar's 5-minute cadence", () => {
  assert.equal(ANALYTICS_REFRESH_MS, 5 * 60 * 1000);
});

test("ticks repeatedly on the interval", async () => {
  let ticks = 0;
  const timer = createPollTimer(() => ticks++, 20);
  await wait(70);
  assert.ok(ticks >= 2, `expected at least 2 ticks, got ${ticks}`);
  timer.dispose();
});

test("does not tick before the first interval elapses", async () => {
  let ticks = 0;
  const timer = createPollTimer(() => ticks++, 100);
  await wait(30);
  assert.equal(ticks, 0, "must not fire immediately on creation");
  timer.dispose();
});

test("dispose stops all further ticks", async () => {
  let ticks = 0;
  const timer = createPollTimer(() => ticks++, 20);
  await wait(50);
  const atDispose = ticks;
  timer.dispose();
  await wait(80);
  assert.equal(ticks, atDispose, "no ticks after dispose");
});

test("dispose is idempotent", async () => {
  const timer = createPollTimer(() => {}, 20);
  timer.dispose();
  timer.dispose();
  await wait(50);
});

test("a throwing callback does not stop later ticks", async () => {
  let ticks = 0;
  const timer = createPollTimer(() => {
    ticks++;
    throw new Error("boom");
  }, 20);
  await wait(70);
  assert.ok(ticks >= 2, `a throwing tick must not kill the timer, got ${ticks}`);
  timer.dispose();
});
