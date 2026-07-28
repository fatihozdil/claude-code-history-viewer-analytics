import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefireGate, MIN_REFIRE_MS } from "../src/watch/refireGate.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("MIN_REFIRE_MS is 5000", () => {
  assert.equal(MIN_REFIRE_MS, 5000);
});

test("a burst of events produces exactly one fire", async () => {
  let fireCount = 0;
  const gate = createRefireGate(() => fireCount++, 10, 200);
  for (let i = 0; i < 10; i++) {
    gate.trigger();
    await wait(2);
  }
  await wait(30);
  assert.equal(fireCount, 1);
  gate.dispose();
});

test("events during the suppression window produce exactly one trailing fire after it ends", async () => {
  let fireCount = 0;
  const gate = createRefireGate(() => fireCount++, 5, 60);
  gate.trigger();
  await wait(15); // first fire happens (debounce 5ms), suppression window (60ms) begins
  assert.equal(fireCount, 1);

  // Fire more events while still suppressed.
  gate.trigger();
  await wait(15);
  gate.trigger();
  await wait(15);
  // Still within the 60ms suppression window (started ~t=15).
  assert.equal(fireCount, 1, "no immediate fire while suppressed");

  // Wait past the suppression window end for the trailing fire.
  await wait(80);
  assert.equal(fireCount, 2, "exactly one trailing fire after suppression ends");

  // No further fires without new triggers.
  await wait(80);
  assert.equal(fireCount, 2);
  gate.dispose();
});

test("no events during suppression means no trailing fire", async () => {
  let fireCount = 0;
  const gate = createRefireGate(() => fireCount++, 5, 30);
  gate.trigger();
  await wait(60); // past debounce + suppression, no further triggers
  assert.equal(fireCount, 1);
  gate.dispose();
});

test("dispose cancels pending timers", async () => {
  let fireCount = 0;
  const gate = createRefireGate(() => fireCount++, 10, 100);
  gate.trigger();
  gate.dispose();
  await wait(30);
  assert.equal(fireCount, 0);
});
