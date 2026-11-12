import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/services/ttlCache.js";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function counterReader<T>(values: T[]) {
  let calls = 0;
  const read = () => {
    const value = values[Math.min(calls, values.length - 1)];
    calls++;
    return Promise.resolve(value);
  };
  return { read, calls: () => calls };
}

test("repeated gets within the TTL read once", async () => {
  const c = clock();
  const cache = new TtlCache<string>(60_000, c.now);
  const r = counterReader(["a"]);
  assert.equal(await cache.get("k", r.read), "a");
  c.advance(59_000);
  assert.equal(await cache.get("k", r.read), "a");
  assert.equal(r.calls(), 1, "a status-bar repaint inside the TTL must not re-read");
});

test("a read after the TTL expires goes back to the source", async () => {
  const c = clock();
  const cache = new TtlCache<string>(60_000, c.now);
  const r = counterReader(["a", "b"]);
  assert.equal(await cache.get("k", r.read), "a");
  c.advance(60_000);
  assert.equal(await cache.get("k", r.read), "b");
  assert.equal(r.calls(), 2);
});

test("fresh bypasses a live cache entry and stores the new value", async () => {
  const c = clock();
  const cache = new TtlCache<string>(60_000, c.now);
  const r = counterReader(["a", "b", "c"]);
  assert.equal(await cache.get("k", r.read), "a");
  assert.equal(await cache.get("k", r.read, { fresh: true }), "b");
  assert.equal(await cache.get("k", r.read), "b", "the fresh reading becomes the cached one");
  assert.equal(r.calls(), 2);
});

test("keys are cached independently", async () => {
  const cache = new TtlCache<string>(60_000);
  const codex = counterReader(["codex-1"]);
  const agy = counterReader(["agy-1"]);
  assert.equal(await cache.get("/a/codex", codex.read), "codex-1");
  assert.equal(await cache.get("/b/agy", agy.read), "agy-1");
  assert.equal(await cache.get("/a/codex", codex.read), "codex-1");
  assert.equal(codex.calls(), 1);
  assert.equal(agy.calls(), 1);
});

test("concurrent callers share one in-flight read", async () => {
  const cache = new TtlCache<number>(60_000);
  let calls = 0;
  let release!: (v: number) => void;
  const read = () => { calls++; return new Promise<number>((res) => { release = res; }); };
  const a = cache.get("k", read);
  const b = cache.get("k", read);
  release(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(calls, 1);
});

test("a failed read is not cached, so the next call retries", async () => {
  const cache = new TtlCache<string>(60_000);
  let calls = 0;
  const read = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error("probe failed")) : Promise.resolve("ok");
  };
  await assert.rejects(cache.get("k", read), /probe failed/);
  assert.equal(await cache.get("k", read), "ok");
  assert.equal(calls, 2);
});

test("null readings are cached like any other value", async () => {
  const cache = new TtlCache<null | string>(60_000);
  const r = counterReader([null]);
  assert.equal(await cache.get("k", r.read), null);
  assert.equal(await cache.get("k", r.read), null);
  assert.equal(r.calls(), 1, "an absent provider should not be rescanned on every repaint");
});
